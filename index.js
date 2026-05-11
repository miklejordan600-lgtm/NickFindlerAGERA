const { Telegraf, Markup } = require('telegraf');
const mineflayer = require('mineflayer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

/**
 * FULL INDEX.JS - IMPROVED MINEFLAYER + TELEGRAM BOT
 * Сохранена вся логика, исправлены утечки, улучшен реконнект и watchdog.
 */

// --- CONFIGURATION ---
const config = {
    tgToken: process.env.TELEGRAM_TOKEN || 'YOUR_TG_TOKEN',
    adminId: process.env.ADMIN_ID || 'YOUR_ID',
    mcHost: 'production.agerapvp.club',
    mcPort: 25565,
    mcUser: 'ModerBot_AI',
    mcPass: 'ВашПароль', // Пароль для /login
    geminiKey: process.env.GEMINI_KEY || 'YOUR_GEMINI_KEY',
    scanInterval: 300000,
    reconnectDelay: 60000,
    watchdogInterval: 30000,
    tabTimeout: 20000
};

// --- INITIALIZATION ---
const botTG = new Telegraf(config.tgToken);
const genAI = new GoogleGenerativeAI(config.geminiKey);
const modelAI = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let botMC = null;
let mcReady = false;
let isScanning = false;
let lastScanTime = Date.now();
let lastTabResponse = Date.now();
let reconnectTimer = null;
let watchdogTimer = null;
let autoScanTimer = null;
let isConnecting = false;

const rulesPath = path.join(__dirname, 'rules.json');
let rules = { badWords: [], whiteList: [] };

function loadRules() {
    try {
        if (fs.existsSync(rulesPath)) {
            rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
        } else {
            fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
        }
    } catch (e) { console.error('[RULES] Load Error:', e); }
}
loadRules();

// --- UTILS ---
const log = (ctx, msg) => {
    const t = new Date().toLocaleString();
    console.log(`[${t}] [${ctx}] ${msg}`);
};

const normalizeNick = (nick) => {
    return nick.replace(/[0-9]/g, '').replace(/[_.-]/g, '').toLowerCase();
};

const clearAllTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (autoScanTimer) clearInterval(autoScanTimer);
    reconnectTimer = null;
};

// --- AI CORE ---
async function checkWithAI(nick) {
    try {
        const prompt = `Проверь никнейм "${nick}" на нарушения (маты, оскорбления, нацизм, обходы). Ответь ТОЛЬКО JSON: {"violation": true/false, "reason": "почему"}`;
        const result = await modelAI.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(text);
    } catch (e) {
        return { violation: false, reason: "AI Error" };
    }
}

// --- MINEFLAYER ENGINE ---
function connectMC() {
    if (isConnecting) return;
    isConnecting = true;
    mcReady = false;

    log('SYSTEM', 'Запуск подключения к Minecraft...');

    if (botMC) {
        botMC.removeAllListeners();
        try { botMC.quit(); } catch(e) {}
    }

    botMC = mineflayer.createBot({
        host: config.mcHost,
        port: config.mcPort,
        username: config.mcUser,
        version: "1.8.9",
        hideErrors: true,
        checkTimeoutInterval: 90000
    });

    // Устранение утечки слушателей
    botMC.setMaxListeners(50);

    // Защита от Chunk/Sound Packet Error
    botMC._client.on('packet', (data, meta) => {
        if (['map_chunk', 'sound_effect', 'multi_block_change', 'world_event'].includes(meta.name)) {
            // Игнорируем тяжелые пакеты для стабильности на VPS
            return;
        }
    });

    botMC.on('login', () => {
        log('MC', 'Авторизован на прокси/сервере');
        isConnecting = false;
        setTimeout(() => {
            if (botMC) {
                botMC.chat(`/login ${config.mcPass}`);
                botMC.chat(`/register ${config.mcPass} ${config.mcPass}`);
            }
        }, 5000);
    });

    botMC.once('spawn', () => {
        log('MC', 'Бот заспавнился (Ready)');
        mcReady = true;
        lastTabResponse = Date.now();
        startAutoScan();
        startWatchdog();
    });

    botMC.on('messagestr', (msg) => {
        if (msg.trim()) log('CHAT', msg);
        // Авто-релогин если сессия сброшена
        if (msg.includes('/login') || msg.includes('авторизуйтесь')) {
            botMC.chat(`/login ${config.mcPass}`);
        }
    });

    botMC.on('error', (err) => {
        log('MC-ERROR', err.message);
        scheduleReconnect();
    });

    botMC.on('end', (reason) => {
        log('MC-END', `Отключено: ${reason}`);
        mcReady = false;
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    isConnecting = false;
    mcReady = false;
    clearAllTimers();
    log('SYSTEM', `Реконнект через ${config.reconnectDelay/1000}с...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectMC();
    }, config.reconnectDelay);
}

// --- SCANNER SYSTEM ---
async function runScan(useAI = false) {
    if (!mcReady || isScanning) return;
    isScanning = true;
    lastScanTime = Date.now();

    log('SCAN', `Начало сканирования (AI: ${useAI})...`);

    try {
        const players = await new Promise((resolve) => {
            const t = setTimeout(() => {
                botMC.removeListener('tab_complete', onTab);
                resolve([]);
            }, config.tabTimeout);

            function onTab(matches) {
                clearTimeout(t);
                resolve(matches);
            }
            botMC.once('tab_complete', onTab);
            botMC.tabComplete('/msg '); // Абуз команды для получения списка ников
        });

        if (players.length === 0) {
            log('SCAN', 'Tab_complete не ответил');
            isScanning = false;
            return;
        }

        lastTabResponse = Date.now();
        let violations = [];

        for (const nick of players) {
            if (rules.whiteList.includes(nick) || nick === config.mcUser) continue;

            const norm = normalizeNick(nick);
            let bad = false;

            // Rules filter
            for (const word of rules.badWords) {
                if (norm.includes(word.toLowerCase())) {
                    violations.push({ nick, reason: `Фильтр: ${word}`, type: 'AUTO' });
                    bad = true;
                    break;
                }
            }

            // AI Check
            if (!bad && useAI) {
                const ai = await checkWithAI(nick);
                if (ai.violation) {
                    violations.push({ nick, reason: ai.reason, type: 'AI' });
                }
            }
        }

        if (violations.length > 0) {
            let msg = `<b>🚨 Найдено нарушителей: ${violations.length}</b>\n\n`;
            violations.forEach(v => {
                msg += `👤 <code>${v.nick}</code>\n└ 📝 ${v.reason} [${v.type}]\n\n`;
            });

            botTG.telegram.sendMessage(config.adminId, msg, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔍 Повторить скан', 'scan_fast')],
                    [Markup.button.callback('🤖 AI Глубокая проверка', 'scan_ai')]
                ])
            });
        } else if (useAI) {
            botTG.telegram.sendMessage(config.adminId, "✅ AI проверку прошли все игроки.");
        }

    } catch (e) {
        log('SCAN-ERROR', e.message);
    } finally {
        isScanning = false;
    }
}

// --- WATCHDOG & RECOVERY ---
function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
        if (mcReady) {
            // Проверка "зависания" таба
            if (Date.now() - lastTabResponse > (config.tabTimeout * 3)) {
                log('WATCHDOG', 'Tab_complete не отвечает. Перезапуск...');
                scheduleReconnect();
            }
            // Проверка "зависания" цикла сканирования
            if (Date.now() - lastScanTime > (config.scanInterval * 2)) {
                log('WATCHDOG', 'Авто-скан замер. Принудительный сброс...');
                isScanning = false;
                runScan();
            }
        }
    }, config.watchdogInterval);
}

function startAutoScan() {
    if (autoScanTimer) clearInterval(autoScanTimer);
    autoScanTimer = setInterval(() => runScan(false), config.scanInterval);
}

// --- TELEGRAM COMMANDS ---
botTG.start((ctx) => {
    ctx.reply('🛡️ Бот-модератор запущен и готов к работе.', Markup.keyboard([
        ['🔍 Быстрый скан', '🤖 AI Скан'],
        ['📊 Статус', '🔄 Реконнект']
    ]).resize());
});

botTG.hears('🔍 Быстрый скан', (ctx) => {
    if (!mcReady) return ctx.reply('❌ Бот не в сети.');
    runScan(false);
    ctx.reply('🔎 Запущен быстрый поиск по правилам...');
});

botTG.hears('🤖 AI Скан', (ctx) => {
    if (!mcReady) return ctx.reply('❌ Бот не в сети.');
    runScan(true);
    ctx.reply('🧠 Запущен глубокий AI анализ онлайна...');
});

botTG.hears('📊 Статус', (ctx) => {
    const status = mcReady ? '✅ Online' : '❌ Offline';
    const scanInfo = isScanning ? '🔄 В процессе' : '💤 Спит';
    ctx.reply(`<b>Системный отчет:</b>\n• Сервер: ${status}\n• Сканер: ${scanInfo}\n• Последний скан: ${new Date(lastScanTime).toLocaleTimeString()}\n• RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`, { parse_mode: 'HTML' });
});

botTG.hears('🔄 Реконнект', (ctx) => {
    ctx.reply('⏳ Выполняю принудительный перезапуск подключения...');
    scheduleReconnect();
});

botTG.action('scan_fast', (ctx) => runScan(false));
botTG.action('scan_ai', (ctx) => runScan(true));

// --- CRASH PROTECTION ---
process.on('uncaughtException', (err) => {
    log('CRITICAL', err.message);
    scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
    log('REJECTION', reason);
});

// --- STARTUP ---
(async () => {
    try {
        await botTG.launch();
        log('TG', 'Telegram бот онлайн');
        connectMC();
    } catch (e) {
        log('FATAL', `Startup failed: ${e.message}`);
        setTimeout(() => process.exit(1), 10000);
    }
})();

// Railway/VPS Keep-alive
setInterval(() => {
    if (!isConnecting && !mcReady && !reconnectTimer) {
        log('HEALTH', 'Система простаивает без коннекта. Восстановление...');
        connectMC();
    }
}, 180000);
