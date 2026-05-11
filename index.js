import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf, Markup } from "telegraf";
import { resolveSrv } from "dns/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

/* FIX */
const MC_VERSION =
  process.env.MC_VERSION === "false"
    ? false
    : (process.env.MC_VERSION || false);

const MC_PASSWORD = process.env.MC_PASSWORD;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();

const READY_AFTER_MS = Number(process.env.READY_AFTER_MS || 1500);
const STARTUP_SCAN_DELAY_MS = Number(process.env.STARTUP_SCAN_DELAY_MS || 8000);
const TAB_WARMUP_RETRIES = Number(process.env.TAB_WARMUP_RETRIES || 4);
const TAB_WARMUP_DELAY_MS = Number(process.env.TAB_WARMUP_DELAY_MS || 2000);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== TG ================== */
const tg = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => {
  console.log("TG ERROR:", err?.message || err);
});

async function launchTelegramSafely() {
  while (true) {
    try {
      console.log("Telegram starting...");
      await tg.launch({ dropPendingUpdates: true });
      console.log("Telegram started");
      return;
    } catch (e) {
      const msg = String(e?.message || e);

      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("409 conflict, retry...");
        await sleep(15000);
        continue;
      }

      console.log("TG launch error:", msg);
      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

function reloadRules() {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
}

/* ================== NORMALIZE ================== */
function norm(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/§./g, "")
    .replace(/[\s\-_.:,;|/\\~`'"^*+=()[\]{}<>]/g, "");
}

/* ================== CHECK ================== */
function checkNick(name) {
  const n = norm(name);

  for (const rule of RULES.rules || []) {
    if ((rule.action || "").toUpperCase() !== "BAN") continue;

    for (const w of rule.words || []) {
      if (n.includes(norm(w))) {
        return ["BAN", [`${rule.reason || rule.id}:${w}`]];
      }
    }
  }

  for (const w of RULES.review || []) {
    if (n.includes(norm(w))) {
      return ["REVIEW", [`review:${w}`]];
    }
  }

  return ["OK", []];
}

/* ================== SRV ================== */
async function resolveMcEndpoint(host, port) {
  const h = String(host || "").trim();

  try {
    const srv = await resolveSrv(`_minecraft._tcp.${h}`);

    if (srv?.length) {
      srv.sort((a, b) => a.priority - b.priority);

      return {
        host: srv[0].name,
        port: srv[0].port,
        via: "SRV",
      };
    }
  } catch {}

  return {
    host: h,
    port: Number(port || 25565),
    via: "DIRECT",
  };
}

/* ================== MC ================== */
let mc = null;
let mcReady = false;
let tabReady = false;
let mcOnline = false;
let reconnectTimer = null;
let connecting = false;

function scheduleReconnect(reason) {
  if (reconnectTimer) return;

  console.log("[MC] reconnect scheduled:", reason);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMC();
  }, 5000);
}

function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    if (!bot?._client) {
      rej(new Error("CLIENT_NOT_READY"));
      return;
    }

    const c = bot._client;

    const timeout = setTimeout(() => {
      cleanup();
      rej(new Error("TAB_TIMEOUT"));
    }, 3000);

    const on = (p) => {
      cleanup();

      const matches =
        p?.matches?.map((x) =>
          typeof x === "string"
            ? x
            : x.text || x.match || ""
        ) || [];

      res(matches);
    };

    function cleanup() {
      clearTimeout(timeout);

      try {
        c.removeListener("tab_complete", on);
      } catch {}

      try {
        c.removeListener("tab_complete_response", on);
      } catch {}
    }

    try {
      c.once("tab_complete", on);
      c.once("tab_complete_response", on);

      c.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: {
          x: 0,
          y: 0,
          z: 0,
        },
      });
    } catch (e) {
      cleanup();
      rej(e);
    }
  });
}

async function warmupTabReady(bot) {
  for (let i = 1; i <= TAB_WARMUP_RETRIES; i++) {
    try {
      const r = await tabComplete(bot, "/msg a");

      if (Array.isArray(r)) {
        tabReady = true;
        mcReady = true;

        console.log(`[MC] TAB ready on try ${i}`);

        return true;
      }
    } catch (e) {
      console.log(`[MC] TAB warmup fail ${i}`, e?.message || e);

      await sleep(TAB_WARMUP_DELAY_MS);
    }
  }

  return false;
}

async function connectMC() {
  if (connecting) return;

  connecting = true;

  try {
    if (mc) {
      try {
        mc.quit("reconnect");
      } catch {}

      try {
        mc.end();
      } catch {}

      mc = null;
    }

    mcReady = false;
    tabReady = false;
    mcOnline = false;

    const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

    console.log("[MC DEBUG]", {
      inputHost: MC_HOST,
      inputPort: MC_PORT,
      resolvedHost: ep.host,
      resolvedPort: ep.port,
      via: ep.via,
      version: MC_VERSION,
      user: MC_USER,
    });

    /* FIXED BOT */
    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,

      username: MC_USER,

      version: MC_VERSION,

      auth: "offline",

      hideErrors: false,

      checkTimeoutInterval: 30000,

      viewDistance: "tiny",
    });

    mc.on("login", () => {
      mcOnline = true;

      console.log("[MC] login");
    });

    mc.on("spawn", async () => {
      console.log("[MC] spawn");

      await sleep(READY_AFTER_MS);

      const ok = await warmupTabReady(mc);

      if (!ok) {
        console.log("[MC] TAB failed");

        scheduleReconnect("tab_failed");

        return;
      }

      console.log("[MC] READY");
    });

    mc.on("messagestr", (msg) => {
      const m = String(msg).toLowerCase();

      if (MC_PASSWORD && m.includes("login")) {
        setTimeout(() => {
          try {
            mc.chat(`/login ${MC_PASSWORD}`);
          } catch {}
        }, 1500);
      }

      if (MC_PASSWORD && m.includes("register")) {
        setTimeout(() => {
          try {
            mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
          } catch {}
        }, 1500);
      }
    });

    mc.on("kicked", (r) => {
      console.log("[MC] kicked:", r);

      scheduleReconnect("kicked");
    });

    mc.on("end", () => {
      console.log("[MC] disconnected");

      scheduleReconnect("end");
    });

    mc.on("error", (e) => {
      console.log("[MC ERROR]", e?.stack || e?.message || e);
    });
  } catch (e) {
    console.log("[MC CONNECT ERROR]", e?.message || e);

    scheduleReconnect("connect_error");
  } finally {
    connecting = false;
  }
}

/* ================== SCAN ================== */
function clean(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  if (!mcReady || !tabReady) {
    throw new Error("MC_NOT_READY");
  }

  const raw = await tabComplete(mc, `/msg ${prefix}`);

  return [
    ...new Set(
      raw
        .map(clean)
        .filter((x) => x.length >= 3 && x.length <= 16)
    ),
  ];
}

/* ================== COMMANDS ================== */
tg.start((ctx) => {
  ctx.reply(
    [
      "🚀 Bot started",
      "",
      "/tab a",
      "/status",
    ].join("\n")
  );
});

tg.command("status", (ctx) => {
  ctx.reply(
    [
      `MC online: ${mcOnline}`,
      `MC ready: ${mcReady}`,
      `TAB ready: ${tabReady}`,
      `Version: ${MC_VERSION}`,
    ].join("\n")
  );
});

tg.command("tab", async (ctx) => {
  try {
    const arg = ctx.message.text.split(" ").slice(1).join(" ");

    const names = await byPrefix(arg);

    let out = `🔎 ${arg}\n\n`;

    for (const n of names) {
      const [s] = checkNick(n);

      out += `${n} -> ${s}\n`;
    }

    ctx.reply(out || "empty");
  } catch (e) {
    ctx.reply("ERR: " + String(e?.message || e));
  }
});

/* ================== WATCHDOG ================== */
setInterval(() => {
  if (mcOnline && (!mcReady || !tabReady) && !connecting) {
    console.log("[WATCHDOG] reconnect");

    scheduleReconnect("watchdog");
  }
}, 30000);

/* ================== START ================== */
(async () => {
  await launchTelegramSafely();

  console.log("TG started");

  await connectMC();
})();
