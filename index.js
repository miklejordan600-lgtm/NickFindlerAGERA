import fs from "fs";
import fsPromises from "fs/promises";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import http from "http";

/* ================== CONFIG ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_USER = process.env.MC_USER;
const MC_PASS = process.env.MC_PASSWORD; // ПАРОЛЬ ОТ АККАУНТА В ИГРЕ
const MC_VERSION = process.env.MC_VERSION === "false" ? false : (process.env.MC_VERSION || false);

console.log("[INIT] Запуск системы...");

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("[FATAL] Проверь BOT_TOKEN и CHAT_ID!");
  process.exit(1);
}

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

async function initTelegram() {
  try {
    // Удаляем вебхуки и запускаем чистый Polling
    await tg.telegram.deleteWebhook({ drop_pending_updates: true });
    tg.launch();
    console.log("[TG] ✓ Запущен через Polling (сообщения должны приходить)");
    
    await tg.telegram.sendMessage(CHAT_ID, "🚀 <b>Бот запущен!</b> Ожидаю вход на сервер...", { parse_mode: "HTML" });
  } catch (e) {
    console.error("[TG ERROR]", e.message);
  }
}

/* ================== RULES ================== */
let RULES = { rules: [], review: [] };
async function loadRules() {
  try {
    const data = await fsPromises.readFile("rules.json", "utf8");
    RULES = JSON.parse(data);
    console.log("[RULES] ✓ Загружены");
  } catch (e) { console.log("[RULES] ⚠ Работу без правил"); }
}

function checkNick(name) {
  const n = name.toLowerCase();
  for (const rule of RULES.rules || []) {
    for (const w of rule.words || []) {
      if (n.includes(w.toLowerCase())) return ["BAN", rule.reason];
    }
  }
  return ["OK", null];
}

/* ================== MINECRAFT ================== */
function createMCBot() {
  console.log(`[MC] Подключение к ${MC_HOST}...`);
  
  const bot = mineflayer.createBot({
    host: MC_HOST,
    username: MC_USER,
    version: MC_VERSION,
    hideErrors: true,
    checkTimeoutInterval: 60000 // Увеличиваем время ожидания
  });

  bot.on("spawn", async () => {
    console.log("[MC] ✓ Заспавнился!");
    
    // АВТО-ЛОГИН: Если сервер требует пароль
    if (MC_PASS) {
      console.log("[MC] Отправляю команду авторизации...");
      bot.chat(`/login ${MC_PASS}`);
    }
    
    await tg.telegram.sendMessage(CHAT_ID, "🎮 <b>Бот в игре!</b> Начинаю сканирование игроков.");
  });

  // Ловим сообщения сервера (например, "Введите пароль")
  bot.on("messagestr", (message) => {
    if (message.includes("авторизацию") || message.includes("/login")) {
      console.log("[MC] Сервер просит логин...");
      if (MC_PASS) bot.chat(`/login ${MC_PASS}`);
    }
  });

  bot.on("playerJoined", async (player) => {
    if (player.username === bot.username) return;
    const [status, reason] = checkNick(player.username);
    if (status === "BAN") {
      await tg.telegram.sendMessage(CHAT_ID, `🚫 <b>Нарушитель!</b>\nНик: <code>${player.username}</code>\nПричина: ${reason}`, { parse_mode: "HTML" });
    }
  });

  bot.on("error", (err) => console.log("[MC ERROR]", err.message));

  bot.on("end", (reason) => {
    console.log(`[MC] Отключен (${reason}). Реконнект через 15 сек...`);
    setTimeout(createMCBot, 15000);
  });
}

/* ================== START ================== */
loadRules().then(() => {
  initTelegram();
  createMCBot();
});

// Заглушка сервера для Railway
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Bot is alive');
}).listen(process.env.PORT || 3000);
