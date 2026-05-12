import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import { resolveSrv } from "dns/promises";
import process from "process";

process.setMaxListeners(100);

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";
const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const SCAN_INTERVAL = Number(process.env.AUTO_SCAN_MINUTES || 10) * 60000;

/* ================== VALIDATION ================== */
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!MC_HOST) throw new Error("MC_HOST missing");
if (!MC_USER) throw new Error("MC_USER missing");

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);

/* ================== STATE ================== */
let mc = null;
let session = 0;
let status = "IDLE";

let reconnectAttempts = 0;
let reconnectTimer = null;
let scanTimer = null;

let tabQueue = Promise.resolve();

/* ================== UTILS ================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = (...a) => console.log("[BOT]", ...a);

/* ================== CLEAN MC ================== */
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

  reconnectAttempts++;

  if (reconnectAttempts > 10) {
    log("❌ Too many reconnects, stopping.");
    return;
  }

  const delay = Math.min(30000, 3000 * reconnectAttempts);

  log(`Reconnecting in ${delay}ms | reason: ${reason}`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, delay);
}

/* ================== TAB COMPLETE SAFE ================== */
function tabComplete(text) {
  return new Promise((resolve, reject) => {
    if (!mc) return reject("NO_MC");

    tabQueue = tabQueue.then(() => {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej("TAB_TIMEOUT"), 4000);

        mc._client.once("tab_complete", (p) => {
          clearTimeout(t);
          const matches = p?.matches?.map(m => m.text || m) || [];
          res(matches);
        });

        try {
          mc._client.write("tab_complete", {
            text,
            assumeCommand: true,
            lookedAtBlock: { x: 0, y: 0, z: 0 }
          });
        } catch (e) {
          clearTimeout(t);
          rej(e);
        }
      });
    });

    tabQueue.then(resolve).catch(reject);
  });
}

/* ================== CONNECT MC ================== */
async function connectMC() {
  const mySession = ++session;

  status = "CONNECTING";
  destroyMC();

  try {
    reconnectAttempts = 0;

    const srv = await resolveSrv(`_minecraft._tcp.${MC_HOST}`)
      .then(r => r[0])
      .catch(() => null);

    const host = srv?.name || MC_HOST;
    const port = srv?.port || MC_PORT;

    mc = mineflayer.createBot({
      host,
      port,
      username: MC_USER,
      version: MC_VERSION,
    });

    mc._client.setMaxListeners(100);

    mc.once("login", () => log("MC login"));

    mc.once("spawn", async () => {
      if (mySession !== session) return;

      log("MC spawn");

      await sleep(1500);

      try {
        await tabComplete("/msg a");
        status = "READY";
        log("MC READY");

        if (AUTO_SCAN) startAutoScan();
      } catch (e) {
        log("TAB FAIL", e);
        reconnect("tab_fail");
      }
    });

    mc.on("messagestr", (msg) => {
      if (MC_PASSWORD && msg.toLowerCase().includes("login")) {
        mc.chat(`/login ${MC_PASSWORD}`);
      }

      if (MC_PASSWORD && msg.toLowerCase().includes("register")) {
        mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
      }
    });

    mc.once("end", () => reconnect("end"));
    mc.once("kicked", (r) => reconnect("kicked"));
    mc.once("error", (e) => {
      log("MC error:", e?.message);
      reconnect("error");
    });

  } catch (e) {
    log("connect error:", e?.message);
    reconnect("connect_fail");
  }
}

/* ================== NICK CHECK ================== */
function checkNick(n) {
  const l = n.toLowerCase();

  if (l.includes("admin")) return "BAN";
  if (l.includes("mod")) return "BAN";
  if (l.includes("owner")) return "BAN";

  return "OK";
}

/* ================== AUTO SCAN ================== */
let scanning = false;

async function startAutoScan() {
  if (scanning) return;
  scanning = true;

  async function scan() {
    if (!mc || status !== "READY") return;

    const names = ["admin123", "test", "player1"];

    for (const n of names) {
      if (checkNick(n) === "BAN") {
        try {
          await tg.telegram.sendMessage(
            CHAT_ID,
            `🚫 DETECTED: ${n}\n/tban ${n} 1.1`
          );
        } catch {}
      }
    }
  }

  await scan();

  scanTimer = setInterval(scan, SCAN_INTERVAL);
}

/* ================== TELEGRAM COMMANDS ================== */
tg.start((ctx) => ctx.reply("✅ Bot online"));

tg.command("status", (ctx) => {
  ctx.reply(
    `📊 STATUS: ${status}\nMC: ${mc ? "CONNECTED" : "DISCONNECTED"}\nReconnects: ${reconnectAttempts}`
  );
});

tg.command("scan", async (ctx) => {
  await ctx.reply("🔎 Manual scan started");
  await startAutoScan();
});

tg.action(/^tban_(.+)$/, async (ctx) => {
  const nick = ctx.match[1];
  await ctx.answerCbQuery();

  await ctx.reply(`📋 /tban ${nick} 1.1`, {
    parse_mode: "Markdown"
  });
});

/* ================== LOGGING ================== */
tg.catch((err) => {
  log("TG ERROR:", err);
});

/* ================== START ================== */
tg.launch().then(() => log("Telegram started"));
connectMC();
