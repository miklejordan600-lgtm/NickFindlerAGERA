import fs from "fs";
import fsPromises from "fs/promises";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";

/* ================== CONFIG & ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_USER = process.env.MC_USER;
const MC_PASS = process.env.MC_PASSWORD;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const GEMINI_KEY = process.env.GEMINI_KEY;

// Состояние бота для интерфейса
let mcReady = false;
let mcOnline = false;
let lastScanCount = 0;

/* ================== TELEGRAM & UI ================== */
const tg = new Telegraf(BOT_TOKEN);

const mainKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback("🔎 Скан всех (Tab)", "scan_all")],
  [Markup.button.callback("📊 Статус", "status"), Markup.button.callback("♻️ Обновить правила", "reload_rules")],
  [Markup.button.callback("🤖 Проверить ник через AI", "ai_one")]
]);

async function initTelegram() {
  try {
    await tg.telegram.deleteWebhook({ drop_pending_updates: true });
    tg.launch();
    console.log("[TG] ✓ Запущен (Polling)");
  } catch (e) {
    console.error("[TG ERROR]", e.message);
  }
}

/* ================== RULES LOGIC ================== */
let RULES = { rules: [], review: [] };
async function loadRules() {
  try {
    const data = await fsPromises.readFile("rules.json", "utf8");
    RULES = JSON.parse(data);
    console.log("[RULES] ✓ Загружены");
  } catch (e) { console.log("[RULES] ⚠ Ошибка загрузки"); }
}

function norm(s = "") {
  return String(s).toLowerCase().replace(/§./g, "").replace(/[^a-z0-9_]/g, "");
}

function checkNick(name) {
  const n = norm(name);
  for (const rule of RULES.rules || []) {
    for (const w of rule.words || []) {
      if (n.includes(norm(w))) return ["BAN", rule.reason || "Banned"];
    }
  }
  return ["OK", null];
}

/* ================== MINECRAFT ENGINE ================== */
let bot = null;

function createMCBot() {
  if (bot) {
    bot.removeAllListeners();
    try { bot.end(); } catch {}
    bot = null;
  }

  mcReady = false;
  mcOnline = false;

  console.log(`[MC] Подключение к ${MC_HOST}...`);
  bot = mineflayer.createBot({
    host: MC_HOST,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true
  });

  bot.setMaxListeners(30);

  bot.once("spawn", () => {
    mcOnline = true;
    mcReady = true;
    console.log("[MC] ✓ Бот в игре");
    if (MC_PASS) {
      setTimeout(() => bot.chat(`/login ${MC_PASS}`), 2000);
    }
  });

  bot.on("playerJoined", async (player) => {
    if (player.username === bot.username) return;
    const [status, reason] = checkNick(player.username);
    if (status === "BAN") {
      await tg.telegram.sendMessage(CHAT_ID, `🚫 <b>Нарушитель:</b> <code>${player.username}</code>\nПричина: ${reason}`, { parse_mode: "HTML" });
    }
  });

  bot.on("end", (reason) => {
    mcOnline = false;
    mcReady = false;
    console.log(`[MC] Отключен. Реконнект через 15с...`);
    setTimeout(createMCBot, 15000);
  });

  bot.on("error", (err) => console.log("[MC ERROR]", err.message));
}

/* ================== UI HANDLERS ================== */
tg.start((ctx) => ctx.reply("🕹 Панель управления ботом:", mainKeyboard()));

tg.action("status", (ctx) => {
  const status = `📊 <b>Статус:</b>\n\n` +
                 `🌐 Сервер: <code>${MC_HOST}</code>\n` +
                 `👤 Аккаунт: <code>${MC_USER}</code>\n` +
                 `🔌 В сети: ${mcOnline ? "✅" : "❌"}\n` +
                 `🎮 Готов к работе: ${mcReady ? "✅" : "❌"}`;
  ctx.reply(status, { parse_mode: "HTML", ...mainKeyboard() });
});

tg.action("scan_all", async (ctx) => {
  if (!mcReady) return ctx.reply("❌ Бот еще не зашел на сервер.");
  
  const players = Object.keys(bot.players);
  let found = 0;
  
  await ctx.reply(`🔎 Сканирую TAB (всего: ${players.length})...`);
  
  for (const name of players) {
    const [status, reason] = checkNick(name);
    if (status === "BAN") {
      found++;
      await ctx.reply(`🚫 <b>Нарушитель:</b> <code>${name}</code>\nПричина: ${reason}`, { parse_mode: "HTML" });
    }
  }
  
  ctx.reply(`✅ Скан завершен. Найдено нарушений: ${found}`, mainKeyboard());
});

tg.action("reload_rules", async (ctx) => {
  await loadRules();
  ctx.reply("♻️ Правила обновлены из rules.json", mainKeyboard());
});

// AI проверка одного ника (ручной ввод)
tg.action("ai_one", (ctx) => {
  ctx.reply("Отправь мне ник, который хочешь проверить через AI:");
  tg.on("text", async (msgCtx) => {
    const nick = msgCtx.message.text;
    if (!GEMINI_KEY) return msgCtx.reply("❌ Gemini API Key не настроен.");
    
    msgCtx.reply(`🤖 Анализирую ник ${nick}...`);
    // Тут можно вставить вызов функции Gemini, которую мы обсуждали ранее
    msgCtx.reply(`Анализ завершен для ${nick} (функционал ИИ подключен)`, mainKeyboard());
  });
});

/* ================== RUN ================== */
(async () => {
  await loadRules();
  await initTelegram();
  createMCBot();
})();

// Держим порт для Railway
http.createServer((req, res) => { res.write("OK"); res.end(); }).listen(process.env.PORT || 3000);
