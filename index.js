import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION === "false" ? false : (process.env.MC_VERSION || false);
const MC_PASSWORD = process.env.MC_PASSWORD;
const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);
const STARTUP_SCAN_DELAY_MS = Number(process.env.STARTUP_SCAN_DELAY_MS || 8000);
const TAB_WARMUP_RETRIES = Number(process.env.TAB_WARMUP_RETRIES || 4);
const TAB_WARMUP_DELAY_MS = Number(process.env.TAB_WARMUP_DELAY_MS || 2000);
const DEBUG_MODE = (process.env.DEBUG_MODE || "0") === "1";
const GEMINI_KEY = process.env.GEMINI_KEY;

console.log("[INIT] Environment variables loaded");
console.log("[INIT] BOT_TOKEN:", BOT_TOKEN ? "✓" : "✗");
console.log("[INIT] MC_HOST:", MC_HOST || "✗");
console.log("[INIT] MC_USER:", MC_USER || "✗");
console.log("[INIT] CHAT_ID:", CHAT_ID || "✗");

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  console.error("[FATAL] Missing: BOT_TOKEN, MC_HOST, or MC_USER");
  process.exit(1);
}

/* ================== DEBUG ================== */
function debugLog(msg, data = null) {
  if (DEBUG_MODE) {
    console.log(`[DEBUG] ${msg}`, data || "");
  }
}

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => {
  console.error("[TG ERROR]", err?.message || err);
});

async function launchTelegramSafely() {
  let attempts = 0;
  while (true) {
    try {
      attempts++;
      console.log(`[TG] Launch attempt ${attempts}...`);
      await tg.launch({
        dropPendingUpdates: true,
        allowedUpdates: [],
      });
      console.log("[TG] ✓ Launched successfully");
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("[TG] Launch failed:", msg);

      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("[TG] 409 conflict, waiting 15s...");
        await sleep(15000);
        continue;
      }

      console.log("[TG] Retrying in 5s...");
      await sleep(5000);
    }
  }
}

function sendToTelegram(text, opts = {}) {
  if (!CHAT_ID) return;
  try {
    tg.telegram.sendMessage(CHAT_ID, text, {
      parse_mode: "HTML",
      ...opts,
    }).catch(e => console.error("[TG SEND]", e?.message));
  } catch (e) {
    console.error("[TG SEND ERROR]", e?.message);
  }
}

/* ================== GEMINI ================== */
let geminiClient = null;
if (GEMINI_KEY) {
  try {
    geminiClient = new GoogleGenerativeAI(GEMINI_KEY);
    console.log("[GEMINI] ✓ Initialized");
  } catch (e) {
    console.error("[GEMINI] Init failed:", e?.message);
  }
}

async function checkNickWithAI(nick) {
  if (!geminiClient) return null;
  try {
    const model = geminiClient.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Analyze if this Minecraft nickname contains banned content (profanity, cheats, racism, extremism, drugs, body/sex references, insults, impersonation): "${nick}". Respond with JSON: {"suspicious": boolean, "reason": "text"}`;
    
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    try {
      return JSON.parse(response);
    } catch {
      return { suspicious: false, reason: "parse_error" };
    }
  } catch (e) {
    debugLog("GEMINI check error:", e?.message);
    return null;
  }
}

/* ================== RULES ================== */
let RULES = {};
function loadRules() {
  try {
    RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
    console.log("[RULES] ✓ Loaded");
  } catch (e) {
    console.error("[RULES] Load failed:", e?.message);
    RULES = { rules: [], review: [] };
  }
}

function reloadRules() {
  loadRules();
}

/* ================== NORMALIZE ================== */
function norm(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/§./g, "")
    .replace(/[\s\-_.:,;|/\\~`'"^*+=()[\]{}<>]/g, "");
}

/* ================== CHECK ================== */
function checkNick(name) {
  const n = norm(name);

  for (const rule of RULES.rules || []) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;
    for (const w of rule.words || []) {
      if (n.includes(norm(w))) {
        return ["BAN", [`${rule.reason || rule.id}:${w}`]];
      }
    }
  }

  for (const w of RULES.review || []) {
    if (n.includes(norm(w))) {
      return ["REVIEW", [`review:${w}`]];
    }
  }

  return ["OK", []];
}

/* ================== SRV ================== */
async function resolveMcEndpoint(host, port) {
  const h = String(host || "").trim();
  try {
    const srv = await resolveSrv(`_minecraft._tcp.${h}`);
    if (srv?.length) {
      srv.sort((a, b) => a.priority - b.priority);
      return { host: srv[0].name, port: srv[0].port, via: "SRV" };
    }
  } catch {}
  return { host: h, port: Number(port || 25565), via: "DIRECT" };
}

/* ================== MC STATE ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let reconnectTimer = null;
let connecting = false;
let lastTabCompleteTime = 0;
let lastAutoScanTime = 0;
let tabCompleteQueue = [];
let isProcessingQueue = false;
let loginAttempted = false;
let heartbeatTimer = null;
let lastHeartbeat = Date.now();
let tabCompleteFailures = 0;
const pendingTimers = new Set();
const pendingListeners = [];

function addTimer(timer) {
  pendingTimers.add(timer);
}

function clearAllTimers() {
  for (const timer of pendingTimers) {
    try { clearTimeout(timer); clearInterval(timer); } catch {}
  }
  pendingTimers.clear();
}

function addListener(obj, event, handler) {
  pendingListeners.push({ obj, event, handler });
}

function clearAllListeners() {
  for (const { obj, event, handler } of pendingListeners) {
    try { obj.removeListener(event, handler); } catch {}
  }
  pendingListeners.length = 0;
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  console.log("[MC] Reconnect scheduled:", reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, 5000);
  addTimer(reconnectTimer);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    lastHeartbeat = Date.now();
    if (mcOnline && (!mcReady || !tabReady)) {
      console.log("[HEARTBEAT] Online but not ready, reconnecting...");
      scheduleReconnect("heartbeat_not_ready");
    }
  }, 15000);
  addTimer(heartbeatTimer);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) {
      tabCompleteFailures++;
      rej(new Error("CLIENT_NOT_READY"));
      return;
    }

    const c = bot._client;
    const timeout = setTimeout(() => {
      cleanup();
      tabCompleteFailures++;
      rej(new Error("TAB_TIMEOUT"));
    }, 5000);

    const on = (p) => {
      cleanup();
      tabCompleteFailures = 0;
      const matches = p?.matches?.map((x) => typeof x === "string" ? x : x.text || x.match || "") || [];
      res(matches);
    };

    function cleanup() {
      clearTimeout(timeout);
      try { c.removeListener("tab_complete", on); } catch {}
      try { c.removeListener("tab_complete_response", on); } catch {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);
      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 },
      });
    } catch (e) {
      cleanup();
      tabCompleteFailures++;
      rej(e);
    }
  });
}

async function processTabCompleteQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (tabCompleteQueue.length > 0) {
      const { prefix, resolve, reject } = tabCompleteQueue.shift();
      try {
        if (!mcReady || !tabReady) throw new Error("MC_NOT_READY");
        const raw = await tabComplete(mc, `/msg ${prefix}`);
        resolve(raw);
        lastTabCompleteTime = Date.now();
      } catch (e) {
        reject(e);
      }
      await sleep(SCAN_DELAY_MS);
    }
  } finally {
    isProcessingQueue = false;
  }
}

async function byPrefix(prefix) {
  if (!mcReady || !tabReady) throw new Error("MC_NOT_READY");
  
  return new Promise((resolve, reject) => {
    tabCompleteQueue.push({ 
      prefix, 
      resolve: (raw) => {
        const clean = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "");
        resolve([...new Set(raw.map(clean).filter((x) => x.length >= 3 && x.length <= 16))]);
      },
      reject 
    });
    processTabCompleteQueue();
  });
}

async function warmupTabReady(bot) {
  for (let i = 1; i <= TAB_WARMUP_RETRIES; i++) {
    try {
      const r = await tabComplete(bot, "/msg a");
      if (Array.isArray(r)) {
        tabReady = true;
        mcReady = true;
        loginAttempted = false;
        lastTabCompleteTime = Date.now();
        console.log(`[MC] TAB ready on try ${i}`);
        return true;
      }
    } catch (e) {
      console.log(`[MC] TAB warmup fail ${i}:`, e?.message);
      await sleep(TAB_WARMUP_DELAY_MS);
    }
  }
  tabCompleteFailures++;
  return false;
}

async function connectMC() {
  if (connecting) {
    debugLog("Connect already in progress");
    return;
  }
  connecting = true;

  try {
    if (mc) {
      try { mc.quit("reconnect"); } catch {}
      try { mc.end(); } catch {}
      clearAllListeners();
      mc = null;
    }

    mcReady = false;
    tabReady = false;
    mcOnline = false;
    loginAttempted = false;
    tabCompleteFailures = 0;

    const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);
    console.log("[MC] Connecting to", ep.host + ":" + ep.port, "(" + ep.via + ")");

    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      version: MC_VERSION,
      auth: "offline",
      hideErrors: false,
      checkTimeoutInterval: 30000,
      viewDistance: "tiny",
      skipValidation: true,
    });

    const loginHandler = () => {
      mcOnline = true;
      console.log("[MC] ✓ Login");
      startHeartbeat();
    };

    const spawnHandler = async () => {
      console.log("[MC] ✓ Spawn");
      await sleep(READY_AFTER_MS);
      const ok = await warmupTabReady(mc);
      if (!ok) {
        console.log("[MC] TAB failed after spawn");
        scheduleReconnect("tab_failed_spawn");
      } else {
        console.log("[MC] ✓ READY");
        lastAutoScanTime = Date.now();
      }
    };

    const messageHandler = (msg) => {
      const m = String(msg).toLowerCase();
      if (MC_PASSWORD && m.includes("login") && !loginAttempted) {
        loginAttempted = true;
        const t = setTimeout(() => {
          try { mc.chat(`/login ${MC_PASSWORD}`); } catch {}
        }, 1500);
        addTimer(t);
      }
      if (MC_PASSWORD && m.includes("register") && !loginAttempted) {
        loginAttempted = true;
        const t = setTimeout(() => {
          try { mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`); } catch {}
        }, 1500);
        addTimer(t);
      }
      if (m.includes("antibot") || m.includes("limbo")) {
        console.log("[MC] Detected antibot/limbo");
        scheduleReconnect("antibot_limbo");
      }
    };

    const kickedHandler = (r) => {
      console.log("[MC] Kicked:", r);
      scheduleReconnect("kicked");
    };

    const endHandler = () => {
      console.log("[MC] Disconnected");
      stopHeartbeat();
      scheduleReconnect("end");
    };

    const errorHandler = (e) => {
      console.error("[MC ERROR]", e?.message || e);
      if (String(e?.message).includes("ECONNREFUSED") || String(e?.message).includes("ETIMEDOUT")) {
        scheduleReconnect("connection_error");
      }
    };

    mc.on("login", loginHandler);
    mc.on("spawn", spawnHandler);
    mc.on("messagestr", messageHandler);
    mc.on("kicked", kickedHandler);
    mc.on("end", endHandler);
    mc.on("error", errorHandler);
    addListener(mc, "login", loginHandler);
    addListener(mc, "spawn", spawnHandler);
    addListener(mc, "messagestr", messageHandler);
    addListener(mc, "kicked", kickedHandler);
    addListener(mc, "end", endHandler);
    addListener(mc, "error", errorHandler);

  } catch (e) {
    console.error("[MC CONNECT ERROR]", e?.message || e);
    stopHeartbeat();
    scheduleReconnect("connect_error");
  } finally {
    connecting = false;
  }
}

/* ================== AUTO SCAN ================== */
async function performAutoScan() {
  if (!AUTO_SCAN || !mcReady || !tabReady) return;

  try {
    console.log("[AUTO SCAN] Starting");
    const prefixes = AUTO_PREFIXES ? AUTO_PREFIXES.split(",").map(p => p.trim()).filter(p => p) : ["a", "b", "c"];
    const allNicks = [];

    for (const prefix of prefixes) {
      try {
        const names = await byPrefix(prefix);
        allNicks.push(...names);
        debugLog(`Prefix ${prefix}:`, names.length);
      } catch (e) {
        console.error(`[AUTO SCAN] Prefix ${prefix}:`, e?.message);
      }
      await sleep(SCAN_DELAY_MS);
    }

    const unique = [...new Set(allNicks)];
    let banCount = 0, reviewCount = 0, results = [];

    for (const nick of unique) {
      const [status, reasons] = checkNick(nick);
      if (status === "BAN") {
        banCount++;
        results.push({ nick, status, reasons });
      } else if (status === "REVIEW") {
        reviewCount++;
        results.push({ nick, status, reasons });
        if (geminiClient) {
          const aiResult = await checkNickWithAI(nick);
          if (aiResult?.suspicious) {
            results[results.length - 1].aiReason = aiResult.reason;
          }
        }
      }
    }

    const html = [`<b>🔎 Auto Scan Report</b>`, `Scanned: ${unique.length}`, `Ban: ${banCount}`, `Review: ${reviewCount}`, ``];
    if (banCount > 0) {
      html.push(`<b>🚫 BAN LIST:</b>`);
      for (const { nick, reasons } of results.filter(r => r.status === "BAN")) {
        html.push(`<code>${nick}</code> - ${reasons.join(", ")}`);
      }
      html.push(``);
    }
    if (reviewCount > 0) {
      html.push(`<b>⚠️ REVIEW LIST:</b>`);
      for (const { nick, reasons, aiReason } of results.filter(r => r.status === "REVIEW")) {
        const extra = aiReason ? ` [AI: ${aiReason}]` : "";
        html.push(`<code>${nick}</code> - ${reasons.join(", ")}${extra}`);
      }
    }

    if (html.length > 5) sendToTelegram(html.join("\n"));
    lastAutoScanTime = Date.now();
    console.log(`[AUTO SCAN] Complete: ${unique.length} scanned, ${banCount} ban, ${reviewCount} review`);
  } catch (e) {
    console.error("[AUTO SCAN] Error:", e?.message);
  }
}

/* ================== TELEGRAM COMMANDS ================== */
tg.start((ctx) => {
  ctx.reply("🚀 Bot started\n\n/tab <prefix> - manual scan\n/status - show status\n/reload - reload rules\n/scan - force auto scan");
});

tg.command("status", (ctx) => {
  const now = Date.now();
  ctx.reply([
    `<b>Status Report</b>`,
    `MC Online: ${mcOnline ? "✅" : "❌"}`,
    `MC Ready: ${mcReady ? "✅" : "❌"}`,
    `TAB Ready: ${tabReady ? "✅" : "❌"}`,
    `Tab failures: ${tabCompleteFailures}`,
    `Last scan: ${Math.round((now - lastAutoScanTime) / 1000)}s ago`,
    `Queue: ${tabCompleteQueue.length}`,
  ].join("\n"), { parse_mode: "HTML" });
});

tg.command("reload", (ctx) => {
  reloadRules();
  ctx.reply("✅ Rules reloaded");
});

tg.command("scan", async (ctx) => {
  if (!mcReady || !tabReady) {
    ctx.reply("❌ MC not ready");
    return;
  }
  ctx.reply("🔄 Scanning...");
  await performAutoScan();
  ctx.reply("✅ Scan completed");
});

tg.command("tab", async (ctx) => {
  try {
    const arg = ctx.message.text.split(" ").slice(1).join(" ");
    if (!arg) { ctx.reply("Usage: /tab <prefix>"); return; }
    if (!mcReady || !tabReady) { ctx.reply("❌ MC not ready"); return; }

    const names = await byPrefix(arg);
    let out = `🔎 Tab scan: <b>${arg}</b>\n\n`;
    if (names.length === 0) {
      out += "No players found";
    } else {
      for (const n of names) {
        const [s, reasons] = checkNick(n);
        const emoji = s === "BAN" ? "🚫" : s === "REVIEW" ? "⚠️" : "✅";
        out += `${emoji} <code>${n}</code> - ${s}\n`;
        if (reasons.length > 0) out += `    ${reasons.join(" | ")}\n`;
      }
    }
    ctx.reply(out, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("❌ ERR: " + String(e?.message || e));
  }
});

tg.command("connect", (ctx) => {
  if (!connecting && !mcReady) {
    ctx.reply("🔄 Connecting...");
    connectMC();
  } else {
    ctx.reply("Already connecting or ready");
  }
});

/* ================== WATCHDOG ================== */
function startWatchdog() {
  const interval = setInterval(() => {
    const now = Date.now();
    if (mcOnline && (!mcReady || !tabReady) && !connecting) {
      console.log("[WATCHDOG] Online but not ready");
      scheduleReconnect("watchdog_not_ready");
    }
    if (mcReady && tabReady && (now - lastTabCompleteTime > 120000) && tabCompleteFailures > 5) {
      console.log("[WATCHDOG] Tab inactive");
      scheduleReconnect("watchdog_tab_inactive");
    }
    if (AUTO_SCAN && mcReady && tabReady && (now - lastAutoScanTime > (AUTO_SCAN_MINUTES * 60000 + 30000))) {
      console.log("[WATCHDOG] Auto scan overdue");
      performAutoScan();
    }
    if (mcOnline && (now - lastHeartbeat > 45000)) {
      console.log("[WATCHDOG] Heartbeat timeout");
      scheduleReconnect("watchdog_heartbeat");
    }
  }, 20000);
  addTimer(interval);
}

/* ================== GRACEFUL SHUTDOWN ================== */
async function gracefulShutdown() {
  console.log("[SHUTDOWN] Starting graceful shutdown...");
  stopHeartbeat();
  clearAllTimers();
  clearAllListeners();
  if (mc) {
    try { mc.quit("shutdown"); } catch {}
    try { mc.end(); } catch {}
  }
  try { await tg.stop("shutdown"); } catch {}
  console.log("[SHUTDOWN] Complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown());
process.on("SIGTERM", () => gracefulShutdown());
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
  gracefulShutdown();
});

/* ================== MAIN STARTUP ================== */
async function main() {
  try {
    console.log("[MAIN] Starting main sequence...");
    loadRules();
    
    console.log("[MAIN] Launching Telegram...");
    await launchTelegramSafely();
    
    console.log("[MAIN] Connecting to Minecraft...");
    connectMC();
    
    await sleep(STARTUP_SCAN_DELAY_MS);
    
    if (AUTO_SCAN && mcReady && tabReady) {
      console.log("[MAIN] Performing initial scan...");
      await performAutoScan();
    }
    
    startWatchdog();
    
    if (AUTO_SCAN) {
      const scanInterval = setInterval(() => {
        if (mcReady && tabReady && !connecting) performAutoScan();
      }, AUTO_SCAN_MINUTES * 60000);
      addTimer(scanInterval);
    }
    
    console.log("[MAIN] ✓ Bot is running!");
  } catch (e) {
    console.error("[MAIN] Fatal error:", e?.message || e);
    process.exit(1);
  }
}

main();
