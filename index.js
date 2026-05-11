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

if (!BOT_TOKEN || !CHAT_ID || !MC_HOST) {
    console.error("[FATAL] Проверь переменные окружения: BOT_TOKEN, CHAT_ID, MC_HOST");
    process.exit(1);
}

/* ================== TELEGRAM BOT ================== */
const tg = new Telegraf(BOT_TOKEN);

async function initTelegram() {
    try {
        await tg.telegram.deleteWebhook({ drop_pending_updates: true });
        tg.launch();
        console.log("[TG] ✓ Бот запущен (Polling)");
        await tg.telegram.sendMessage(CHAT_ID, "🚀 <b>Система сканирования запущена!</b>", { parse_mode: "HTML" });
    } catch (e) {
        console.error("[TG ERROR]", e.message);
    }
}

/* ================== RULES & NORMALIZE ================== */
let RULES = { rules: [], review: [] };
async function loadRules() {
    try {
        const data = await fsPromises.readFile("rules.json", "utf8");
        RULES = JSON.parse(data);
        console.log("[RULES] ✓ Правила загружены");
    } catch (e) {
        console.warn("[RULES] ⚠ Ошибка загрузки rules.json, использую пустые правила");
    }
}

function norm(s = "") {
    return String(s).toLowerCase().replace(/§./g, "").replace(/[^a-z0-9]/g, "");
}

function checkNick(name) {
    const n = norm(name);
    for (const rule of RULES.rules || []) {
        for (const w of rule.words || []) {
            if (n.includes(norm(w))) return ["BAN", rule.reason || "Banned word"];
        }
    }
    return ["OK", null];
}

/* ================== MINEFLAYER ENGINE ================== */
let bot = null;
let reconnectTimeout = null;

function createMCBot() {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    
    // Очистка старого бота перед созданием нового
    if (bot) {
        bot.removeAllListeners();
        try { bot.end(); } catch (e) {}
        bot = null;
    }

    console.log(`[MC] Подключение к ${MC_HOST}...`);

    bot = mineflayer.createBot({
        host: MC_HOST,
        username: MC_USER,
        version: MC_VERSION,
        hideErrors: true,
        checkTimeoutInterval: 60000
    });

    bot.setMaxListeners(30);

    // Авторизация один раз при спавне
    bot.once("spawn", () => {
        console.log("[MC] ✓ Бот заспавнился");
        if (MC_PASS) {
            setTimeout(() => {
                bot.chat(`/login ${MC_PASS}`);
                console.log("[MC] Команда /login отправлена");
            }, 2000);
        }
    });

    // Обработка входа игроков
    bot.on("playerJoined", async (player) => {
        if (player.username === bot.username) return;
        const [status, reason] = checkNick(player.username);
        if (status === "BAN") {
            const msg = `🚫 <b>Нарушитель!</b>\nНик: <code>${player.username}</code>\nПричина: ${reason}`;
            await tg.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "HTML" }).catch(() => {});
        }
    });

    bot.on("error", (err) => console.log("[MC ERROR]", err.message));
    
    bot.on("end", (reason) => {
        console.log(`[MC] Отключен: ${reason}. Реконнект через 15с...`);
        reconnectTimeout = setTimeout(createMCBot, 15000);
    });
}

/* ================== START ================== */
(async () => {
    await loadRules();
    await initTelegram();
    createMCBot();
})();

/* ================== KEEP ALIVE ================== */
// HTTP сервер, чтобы Railway не считал приложение упавшим
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
}).listen(process.env.PORT || 3000);

// Защита от фатальных ошибок
process.on('uncaughtException', (e) => console.error('CRASH:', e));
process.on('unhandledRejection', (e) => console.error('REJECTION:', e));
