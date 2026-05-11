import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import http from "http";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = (process.env.MC_HOST || "").trim();
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || "1.8.9";

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Missing ENV: BOT_TOKEN / MC_HOST / MC_USER");
}

/* ================== BOT ================== */
const tg = new Telegraf(BOT_TOKEN);

/* ================== STATE ================== */
let mc = null;
let mcOnline = false;
let mcReady = false;
let tabReady = false;
let connecting = false;

/* ================== SAFE RECONNECT ================== */
let reconnectTimer = null;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC RECONNECT]", reason);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, 4000);
}

/* ================== MC CONNECT ================== */
async function connectMC() {
  if (connecting) return;
  connecting = true;

  try {
    if (mc) {
      try { mc.quit(); } catch {}
      try { mc.end(); } catch {}
      mc = null;
    }

    mcOnline = false;
    mcReady = false;
    tabReady = false;

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
      setTimeout(() => {
        mcReady = true;
        tabReady = true;
        console.log("[MC] READY");
      }, 1200);
    });

    mc.on("end", () => scheduleReconnect("end"));
    mc.on("kicked", (r) => scheduleReconnect("kicked"));
    mc.on("error", (e) => scheduleReconnect(e.message));

  } finally {
    connecting = false;
  }
}

/* ================== FAST TAB ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    const c = bot?._client;
    if (!c) return rej("NO_CLIENT");

    const timeout = setTimeout(() => {
      cleanup();
      rej("TAB_TIMEOUT");
    }, 1200);

    function on(p) {
      cleanup();
      const matches = p?.matches?.map(x => x?.text || x || "") || [];
      res(matches);
    }

    function cleanup() {
      clearTimeout(timeout);
      try { c.removeListener("tab_complete", on); } catch {}
    }

    try {
      c.once("tab_complete", on);

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

/* ================== FAST SCAN ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);

  return [...new Set(
    raw
      .map(clean)
      .filter(n => n.length >= 3 && n.length <= 16)
  )];
}

/* ================== 🔥 ULTRA FAST COLLECT ================== */
async function collect(ps) {
  const all = new Set();

  let ok = 0;
  let fail = 0;

  const CONCURRENCY = 5;
  let index = 0;

  async function worker() {
    while (index < ps.length) {
      const p = ps[index++];

      try {
        const res = await byPrefix(p);
        res.forEach(n => all.add(n));
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
  return "abcdefghijklmnopqrstuvwxyz0123456789_".split("");
}

/* ================== BOT COMMANDS ================== */
tg.start((ctx) => ctx.reply("✅ Bot online"));

tg.command("status", (ctx) => {
  ctx.reply(
    `MC: ${mcOnline}\nREADY: ${mcReady}\nTAB: ${tabReady}`
  );
});

tg.command("scan", async (ctx) => {
  if (!mcReady || !tabReady) return ctx.reply("MC not ready");

  await ctx.reply("🔎 scanning...");

  const scan = await collect(prefixes());

  await ctx.reply(
    `DONE\nNames: ${scan.names.length}\nOK: ${scan.okPrefixes}\nFAIL: ${scan.failedPrefixes}`
  );
});

/* ================== SELF HEAL ================== */
function selfHeal() {
  process.on("uncaughtException", (e) => {
    console.log("[CRASH]", e);
  });

  process.on("unhandledRejection", (e) => {
    console.log("[PROMISE ERROR]", e);
  });

  setInterval(() => {
    if (!mcOnline || !mcReady) {
      console.log("[WATCHDOG] MC reconnect");
      connectMC();
    }
  }, 30000);
}

/* ================== START ================== */
(async () => {
  console.log("[SYSTEM] starting...");

  selfHeal();

  await connectMC();

  tg.launch();
  console.log("[SYSTEM] Telegram started");

  http.createServer((req, res) => res.end("OK"))
    .listen(process.env.PORT || 3000);

})();
