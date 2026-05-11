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

const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();
const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);
const STARTUP_SCAN_DELAY_MS = Number(process.env.STARTUP_SCAN_DELAY_MS || 8000);

const TAB_WARMUP_RETRIES = Number(process.env.TAB_WARMUP_RETRIES || 4);
const TAB_WARMUP_DELAY_MS = Number(process.env.TAB_WARMUP_DELAY_MS || 2000);

const AUTO_RETRY_ON_FAIL_MINUTES = Number(process.env.AUTO_RETRY_ON_FAIL_MINUTES || 2);
const MAX_PREFIX_ERRORS_IN_REPORT = Number(process.env.MAX_PREFIX_ERRORS_IN_REPORT || 8);

/* ================== GEMINI ================== */
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";
const AI_BUDGET_PER_CLICK = Number(process.env.AI_BUDGET_PER_CLICK || 30);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 350);
const AI_MIN_CONF_FOR_BAN = Number(process.env.AI_MIN_CONF_FOR_BAN || 0.75);
const AI_MIN_CONF_FOR_OK = Number(process.env.AI_MIN_CONF_FOR_OK || 0.75);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAllowedUser(userId) {
  if (!userId) return false;
  if (ALLOWED_USER_IDS.size === 0) return true;
  return ALLOWED_USER_IDS.has(Number(userId));
}

/* ================== STATE ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let mcLastError = "";
let connecting = false;

/* ================== CONNECT MC ================== */
async function connectMC() {
  if (connecting) return;
  connecting = true;

  try {
    if (mc) {
      try { mc.quit(); } catch {}
      try { mc.end(); } catch {}
      mc = null;
    }

    mcReady = false;
    tabReady = false;
    mcOnline = false;

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
    });

    mc.on("end", () => scheduleReconnect("end"));
    mc.on("kicked", () => scheduleReconnect("kicked"));
    mc.on("error", (e) => scheduleReconnect(e.message));

  } finally {
    connecting = false;
  }
}

/* ================== HELPERS ================== */
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

function scheduleReconnect(reason) {
  console.log(`[MC] Disconnected (${reason}). Reconnecting in 10s...`);
  mcReady = false;
  tabReady = false;
  mcOnline = false;
  setTimeout(() => connectMC(), 10000);
}

/* ================== AUTO START ================== */
(async () => {
  try {
    console.log("[SYSTEM] Starting services...");

    // 1. Сначала HTTP сервер (Railway требует порт сразу)
    http.createServer((req, res) => {
      res.writeHead(200);
      res.end("Bot is running");
    }).listen(process.env.PORT || 3000, () => {
      console.log(`[SYSTEM] Web-server listening on ${process.env.PORT || 3000}`);
    });

    // 2. Телеграм
    await launchTelegramSafely();

    // 3. Майнкрафт
    console.log("[SYSTEM] Telegram OK. Connecting to Minecraft...");
    await connectMC(); 

  } catch (e) {
    console.error("[SYSTEM] Startup error:", e);
  }
})();

/* ================== ERROR HANDLERS ================== */
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
