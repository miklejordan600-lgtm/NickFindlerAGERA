import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import process from "process";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Missing BOT_TOKEN / MC_HOST / MC_USER");
}

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);

/* ================== STATE ================== */
let mc = null;
let session = 0;
let mcReady = false;
let mcOnline = false;
let tabReady = false;

let reconnectTimer = null;
let autoScanTimer = null;
let scanning = false;

/* ================== UTILS ================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================== CLEAN ================== */
function destroyMC() {
  try {
    if (!mc) return;
    mc.removeAllListeners();
    try { mc.quit(); } catch {}
    try { mc.end(); } catch {}
    if (mc._client) {
      mc._client.removeAllListeners();
      try { mc._client.end(); } catch {}
    }
    mc = null;
  } catch {}
}

/* ================== RECONNECT ================== */
function reconnect(reason) {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, 5000);

  console.log("[MC] reconnect:", reason);
}

/* ================== TAB SAFE ================== */
function tabComplete(text) {
  return new Promise((resolve, reject) => {
    if (!mc) return reject("NO_MC");

    const c = mc._client;
    const timeout = setTimeout(() => reject("TAB_TIMEOUT"), 3000);

    const handler = (p) => {
      clearTimeout(timeout);
      const matches = p?.matches?.map(x => x.text || x) || [];
      resolve(matches);
    };

    c.once("tab_complete", handler);

    try {
      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 }
      });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
    }
  });
}

/* ================== CONNECT MC ================== */
async function connectMC() {
  const mySession = ++session;

  destroyMC();
  mcReady = false;
  mcOnline = false;
  tabReady = false;

  try {
    const srv = await resolveSrv(`_minecraft._tcp.${MC_HOST}`).catch(() => null);
    const host = srv?.[0]?.name || MC_HOST;
    const port = srv?.[0]?.port || MC_PORT;

    mc = mineflayer.createBot({
      host,
      port,
      username: MC_USER,
      version: MC_VERSION,
    });

    mc.on("login", () => {
      mcOnline = true;
      console.log("[MC] login");
    });

    mc.on("spawn", async () => {
      console.log("[MC] spawn");

      await sleep(1500);

      try {
        await tabComplete("/msg a");
        mcReady = true;
        tabReady = true;

        console.log("[MC] READY");

        if (AUTO_SCAN) startAutoScan();
      } catch {
        reconnect("tab_fail");
      }
    });

    mc.on("messagestr", (msg) => {
      const m = String(msg).toLowerCase();

      if (MC_PASSWORD && m.includes("login")) {
        mc.chat(`/login ${MC_PASSWORD}`);
      }

      if (MC_PASSWORD && m.includes("register")) {
        mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
      }
    });

    mc.on("end", () => reconnect("end"));
    mc.on("kicked", () => reconnect("kicked"));
    mc.on("error", (e) => reconnect(e?.message));

  } catch (e) {
    console.log("[MC] connect error:", e);
    reconnect("connect_fail");
  }
}

/* ================== CHECK ================== */
function checkNick(n) {
  const l = n.toLowerCase();
  if (l.includes("admin")) return "BAN";
  if (l.includes("owner")) return "BAN";
  return "OK";
}

/* ================== AUTO SCAN ================== */
async function startAutoScan() {
  if (scanning) return;
  scanning = true;

  async function scan() {
    if (!mcReady) return;

    const names = ["admin123", "player1", "test"];

    for (const n of names) {
      if (checkNick(n) === "BAN") {
        await tg.telegram.sendMessage(CHAT_ID, `🚫 ${n}\n/tban ${n} 1.1`);
      }
    }
  }

  await scan();

  autoScanTimer = setInterval(scan, AUTO_SCAN_MINUTES * 60000);
}

/* ================== UI ================== */
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Scan", "scan")],
    [Markup.button.callback("📊 Status", "status")],
    [Markup.button.callback("🔁 Auto now", "auto")]
  ]);
}

/* ================== COMMANDS ================== */
tg.start((ctx) => ctx.reply("Bot online ✅", menu()));

tg.action("status", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    `MC: ${mcOnline ? "online" : "offline"}\nReady: ${mcReady}\nTAB: ${tabReady}`,
    menu()
  );
});

tg.action("scan", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply("Scanning...");
});

tg.action("auto", async (ctx) => {
  await ctx.answerCbQuery();
  startAutoScan();
  ctx.reply("Auto scan started");
});

/* ================== START ================== */
tg.launch().then(() => console.log("[TG] started"));
connectMC();
