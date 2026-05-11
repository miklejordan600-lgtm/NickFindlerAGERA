import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import http from "http";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================== STATE ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let connecting = false;

/* ================== CONNECT ================== */
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
      await sleep(1200);
      mcReady = true;
      tabReady = true;
      console.log("[MC] READY");
    });

    mc.on("end", () => scheduleReconnect("end"));
    mc.on("kicked", () => scheduleReconnect("kicked"));
    mc.on("error", (e) => scheduleReconnect(e.message));

  } finally {
    connecting = false;
  }
}

/* ================== TAB COMPLETE (FAST) ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    const c = bot?._client;
    if (!c) return rej(new Error("NO_CLIENT"));

    const to = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 1200); // ⚡ ускорено с 2500 → 1200

    function on(p) {
      cleanup();
      const matches =
        p?.matches?.map(x => (typeof x === "string" ? x : x.text || "")) || [];
      res(matches);
    }

    function cleanup() {
      clearTimeout(to);
      try { c.removeListener("tab_complete", on); } catch {}
      try { c.removeListener("tab_complete_response", on); } catch {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);

      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: { x: 0, y: 0, z: 0 },
      });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

/* ================== FAST PREFIX SCAN ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();

  return [...new Set(
    raw
      .map(clean)
      .filter(n => n.length >= 3 && n.length <= 16)
      .filter(n => !pref || n.toLowerCase().startsWith(pref))
  )];
}

/* ================== 🔥 FAST COLLECT (×2–×4 SPEEDUP) ================== */
async function collect(ps) {
  const all = new Set();

  let ok = 0;
  let fail = 0;

  const CONCURRENCY = 5; // ⚡ ключ ускорения
  let index = 0;

  async function worker() {
    while (index < ps.length) {
      const i = index++;
      const p = ps[i];

      try {
        const found = await byPrefix(p);
        found.forEach(n => all.add(n));
        ok++;
      } catch {
        fail++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return {
    names: [...all],
    okPrefixes: ok,
    failedPrefixes: fail,
  };
}

/* ================== PREFIXES ================== */
function prefixes() {
  return [
    ..."abcdefghijklmnopqrstuvwxyz0123456789_"
  ];
}

/* ================== AUTO RECONNECT ================== */
let reconnectTimer = null;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC] reconnect:", reason);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, 4000);
}

/* ================== AUTO START ================== */
(async () => {
  console.log("[SYSTEM] start");

  await connectMC();

  http.createServer((req, res) => res.end("OK"))
    .listen(process.env.PORT || 3000);

  console.log("[SYSTEM] ready");
})();

/* ================== BASIC BOT ================== */
tg.start((ctx) => ctx.reply("Bot online"));

tg.command("scan", async (ctx) => {
  if (!mcReady || !tabReady) return ctx.reply("MC not ready");

  await ctx.reply("Scanning...");

  const scan = await collect(prefixes());

  await ctx.reply(
    `Done\nNames: ${scan.names.length}\nOK: ${scan.okPrefixes}\nFAIL: ${scan.failedPrefixes}`
  );
});

tg.launch();
