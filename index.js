import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const ALLOWED_USER_IDS = new Set(
  String(process.env.ALLOWED_USER_IDS || process.env.PING_USER_ID || "")
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((x) => Number.isInteger(x) && x > 0)
);

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;

const MC_VERSION =
  process.env.MC_VERSION === "false"
    ? false
    : (process.env.MC_VERSION || false);

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

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== DEBUG ================== */
function debugLog(msg, data = null) {
  if (DEBUG_MODE) {
    console.log(`[DEBUG] ${msg}`, data || "");
  }
}

/* ================== TG ================== */
const tg = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => {
  console.log("TG ERROR:", err?.message || err);
});

async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("Telegram starting...");
      await tg.launch({
        dropPendingUpdates: true,
        allowedUpdates: [],
      });
      console.log("Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);

      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("409 conflict, retry...");
        await sleep(15000);
        continue;
      }

      console.log("TG launch error:", msg);
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
    }).catch(e => debugLog("TG send error:", e?.message));
  } catch (e) {
    debugLog("TG send catch:", e?.message);
  }
}

/* ================== GEMINI ================== */
let geminiClient = null;
if (GEMINI_KEY) {
  try {
    geminiClient = new GoogleGenerativeAI(GEMINI_KEY);
    console.log("[GEMINI] initialized");
  } catch (e) {
    console.log("[GEMINI] init error:", e?.message);
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
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  try {
    RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
    console.log("[RULES] reloaded");
  } catch (e) {
    console.log("[RULES] reload error:", e?.message);
  }
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

      return {
        host: srv[0].name,
        port: srv[0].port,
        via: "SRV",
      };
    }
  } catch {}

  return {
    host: h,
    port: Number(port || 25565),
    via: "DIRECT",
  };
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
    try {
      clearTimeout(timer);
      clearInterval(timer);
    } catch {}
  }
  pendingTimers.clear();
}

function addListener(obj, event, handler) {
  pendingListeners.push({ obj, event, handler });
  return { obj, event, handler };
}

function clearAllListeners() {
  for (const { obj, event, handler } of pendingListeners) {
    try {
      obj.removeListener(event, handler);
    } catch {}
  }
  pendingListeners.length = 0;
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC] reconnect scheduled:", reason);

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
    
    if (mcReady && tabReady && mc && mc.health !== undefined) {
      debugLog("Heartbeat OK", { health: mc.health, position: mc.player?.position });
    } else if (mcOnline && (!mcReady || !tabReady)) {
      console.log("[HEARTBEAT] WARNING: online but not ready");
      scheduleReconnect("heartbeat_not_ready");
    }
  }, 15000);
  
  addTimer(heartbeatTimer);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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

      const matches =
        p?.matches?.map((x) =>
          typeof x === "string"
            ? x
            : x.text || x.match || ""
        ) || [];

      res(matches);
    };

    function cleanup() {
      clearTimeout(timeout);

      try {
        c.removeListener("tab_complete", on);
      } catch {}

      try {
        c.removeListener("tab_complete_response", on);
      } catch {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);

      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: {
          x: 0,
          y: 0,
          z: 0,
        },
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
        if (!mcReady || !tabReady) {
          throw new Error("MC_NOT_READY");
        }

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

function byPrefixQueued(prefix) {
  return new Promise((resolve, reject) => {
    tabCompleteQueue.push({ prefix, resolve, reject });
    processTabCompleteQueue();
  });
}

async function byPrefix(prefix) {
  if (!mcReady || !tabReady) {
    throw new Error("MC_NOT_READY");
  }

  const raw = await tabComplete(mc, `/msg ${prefix}`);

  function clean(s) {
    return String(s).replace(/[^A-Za-z0-9_]/g, "");
  }

  return [
    ...new Set(
      raw
        .map(clean)
        .filter((x) => x.length >= 3 && x.length <= 16)
    ),
  ];
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
      console.log(`[MC] TAB warmup fail ${i}`, e?.message || e);

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
      try {
        mc.quit("reconnect");
      } catch {}

      try {
        mc.end();
      } catch {}

      clearAllListeners();
      mc = null;
    }

    mcReady = false;
    tabReady = false;
    mcOnline = false;
    loginAttempted = false;
    tabCompleteFailures = 0;

    const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

    console.log("[MC DEBUG]", {
      inputHost: MC_HOST,
      inputPort: MC_PORT,
      resolvedHost: ep.host,
      resolvedPort: ep.port,
      via: ep.via,
      version: MC_VERSION,
      user: MC_USER,
    });

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
      validateMinecraftVersions: false,
    });

    const loginHandler = () => {
      mcOnline = true;
      console.log("[MC] login");
      startHeartbeat();
    };

    const spawnHandler = async () => {
      console.log("[MC] spawn");

      await sleep(READY_AFTER_MS);

      const ok = await warmupTabReady(mc);

      if (!ok) {
        console.log("[MC] TAB failed after spawn");
        scheduleReconnect("tab_failed_spawn");
        return;
      }

      console.log("[MC] READY - starting auto scan");
      lastAutoScanTime = Date.now();
    };

    const messageHandler = (msg) => {
      const m = String(msg).toLowerCase();

      if (MC_PASSWORD && m.includes("login") && !loginAttempted) {
        loginAttempted = true;
        const t = setTimeout(() => {
          try {
            mc.chat(`/login ${MC_PASSWORD}`);
          } catch {}
        }, 1500);
        addTimer(t);
      }

      if (MC_PASSWORD && m.includes("register") && !loginAttempted) {
        loginAttempted = true;
        const t = setTimeout(() => {
          try {
            mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
          } catch {}
        }, 1500);
        addTimer(t);
      }

      if (m.includes("antibot") || m.includes("limbo")) {
        console.log("[MC] detected antibot/limbo, reconnecting");
        scheduleReconnect("antibot_limbo");
      }
    };

    const kickedHandler = (r) => {
      console.log("[MC] kicked:", r);
      scheduleReconnect("kicked");
    };

    const endHandler = () => {
      console.log("[MC] disconnected");
      stopHeartbeat();
      scheduleReconnect("end");
    };

    const errorHandler = (e) => {
      console.log("[MC ERROR]", e?.stack || e?.message || e);
      
      if (String(e?.message || e).includes("ECONNREFUSED") || 
          String(e?.message || e).includes("ETIMEDOUT")) {
        scheduleReconnect("connection_error");
      }
    };

    addListener(mc, "login", loginHandler);
    addListener(mc, "spawn", spawnHandler);
    addListener(mc, "messagestr", messageHandler);
    addListener(mc, "kicked", kickedHandler);
    addListener(mc, "end", endHandler);
    addListener(mc, "error", errorHandler);

    mc.on("login", loginHandler);
    mc.on("spawn", spawnHandler);
    mc.on("messagestr", messageHandler);
    mc.on("kicked", kickedHandler);
    mc.on("end", endHandler);
    mc.on("error", errorHandler);

  } catch (e) {
    console.log("[MC CONNECT ERROR]", e?.message || e);
    stopHeartbeat();
    scheduleReconnect("connect_error");
  } finally {
    connecting = false;
  }
}

/* ================== AUTO SCAN ================== */
async function performAutoScan() {
  if (!AUTO_SCAN || !mcReady || !tabReady) {
    return;
  }

  try {
    console.log("[AUTO SCAN] starting");

    const prefixes = AUTO_PREFIXES
      ? AUTO_PREFIXES.split(",").map(p => p.trim()).filter(p => p)
      : ["a", "b", "c"];

    const allNicks = [];

    for (const prefix of prefixes) {
      try {
        const names = await byPrefixQueued(prefix);
        allNicks.push(...names);
        debugLog(`Auto scan prefix ${prefix}:`, names.length);
      } catch (e) {
        console.log(`[AUTO SCAN] prefix ${prefix} error:`, e?.message);
      }

      await sleep(SCAN_DELAY_MS);
    }

    const unique = [...new Set(allNicks)];

    let banCount = 0;
    let reviewCount = 0;
    let results = [];

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

    const html = [
      `<b>🔎 Auto Scan Report</b>`,
      `Scanned: ${unique.length}`,
      `Ban: ${banCount}`,
      `Review: ${reviewCount}`,
      ``,
    ];

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

    if (html.length > 5) {
      sendToTelegram(html.join("\n"));
    }

    lastAutoScanTime = Date.now();
    console.log("[AUTO SCAN] completed:", { unique: unique.length, ban: banCount, review: reviewCount });
  } catch (e) {
    console.log("[AUTO SCAN] error:", e?.message || e);
  }
}

/* ================== COMMANDS ================== */
tg.start((ctx) => {
  ctx.reply(
    [
      "🚀 Bot started",
      "",
      "/tab <prefix> - manual scan",
      "/status - show status",
      "/reload - reload rules",
      "/scan - force auto scan",
    ].join("\n")
  );
});

tg.command("status", (ctx) => {
  const now = Date.now();
  const lastScanAgo = Math.round((now - lastAutoScanTime) / 1000);
  const lastTabAgo = Math.round((now - lastTabCompleteTime) / 1000);
  
  ctx.reply(
    [
      `<b>Status Report</b>`,
      ``,
      `MC Online: ${mcOnline ? "✅" : "❌"}`,
      `MC Ready: ${mcReady ? "✅" : "❌"}`,
      `TAB Ready: ${tabReady ? "✅" : "❌"}`,
      `Connecting: ${connecting ? "⏳" : "✅"}`,
      ``,
      `Version: ${MC_VERSION || "auto"}`,
      `Tab failures: ${tabCompleteFailures}`,
      `Last scan: ${lastScanAgo}s ago`,
      `Last tab: ${lastTabAgo}s ago`,
      `Queue length: ${tabCompleteQueue.length}`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
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

    if (!arg) {
      ctx.reply("Usage: /tab <prefix>");
      return;
    }

    if (!mcReady || !tabReady) {
      ctx.reply("❌ MC not ready");
      return;
    }

    const names = await byPrefix(arg);

    let out = `🔎 Tab scan: <b>${arg}</b>\n\n`;

    if (names.length === 0) {
      out += "No players found";
    } else {
      for (const n of names) {
        const [s, reasons] = checkNick(n);
        const emoji = s === "BAN" ? "🚫" : s === "REVIEW" ? "⚠️" : "✅";
        out += `${emoji} <code>${n}</code> - ${s}\n`;

        if (reasons.length > 0) {
          out += `    ${reasons.join(" | ")}\n`;
        }
      }
    }

    ctx.reply(out, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("❌ ERR: " + String(e?.message || e));
  }
});

tg.command("connect", async (ctx) => {
  if (!connecting && !mcReady) {
    ctx.reply("🔄 Connecting...");
    connectMC();
  } else {
    ctx.reply("Already connecting or ready");
  }
});

/* ================== WATCHDOG ================== */
function startWatchdog() {
  const watchdogInterval = setInterval(() => {
    const now = Date.now();

    // Check if online but not ready
    if (mcOnline && (!mcReady || !tabReady) && !connecting) {
      console.log("[WATCHDOG] online but not ready - reconnecting");
      scheduleReconnect("watchdog_not_ready");
    }

    // Check if tab_complete hasn't been used recently
    if (mcReady && tabReady && (now - lastTabCompleteTime > 120000)) {
      console.log("[WATCHDOG] tab_complete inactive for 2 minutes");
      if (tabCompleteFailures > 5) {
        scheduleReconnect("watchdog_tab_inactive");
      }
    }

    // Check if auto scan hasn't run recently
    if (AUTO_SCAN && mcReady && tabReady && (now - lastAutoScanTime > (AUTO_SCAN_MINUTES * 60000 + 30000))) {
      console.log("[WATCHDOG] auto scan overdue");
      performAutoScan();
    }

    // Check heartbeat
    if (mcOnline && (now - lastHeartbeat > 45000)) {
      console.log("[WATCHDOG] heartbeat timeout");
      scheduleReconnect("watchdog_heartbeat");
    }
  }, 20000);

  addTimer(watchdogInterval);
  return watchdogInterval;
}

/* ================== STARTUP SEQUENCE ================== */
async function startupSequence() {
  console.log("[STARTUP] beginning startup sequence");
  
  try {
    await launchTelegramSafely();
    console.log("[STARTUP] telegram ready");
  } catch (e) {
    console.log("[STARTUP] telegram error:", e?.message);
  }

  await sleep(2000);

  console.log("[STARTUP] connecting to minecraft");
  connectMC();

  await sleep(STARTUP_SCAN_DELAY_MS);

  if (AUTO_SCAN && mcReady && tabReady) {
    console.log("[STARTUP] performing initial auto scan");
    await performAutoScan();
  }

  startWatchdog();

  if (AUTO_SCAN && mcReady && tabReady) {
    const autoScanInterval = setInterval(() => {
      if (mcReady && tabReady && !connecting) {
        performAutoScan();
      }
    }, AUTO_SCAN_MINUTES * 60000);

    addTimer(autoScanInterval);
  }

  console.log("[STARTUP] sequence complete");
}

/* ================== GRACEFUL SHUTDOWN ================== */
async function gracefulShutdown() {
  console.log("[SHUTDOWN] beginning graceful shutdown");

  stopHeartbeat();
  clearAllTimers();
  clearAllListeners();

  if (mc) {
    try {
      mc.quit("shutdown");
    } catch {}

    try {
      mc.end();
    } catch {}
  }

  try {
    await tg.stop("shutdown");
  } catch {}

  console.log("[SHUTDOWN] complete");
  process.exit(0);
}

process.once("SIGINT", () => gracefulShutdown());
process.once("SIGTERM", () => gracefulShutdown());

/* ================== START ================== */
startupSequence().catch(e => {
  console.log("[STARTUP] fatal error:", e?.message || e);
  process.exit(1);
});
