import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import http from "http";

/* ================== CONFIG ================== */
const config = {
  token: process.env.BOT_TOKEN,
  mcHost: process.env.MC_HOST,
  mcPort: Number(process.env.MC_PORT) || 25565,
  mcUser: process.env.MC_USER,
  mcVer: process.env.MC_VERSION || "1.8.9",
  mcPass: process.env.MC_PASSWORD,
  allowedUsers: String(process.env.ALLOWED_USER_IDS || "").split(",").map(Number)
};

// Проверка критических данных
if (!config.token || !config.mcHost || !config.mcUser) {
  console.error("❌ ОШИБКА: Проверь переменные BOT_TOKEN, MC_HOST и MC_USER!");
  process.exit(1);
}

/* ================== ИНИЦИАЛИЗАЦИЯ ================== */
const bot = new Telegraf(config.token);
let mcBot = null;
let isMcReady = false;

/* ================== WEB SERVER (Для Railway) ================== */
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot Status: Online");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[1/3] ✅ Веб-сервер запущен на порту ${PORT}`);
});

/* ================== MINECRAFT LOGIC ================== */
function createMcBot() {
  console.log(`[3/3] 🔄 Подключение к Minecraft: ${config.mcHost}:${config.mcPort}...`);
  
  if (mcBot) {
    try { mcBot.quit(); } catch(e) {}
    mcBot = null;
  }

  isMcReady = false;

  mcBot = mineflayer.createBot({
    host: config.mcHost,
    port: config.mcPort,
    username: config.mcUser,
    version: config.mcVer,
    hideErrors: false
  });

  mcBot.on("login", () => console.log("   🎮 Бот залогинился в игру"));
  
  mcBot.on("spawn", () => {
    isMcReady = true;
    console.log("   🎮 Бот заспавнился и готов!");
    if (config.mcPass) {
      setTimeout(() => mcBot.chat(`/login ${config.mcPass}`), 2000);
    }
  });

  mcBot.on("error", (err) => console.log(`   ❌ Ошибка MC: ${err.message}`));
  
  mcBot.on("end", () => {
    console.log("   ⚠️ Соединение с MC разорвано. Реконнект через 15 сек...");
    setTimeout(createMcBot, 15000);
  });
}

/* ================== TELEGRAM COMMANDS ================== */
bot.start((ctx) => ctx.reply("Бот запущен! Используй /status"));

bot.command("status", (ctx) => {
  const status = isMcReady ? "✅ В игре" : "❌ Не в игре";
  ctx.reply(`Статус: ${status}\nСервер: ${config.mcHost}\nНик: ${config.mcUser}`);
});

bot.command("scan", (ctx) => {
  if (!isMcReady) return ctx.reply("Бот еще не в игре!");
  const players = Object.keys(mcBot.players);
  ctx.reply(`Игроков в табе: ${players.length}\nНики: ${players.join(", ")}`);
});

/* ================== БЕЗОПАСНЫЙ ЗАПУСК ================== */
async function start() {
  try {
    console.log("[2/3] 🔄 Запуск Telegram...");
    
    // Используем webhook (опционально) или обычный запуск, 
    // но с обработкой ошибок
    await bot.launch({
      dropPendingUpdates: true
    }).then(() => {
      console.log("[2/3] ✅ Telegram запущен успешно");
    });

    // После ТГ запускаем Майн
    createMcBot();

  } catch (err) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:");
    console.error(err);
    // Пробуем перезапустить только ТГ через время
    setTimeout(start, 20000);
  }
}

start();

// Глобальные перехватчики, чтобы процесс не умирал
process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));
