const DEBUG_MODE = (process.env.DEBUG_MODE || "0") === "1";
const GEMINI_KEY = process.env.GEMINI_KEY;

// Webhook config - use env WEBHOOK_DOMAIN or default to Railway domain provided
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || "https://nickfindleragera-production.up.railway.app";
const PORT = Number(process.env.PORT || 3000);
const HOOK_PATH = process.env.HOOK_PATH || `/telegraf/${BOT_TOKEN}`;

console.log("[INIT] Environment variables loaded");
console.log("[INIT] BOT_TOKEN:", BOT_TOKEN ? "✓" : "✗");
console.log("[INIT] MC_HOST:", MC_HOST || "✗");
console.log("[INIT] MC_USER:", MC_USER || "✗");
console.log("[INIT] CHAT_ID:", CHAT_ID || "✗");
console.log("[INIT] WEBHOOK_DOMAIN:", WEBHOOK_DOMAIN || "(none)");
console.log("[INIT] PORT:", PORT);

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  console.error("[FATAL] Missing: BOT_TOKEN, MC_HOST, or MC_USER");
@@ -52,20 +59,48 @@

async function launchTelegramSafely() {
  let attempts = 0;
  // Prefer webhook if domain is set and PORT available
  const useWebhook = Boolean(WEBHOOK_DOMAIN && WEBHOOK_DOMAIN.startsWith("http"));

  while (true) {
    try {
      attempts++;
      console.log(`[TG] Launch attempt ${attempts}...`);
      await tg.launch({
        dropPendingUpdates: true,
        allowedUpdates: [],
      });
      console.log("[TG] ✓ Launched successfully");
      return;
      if (useWebhook) {
        console.log(`[TG] Launch attempt ${attempts} (webhook) ...`);
        // try webhook mode
        await tg.launch({
          webhook: {
            domain: WEBHOOK_DOMAIN,
            port: PORT,
            hookPath: HOOK_PATH,
          },
          dropPendingUpdates: true,
        });
        console.log("[TG] ✓ Launched successfully (webhook)");
        console.log(`[TG] Webhook URL: ${WEBHOOK_DOMAIN}${HOOK_PATH}`);
        return;
      } else {
        console.log(`[TG] Launch attempt ${attempts} (polling) ...`);
        await tg.launch({ dropPendingUpdates: true });
        console.log("[TG] ✓ Launched successfully (polling)");
        return;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      console.error("[TG] Launch failed:", msg);

      // If webhook failed twice, fallback to polling
      if (useWebhook && attempts >= 2) {
        console.warn("[TG] Webhook failed, falling back to polling mode");
        try {
          await tg.launch({ dropPendingUpdates: true });
          console.log("[TG] ✓ Launched successfully (polling fallback)");
          return;
        } catch (err) {
          console.error("[TG] Polling fallback failed:", err?.message || err);
        }
      }

      if (msg.includes("409") || msg.includes("Conflict")) {
        console.log("[TG] 409 conflict, waiting 15s...");
        await sleep(15000);
@@ -531,150 +566,151 @@
}

/* ================== TELEGRAM COMMANDS ================== */
// keep all existing commands and handlers
tg.start((ctx) => {
  ctx.reply("🚀 Bot started\n\n/tab <prefix> - manual scan\n/status - show status\n/reload - reload rules\n/scan - force auto scan");
});

tg.command("status", (ctx) => {
  const now = Date.now();
  ctx.reply([
    `<b>Status Report</b>`,
    `MC Online: ${mcOnline ? "✅" : "❌"}`,
    `MC Ready: ${mcReady ? "✅" : "❌"}`,
    `TAB Ready: ${tabReady ? "✅" : "❌"}`,
    `Tab failures: ${tabCompleteFailures}`,
    `Last scan: ${Math.round((now - lastAutoScanTime) / 1000)}s ago`,
    `Queue: ${tabCompleteQueue.length}`,
  ].join("\n"), { parse_mode: "HTML" });
});

tg.command("reload", (ctx) => {
  reloadRules();
  ctx.reply("✅ Rules reloaded");
});

tg.command("scan", async (ctx) => {
  if (!mcReady || !tabReady) {
    ctx.reply("❌ MC not ready");
    return;
  }
  ctx.reply("🔄 Scanning...");
  await performAutoScan();
  ctx.reply("✅ Scan completed");
});

tg.command("tab", async (ctx) => {
  try {
    const arg = ctx.message.text.split(" ").slice(1).join(" ");
    if (!arg) { ctx.reply("Usage: /tab <prefix>"); return; }
    if (!mcReady || !tabReady) { ctx.reply("❌ MC not ready"); return; }

    const names = await byPrefix(arg);
    let out = `🔎 Tab scan: <b>${arg}</b>\n\n`;
    if (names.length === 0) {
      out += "No players found";
    } else {
      for (const n of names) {
        const [s, reasons] = checkNick(n);
        const emoji = s === "BAN" ? "🚫" : s === "REVIEW" ? "⚠️" : "✅";
        out += `${emoji} <code>${n}</code> - ${s}\n`;
        if (reasons.length > 0) out += `    ${reasons.join(" | ")}\n`;
      }
    }
    ctx.reply(out, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("❌ ERR: " + String(e?.message || e));
  }
});

tg.command("connect", (ctx) => {
  if (!connecting && !mcReady) {
    ctx.reply("🔄 Connecting...");
    connectMC();
  } else {
    ctx.reply("Already connecting or ready");
  }
});

/* ================== WATCHDOG ================== */
function startWatchdog() {
  const interval = setInterval(() => {
    const now = Date.now();
    if (mcOnline && (!mcReady || !tabReady) && !connecting) {
      console.log("[WATCHDOG] Online but not ready");
      scheduleReconnect("watchdog_not_ready");
    }
    if (mcReady && tabReady && (now - lastTabCompleteTime > 120000) && tabCompleteFailures > 5) {
      console.log("[WATCHDOG] Tab inactive");
      scheduleReconnect("watchdog_tab_inactive");
    }
    if (AUTO_SCAN && mcReady && tabReady && (now - lastAutoScanTime > (AUTO_SCAN_MINUTES * 60000 + 30000))) {
      console.log("[WATCHDOG] Auto scan overdue");
      performAutoScan();
    }
    if (mcOnline && (now - lastHeartbeat > 45000)) {
      console.log("[WATCHDOG] Heartbeat timeout");
      scheduleReconnect("watchdog_heartbeat");
    }
  }, 20000);
  addTimer(interval);
}

/* ================== GRACEFUL SHUTDOWN ================== */
async function gracefulShutdown() {
  console.log("[SHUTDOWN] Starting graceful shutdown...");
  stopHeartbeat();
  clearAllTimers();
  clearAllListeners();
  if (mc) {
    try { mc.quit("shutdown"); } catch {}
    try { mc.end(); } catch {}
  }
  try { await tg.stop("shutdown"); } catch {}
  console.log("[SHUTDOWN] Complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown());
process.on("SIGTERM", () => gracefulShutdown());
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
  gracefulShutdown();
});

/* ================== MAIN STARTUP ================== */
async function main() {
  try {
    console.log("[MAIN] Starting main sequence...");
    loadRules();

    console.log("[MAIN] Launching Telegram...");
    await launchTelegramSafely();

    console.log("[MAIN] Connecting to Minecraft...");
    connectMC();

    await sleep(STARTUP_SCAN_DELAY_MS);

    if (AUTO_SCAN && mcReady && tabReady) {
      console.log("[MAIN] Performing initial scan...");
      await performAutoScan();
    }

    startWatchdog();

    if (AUTO_SCAN) {
      const scanInterval = setInterval(() => {
        if (mcReady && tabReady && !connecting) performAutoScan();
      }, AUTO_SCAN_MINUTES * 60000);
      addTimer(scanInterval);
    }

    console.log("[MAIN] ✓ Bot is running!");
  } catch (e) {
    console.error("[MAIN] Fatal error:", e?.message || e);
    process.exit(1);
  }
}

main();
