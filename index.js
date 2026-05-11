import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";

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
const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);

/* ================== GEMINI AI CONFIG ================== */
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const aiModel = genAI ? genAI.getGenerativeModel({ model: "gemini-1.5-flash" }) : null;

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== STATE & BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let connecting = false;

/* ================== RULES & NORMALIZATION ================== */
let RULES = { rules: [], whitelist_exact: [] };
try {
  if (fs.existsSync("rules.json")) {
    RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  }
} catch (e) {
  console.error("Ошибка загрузки rules.json:", e.message);
}

const cyrMap = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "к": "k", "м": "m", "т": "t" };
function norm(s = "") {
  s = s.replace(/§./g, "").toLowerCase();
  s = [...s].map(ch => cyrMap[ch] || ch).join("");
  return s.replace(/[^a-z0-9]/g, "");
}

function checkNick(name) {
  const n = norm(name);
  const banReasons = [];
  for (const rule of RULES.rules || []) {
    for (const word of rule.words || []) {
      if (n.includes(norm(word))) banReasons.push(`${rule.reason}:${word}`);
    }
  }
  return banReasons.length > 0 ? ["BAN", banReasons] : ["OK", []];
}

/* ================== MC FUNCTIONS ================== */
async function connectMC() {
  if (connecting) return;
  connecting = true;
  try {
    if (mc) {
      try { mc.quit(); } catch {}
      mc = null;
    }
    mcReady = false;
    tabReady = false;
    mcOnline = false;

    console.log(`[MC] Подключение к ${MC_HOST}:${MC_PORT}...`);
    mc = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: MC_USER,
      version: MC_VERSION,
    });

    mc.on("login", () => {
      mcOnline = true;
      console.log("[MC] login");
    });

    mc.on("spawn", async () => {
      await sleep(READY_AFTER_MS);
      mcReady = true;
      tabReady = true;
      console.log("[MC] ready");
      if (MC_PASSWORD) mc.chat(`/login ${MC_PASSWORD}`);
    });

    mc.on("end", () => scheduleReconnect("end"));
    mc.on("kicked", (reason) => scheduleReconnect(reason));
    mc.on("error", (e) => scheduleReconnect(e.message));
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(reason) {
  console.log(`[MC] Дисконнект (${reason}). Реконнект через 10с...`);
  mcReady = false;
  tabReady = false;
  setTimeout(() => connectMC(), 10000);
}

/* ================== TELEGRAM COMMANDS ================== */
const guard = (handler) => async (ctx) => {
  if (!ALLOWED_USER_IDS.has(ctx.from.id)) return ctx.reply("⛔ Нет доступа.");
  return handler(ctx);
};

tg.command("status", guard((ctx) => {
  const status = mcReady ? "✅ В сети и готов" : "❌ Оффлайн/Загрузка";
  ctx.reply(`🎮 Статус: ${status}\n👤 Ник: ${MC_USER}\n🌐 Сервер: ${MC_HOST}`);
}));

tg.command("scan", guard(async (ctx) => {
  if (!mcReady) return ctx.reply("⏳ Бот еще не заспавнился.");
  const players = Object.keys(mc.players);
  ctx.reply(`🔎 Сканирую ${players.length} игроков...`);
  
  let report = "";
  players.forEach(p => {
    const [res, reasons] = checkNick(p);
    if (res === "BAN") report += `⛔ ${p} -> ${reasons.join(", ")}\n`;
  });
  
  ctx.reply(report || "✅ Нарушителей по базе правил не найдено.");
}));

/* ================== AI REVIEW ================== */
tg.command("ai", guard(async (ctx) => {
  if (!AI_ENABLED || !aiModel) return ctx.reply("🤖 AI выключен.");
  const nick = ctx.message.text.split(" ")[1];
  if (!nick) return ctx.reply("Пример: /ai NickName");

  ctx.reply(`🤖 Gemini проверяет ник ${nick}...`);
  try {
    const prompt = `Проверь ник "${nick}" на мат, оскорбления или запрещенный контент. Ответь кратко: можно или бан, и почему.`;
    const result = await aiModel.generateContent(prompt);
    ctx.reply(`🤖 Вердикт AI: ${result.response.text()}`);
  } catch (e) {
    ctx.reply("❌ Ошибка AI.");
  }
}));

/* ================== SYSTEM LAUNCH ================== */
async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("Telegram starting...");
      await tg.launch({ dropPendingUpdates: true });
      console.log("Telegram started");
      return;
    } catch (e) {
      if (e.message.includes("409")) {
        console.log("409 Conflict: жду 15 сек...");
        await sleep(15000);
      } else {
        console.error("Telegram error:", e.message);
        await sleep(5000);
      }
    }
  }
}

(async () => {
  try {
    console.log("[SYSTEM] Starting services...");

    // 1. HTTP Сервер для Railway
    http.createServer((req, res) => {
      res.writeHead(200);
      res.end("Bot is running");
    }).listen(process.env.PORT || 3000, () => {
      console.log(`[SYSTEM] Web-server listening on ${process.env.PORT || 3000}`);
    });

    // 2. Запуск Телеграм
    await launchTelegramSafely();

    // 3. Запуск Майнкрафт
    console.log("[SYSTEM] Connecting to Minecraft...");
    await connectMC(); 

  } catch (e) {
    console.error("[SYSTEM] Startup error:", e);
  }
})();

/* ================== ERROR HANDLERS ================== */
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
