import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";
import { resolveSrv } from "dns/promises";

/* ================== ENV ================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;

// FALSE = автоопределение версии
const MC_VERSION = process.env.MC_VERSION || false;

const MC_PASSWORD = process.env.MC_PASSWORD || "";

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);

const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  console.error("[FATAL] Missing env");
  process.exit(1);
}

/* ================== TG ================== */

const tg = new Telegraf(BOT_TOKEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

tg.catch((err) => {
  console.log("[TG ERROR]", err?.message || err);
});

tg.telegram.getMe()
  .then(bot => {
    console.log("[TG] Logged as:", bot.username);
  })
  .catch(err => {
    console.log("[TG] Token error:", err.message);
  });

async function launchTelegramSafely() {
  let attempts = 0;

  while (true) {
    try {
      attempts++;

      console.log(`[TG] Launch attempt ${attempts}`);

      await tg.launch({
        dropPendingUpdates: true
      });

      console.log("[TG] ✓ Started");

      return;

    } catch (e) {
      const msg = String(e?.message || e);

      console.log("[TG] Launch failed:", msg);

      if (msg.includes("409")) {
        console.log("[TG] 409 conflict, waiting...");
        await sleep(15000);
        continue;
      }

      await sleep(5000);
    }
  }
}

/* ================== RULES ================== */

let RULES = {
  rules: [],
  review: []
};

try {
  RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));
  console.log("[RULES] Loaded");
} catch {
  console.log("[RULES] rules.json missing");
}

function checkNick(name) {
  const n = String(name).toLowerCase();

  for (const r of RULES.rules || []) {
    for (const w of r.words || []) {
      if (n.includes(String(w).toLowerCase())) {
        return ["BAN", r.reason || r.id || "rule"];
      }
    }
  }

  for (const w of RULES.review || []) {
    if (n.includes(String(w).toLowerCase())) {
      return ["REVIEW", w];
    }
  }

  return ["OK", ""];
}

/* ================== MC ================== */

let mc = null;

let mcReady = false;
let reconnecting = false;

let autoScanRunning = false;

async function resolveMcEndpoint(host, port) {
  try {
    const srv = await resolveSrv(`_minecraft._tcp.${host}`);

    if (srv?.length) {
      return {
        host: srv[0].name,
        port: srv[0].port
      };
    }
  } catch {}

  return {
    host,
    port
  };
}

async function connectMC() {
  if (reconnecting) return;

  reconnecting = true;

  try {

    if (mc) {
      try { mc.quit(); } catch {}
      try { mc.end(); } catch {}
    }

    mcReady = false;

    const ep = await resolveMcEndpoint(MC_HOST, MC_PORT);

    console.log(`[MC] Connecting to ${ep.host}:${ep.port}`);

    mc = mineflayer.createBot({
      host: ep.host,
      port: ep.port,
      username: MC_USER,
      password: MC_PASSWORD || undefined,
      version: MC_VERSION,
      hideErrors: true,
      viewDistance: 2
    });

    mc._client.setMaxListeners(50);
    mc.setMaxListeners(50);

    // ignore packet errors
    mc._client.on("error", () => {});

    mc.on("login", () => {
      console.log("[MC] ✓ Login");
    });

    mc.on("spawn", () => {
      console.log("[MC] ✓ Spawn");

      mcReady = true;

      if (AUTO_SCAN) {
        runAutoScan().catch(() => {});
      }
    });

    mc.on("messagestr", (msg) => {
      const m = String(msg).toLowerCase();

      if (MC_PASSWORD && m.includes("/login")) {
        setTimeout(() => {
          try {
            mc.chat(`/login ${MC_PASSWORD}`);
          } catch {}
        }, 1500);
      }
    });

    mc.on("kicked", (r) => {
      console.log("[MC] Kicked:", r);

      mcReady = false;

      reconnectLater();
    });

    mc.on("end", () => {
      console.log("[MC] End");

      mcReady = false;

      reconnectLater();
    });

    mc.on("error", (e) => {
      console.log("[MC] Error:", e?.message || e);

      mcReady = false;
    });

    reconnecting = false;

  } catch (e) {
    console.log("[MC] Connect error:", e?.message || e);

    reconnecting = false;

    reconnectLater();
  }
}

function reconnectLater() {
  if (reconnecting) return;

  reconnecting = true;

  console.log("[MC] Reconnect in 10s");

  setTimeout(() => {
    reconnecting = false;

    connectMC().catch(() => {});
  }, 10000);
}

/* ================== TAB ================== */

function tabComplete(text) {
  return new Promise((resolve, reject) => {

    if (!mc?._client) {
      return reject(new Error("client not ready"));
    }

    const timeout = setTimeout(() => {
      reject(new Error("tab timeout"));
    }, 4000);

    const handler = (packet) => {
      clearTimeout(timeout);

      try {
        resolve(
          packet.matches.map(x =>
            typeof x === "string"
              ? x
              : (x.match || x.text || "")
          )
        );
      } catch {
        resolve([]);
      }
    };

    mc._client.once("tab_complete", handler);
    mc._client.once("tab_complete_response", handler);

    try {
      mc._client.write("tab_complete", {
        text,
        assumeCommand: true,
        lookedAtBlock: {
          x: 0,
          y: 0,
          z: 0
        }
      });
    } catch (e) {
      clearTimeout(timeout);

      reject(e);
    }

  });
}

function cleanNick(n) {
  return String(n).replace(/[^A-Za-z0-9_]/g, "");
}

async function byPrefix(prefix) {
  const raw = await tabComplete(`/msg ${prefix}`);

  return raw
    .map(cleanNick)
    .filter(x => x.length >= 3 && x.length <= 16);
}

function prefixes() {
  const out = [];

  for (let i = 97; i <= 122; i++) {
    out.push(String.fromCharCode(i));
  }

  for (let i = 0; i <= 9; i++) {
    out.push(String(i));
  }

  out.push("_");

  return out;
}

async function collectAllPlayers() {
  const all = new Set();

  for (const p of prefixes()) {

    if (!mcReady) {
      throw new Error("mc not ready");
    }

    try {
      const arr = await byPrefix(p);

      arr.forEach(x => all.add(x));

    } catch {}

    await sleep(SCAN_DELAY_MS);
  }

  return [...all];
}

/* ================== AUTO SCAN ================== */

async function runAutoScan() {

  if (autoScanRunning) return;

  if (!mcReady) return;

  autoScanRunning = true;

  try {

    console.log("[AUTO] Scan started");

    const names = await collectAllPlayers();

    console.log(`[AUTO] Found ${names.length} players`);

    const ban = [];
    const review = [];

    for (const n of names) {
      const [s, r] = checkNick(n);

      if (s === "BAN") {
        ban.push(`${n} → ${r}`);
      }

      if (s === "REVIEW") {
        review.push(`${n} → ${r}`);
      }
    }

    if (ban.length || review.length) {

      let text = `🔎 Auto scan\n\n`;

      if (ban.length) {
        text += `❌ BAN (${ban.length})\n`;
        text += ban.join("\n");
        text += "\n\n";
      }

      if (review.length) {
        text += `⚠ REVIEW (${review.length})\n`;
        text += review.join("\n");
      }

      if (CHAT_ID) {
        await tg.telegram.sendMessage(CHAT_ID, text);
      }
    }

    console.log("[AUTO] Scan finished");

  } catch (e) {
    console.log("[AUTO] Error:", e?.message || e);
  }

  autoScanRunning = false;
}

setInterval(() => {
  if (AUTO_SCAN) {
    runAutoScan().catch(() => {});
  }
}, AUTO_SCAN_MINUTES * 60 * 1000);

/* ================== TG COMMANDS ================== */

tg.start((ctx) => {
  ctx.reply(
    "✅ Bot started\n\n" +
    "/status\n" +
    "/scan\n" +
    "/tab a"
  );
});

tg.command("status", (ctx) => {

  ctx.reply(
    `MC Ready: ${mcReady}\n` +
    `AutoScan: ${AUTO_SCAN}\n` +
    `Version: ${MC_VERSION || "auto"}`
  );
});

tg.command("scan", async (ctx) => {

  if (!mcReady) {
    return ctx.reply("MC not ready");
  }

  ctx.reply("🔎 Scanning...");

  try {

    const names = await collectAllPlayers();

    let out = `Found ${names.length} players\n\n`;

    for (const n of names.slice(0, 100)) {
      out += `${n}\n`;
    }

    ctx.reply(out);

  } catch (e) {
    ctx.reply("Error: " + (e?.message || e));
  }
});

tg.command("tab", async (ctx) => {

  if (!mcReady) {
    return ctx.reply("MC not ready");
  }

  const prefix = ctx.message.text.split(" ")[1] || "a";

  try {

    const res = await byPrefix(prefix);

    ctx.reply(
      `Prefix ${prefix}\n\n` +
      res.join("\n")
    );

  } catch (e) {
    ctx.reply("Error");
  }
});

/* ================== START ================== */

(async () => {

  await launchTelegramSafely();

  await connectMC();

  console.log("[SYSTEM] Started");

})();

/* ================== EXIT ================== */

process.once("SIGINT", () => {
  console.log("[SYSTEM] SIGINT");

  tg.stop("SIGINT");

  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("[SYSTEM] SIGTERM");

  tg.stop("SIGTERM");

  process.exit(0);
});
