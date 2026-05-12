import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import process from "process";

process.setMaxListeners(50);

process.on("unhandledRejection", (err) => {
  console.log("[UNHANDLED]", err);
});

process.on("uncaughtException", (err) => {
  console.log("[CRASH]", err);
});

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const AI_ENABLED = (process.env.AI_ENABLED || "1") === "1";

/* ================== STATE ENGINE ================== */
let mc = null;

let state = {
  session: 0,
  status: "IDLE",
  reconnecting: false,
  spawnDone: false,
};

let reconnectTimer = null;
let autoScanTimer = null;
let tabQueue = Promise.resolve();

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeSend(chatId, text, extra) {
  return tg.telegram.sendMessage(chatId, text, extra).catch(() => {});
}

/* ================== DESTROY ================== */
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
function scheduleReconnect(reason) {
  if (state.reconnecting) return;

  state.reconnecting = true;

  clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(async () => {
    try {
      await connectMC();
    } finally {
      state.reconnecting = false;
    }
  }, 5000);

  console.log("[MC] reconnect:", reason);
}

/* ================== TAB SAFE ================== */
function tabCompleteSafe(text) {
  return new Promise((resolve, reject) => {
    if (!mc) return reject("NO_MC");

    tabQueue = tabQueue.then(() => {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej("TAB_TIMEOUT"), 2500);

        mc._client.once("tab_complete", (p) => {
          clearTimeout(t);

          const out =
            p?.matches?.map((x) => (typeof x === "string" ? x : x.text)) || [];

          res(out);
        });

        mc._client.write("tab_complete", {
          text,
          assumeCommand: true,
          lookedAtBlock: { x: 0, y: 0, z: 0 },
        });
      });
    });

    tabQueue.then(resolve).catch(reject);
  });
}

/* ================== CONNECT ================== */
async function connectMC() {
  const session = ++state.session;

  state.status = "CONNECTING";
  state.spawnDone = false;

  destroyMC();

  try {
    const ep = await resolveSrv(`_minecraft._tcp.${MC_HOST}`)
      .then(r => r[0])
      .catch(() => null);

    const host = ep?.name || MC_HOST;
    const port = ep?.port || MC_PORT;

    mc = mineflayer.createBot({
      host,
      port,
      username: MC_USER,
      version: MC_VERSION,
    });

    let dead = false;

    const kill = (r) => {
      if (dead || session !== state.session) return;
      dead = true;
      scheduleReconnect(r);
    };

    mc.once("spawn", async () => {
      if (session !== state.session) return;
      if (state.spawnDone) return;

      state.spawnDone = true;

      setTimeout(() => {
        state.status = "READY";
        console.log("[MC] READY");
      }, 1500);
    });

    mc.on("messagestr", (m) => {
      const msg = String(m).toLowerCase();

      if (MC_PASSWORD && msg.includes("login")) {
        mc.chat(`/login ${MC_PASSWORD}`);
      }

      if (MC_PASSWORD && msg.includes("register")) {
        mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
      }
    });

    mc.once("end", () => kill("end"));
    mc.once("kicked", (r) => kill("kick"));
    mc.once("error", (e) => kill(e?.message));

  } catch (e) {
    scheduleReconnect("connect_error");
  }
}

/* ================== NICK CHECK ================== */
function checkNick(nick) {
  const lower = nick.toLowerCase();

  if (lower.includes("admin")) return "BAN";
  if (lower.includes("mod")) return "REVIEW";

  return "OK";
}

/* ================== AUTO SCAN ================== */
async function autoScan() {
  if (!mc || state.status !== "READY") return;

  const names = ["test1", "admin123", "player"];

  let bans = [];

  for (const n of names) {
    if (checkNick(n) === "BAN") {
      bans.push(n);
    }
  }

  if (bans.length) {
    for (const n of bans) {
      await safeSend(CHAT_ID, `🚫 ${n}\n/tban ${n} 1.1`);
    }
  }

  autoScanTimer = setTimeout(autoScan, AUTO_SCAN_MINUTES * 60000);
}

/* ================== BUTTON ================== */
tg.action(/^tban_(.+)$/, async (ctx) => {
  const nick = ctx.match[1];

  await ctx.answerCbQuery();

  await ctx.reply(`📋 \`/tban ${nick} 1.1\``, {
    parse_mode: "Markdown"
  });
});

/* ================== START ================== */
tg.launch();

connectMC();
autoScan();
