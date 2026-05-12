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

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);

/* ================== STATE ================== */
let mc = null;
let ready = false;
let reconnecting = false;
let scanQueue = Promise.resolve();

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
  if (reconnecting) return;
  reconnecting = true;

  console.log("[MC] reconnect:", reason);

  setTimeout(() => {
    reconnecting = false;
    connectMC();
  }, 5000);
}

/* ================== TAB FIX (ВАЖНО) ================== */
function tabComplete(text) {
  return new Promise((resolve, reject) => {
    if (!mc) return reject("NO_MC");

    const c = mc._client;

    const timeout = setTimeout(() => {
      reject("TAB_TIMEOUT");
    }, 3000);

    const handler = (p) => {
      clearTimeout(timeout);

      const matches =
        p?.matches?.map(x => (typeof x === "string" ? x : x.text)) || [];

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

/* ================== CONNECT ================== */
async function connectMC() {
  destroyMC();
  ready = false;

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

    mc.once("spawn", async () => {
      console.log("[MC] spawn");

      await sleep(1500);

      try {
        await tabComplete("/msg a");
        ready = true;
        console.log("[MC] READY");
      } catch (e) {
        console.log("[MC] TAB FAIL:", e);
        reconnect("tab_fail");
      }
    });

    mc.on("messagestr", (msg) => {
      const m = String(msg).toLowerCase();

      if (m.includes("login")) {
        mc.chat(`/login ${process.env.MC_PASSWORD}`);
      }
      if (m.includes("register")) {
        mc.chat(`/register ${process.env.MC_PASSWORD} ${process.env.MC_PASSWORD}`);
      }
    });

    mc.on("end", () => reconnect("end"));
    mc.on("kicked", () => reconnect("kick"));
    mc.on("error", () => reconnect("error"));

  } catch (e) {
    console.log("[MC] connect error:", e);
    reconnect("connect_error");
  }
}

/* ================== SCAN ENGINE (FIXED) ================== */
function scanTab(prefix) {
  return scanQueue = scanQueue.then(async () => {
    if (!mc || !ready) throw new Error("MC_NOT_READY");

    const raw = await tabComplete(`/msg ${prefix}`);

    const cleaned = raw
      .map(x => String(x).replace(/[^A-Za-z0-9_]/g, ""))
      .filter(x => x.length >= 3 && x.length <= 16);

    return [...new Set(cleaned)];
  });
}

/* ================== SIMPLE CHECK ================== */
function checkNick(n) {
  const l = n.toLowerCase();
  if (l.includes("admin")) return "BAN";
  return "OK";
}

/* ================== REPORT ================== */
function buildReport(names) {
  const ban = [];
  const ok = [];

  for (const n of names) {
    if (checkNick(n) === "BAN") ban.push(n);
    else ok.push(n);
  }

  let out = `📦 SCAN RESULT\n\n`;
  out += `👥 total: ${names.length}\n`;
  out += `⛔ ban: ${ban.length}\n\n`;

  if (ban.length) {
    out += `BAN LIST:\n`;
    ban.forEach((n, i) => out += `${i + 1}) ${n}\n`);
  }

  return out;
}

/* ================== UI (ТВОЙ СТИЛЬ) ================== */
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 scan", "scan")],
    [Markup.button.callback("📊 status", "status")],
    [Markup.button.callback("🔁 auto scan", "auto")]
  ]);
}

/* ================== COMMANDS ================== */
tg.start((ctx) => ctx.reply("Bot online", menu()));

tg.action("status", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    `MC: ${mc ? "connected" : "disconnected"}\nREADY: ${ready}`,
    menu()
  );
});

/* ================== FIXED SCAN (ВАЖНО) ================== */
tg.action("scan", async (ctx) => {
  await ctx.answerCbQuery();

  if (!ready) return ctx.reply("MC not ready", menu());

  await ctx.reply("🔎 scanning...");

  try {
    const names = await scanTab("");
    const report = buildReport(names);

    await ctx.reply(report, menu());
  } catch (e) {
    await ctx.reply("scan error: " + e.message, menu());
  }
});

/* ================== AUTO ================== */
tg.action("auto", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply("auto scan enabled", menu());
});

/* ================== START ================== */
tg.launch();
connectMC();
