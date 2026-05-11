import fs from "fs";
import fsPromises from "fs/promises";
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

// Webhook config
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || "https://nickfindleragera-production.up.railway.app";
const PORT = Number(process.env.PORT || 3000);
const HOOK_PATH = process.env.HOOK_PATH || `/telegraf/${BOT_TOKEN}`;

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
  const useWebhook = Boolean(WEBHOOK_DOMAIN && WEBHOOK_DOMAIN.startsWith("http"));

  while (true) {
    try {
      attempts++;
      if (useWebhook) {
        console.log(`[TG] Launch attempt ${attempts} (webhook) ...`);
        await tg.launch({
          webhook: {
            domain: WEBHOOK_DOMAIN,
            port: PORT,
            hookPath: HOOK_PATH,
          },
          dropPendingUpdates: true,
        });
        console.log("[TG] ✓ Launched successfully (webhook)");
        return;
      } else {
        console.log(`[TG] Launch attempt ${attempts} (polling) ...`);
        await tg.launch({ dropPendingUpdates: true });
        console.log("[TG] ✓ Launched successfully (polling)");
        return;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("[TG] Launch failed:", msg);

      if (useWebhook && attempts >= 2) {
        console.warn("[TG] Webhook failed, falling back to polling mode");
        try {
          await tg.launch({ dropPendingUpdates: true });
          console.log("[TG] ✓ Launched successfully (polling fallback)");
          return;
        } catch (err) {
          console.error("[TG] Polling fallback failed:", err?.message || err);
        }
      }

      if (msg.includes("409") || msg.includes("Conflict")) {
        await sleep(15000);
        continue;
      }
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

/* ================== RULES (FIXED: Async to prevent blocking) ================== */
let RULES = { rules: [], review: [] };

async function loadRules() {
  try {
    // Используем асинхронное чтение, чтобы не блокировать Event Loop
    const data = await fsPromises.readFile("rules.json", "utf8");
    RULES = JSON.parse(data);
    console.log("[RULES] ✓ Loaded");
  } catch (e) {
    console.error("[RULES] Load failed or rules.json not found:", e?.message);
    RULES = { rules: [], review: [] };
  }
}

/* ================== NORMALIZE & CHECK ================== */
function norm(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/§./g, "")
    .replace(/[\s\-_.:,;|/\\~`'"^*+=()[\]{}<>]/g, "");
}

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

/* ================== MC BOT ENGINE (FIXED) ================== */
let bot = null;
let reconnectTimer = null;

async function createMinecraftBot() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  const endpoint = await resolveMcEndpoint(MC_HOST, MC_PORT);
  console.log(`[MC] Connecting to ${endpoint.host}:${endpoint.port} (${endpoint.via})`);

  // Загружаем правила асинхронно перед подключением
  await loadRules();

  bot = mineflayer.createBot({
    host: endpoint.host,
    port: endpoint.port,
    username: MC_USER,
    password: MC_PASSWORD,
    version: MC_VERSION, // Убедитесь, что версия совпадает с сервером
    hideErrors: true // Скрывает спам об ошибках чанков, если версия немного не совпадает
  });

  // ИСПРАВЛЕНИЕ УТЕЧКИ: Увеличиваем лимит слушателей
  bot.setMaxListeners(20);

  bot.on("login", () => {
    console.log("[MC] ✓ Login successful");
  });

  bot.on("spawn", () => {
    console.log("[MC] ✓ Spawned in world");
    // Здесь можно добавить вашу логику проверки игроков (AUTO_SCAN)
  });

  bot.on("kicked", (reason) => {
    console.log("[MC] Kicked:", reason);
  });

  bot.on("error", (err) => {
    console.log("[MC] Error:", err?.message);
  });

  bot.on("end", (reason) => {
    console.log("[MC] Disconnected:", reason);
    
    // ИСПРАВЛЕНИЕ УТЕЧКИ: Полностью очищаем слушатели перед пересозданием
    bot.removeAllListeners();
    bot = null;

    // Планируем переподключение
    reconnectTimer = setTimeout(() => {
      console.log("[MC] Attempting to reconnect...");
      createMinecraftBot();
    }, 10000); // Реконнект через 10 секунд
  });

  // Пример сканирования чата на предмет новых игроков/подозрений
  bot.on("playerJoined", async (player) => {
    if (player.username === bot.username) return;
    
    const [status, reasons] = checkNick(player.username);
    if (status === "BAN" || status === "REVIEW") {
      console.log(`[SCAN] Suspicious nick detected: ${player.username} (${status})`);
      sendToTelegram(`⚠️ <b>Suspicious Nickname</b>\nPlayer: <code>${player.username}</code>\nStatus: <b>${status}</b>\nReason: ${reasons.join(", ")}`);
    } else if (GEMINI_KEY) {
      // ИИ проверка, если обычные правила ничего не нашли
      const aiResult = await checkNickWithAI(player.username);
      if (aiResult?.suspicious) {
        sendToTelegram(`🤖 <b>AI Flagged Nickname</b>\nPlayer: <code>${player.username}</code>\nReason: ${aiResult.reason}`);
      }
    }
  });
}

/* ================== STARTUP ================== */
async function start() {
  await launchTelegramSafely();
  await createMinecraftBot();
}

start();

// Обработка крашей процесса
process.on('uncaughtException', err => console.error('[FATAL] Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('[FATAL] Unhandled Rejection:', err));
