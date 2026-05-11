import { Telegraf, Markup } from 'telegraf';
import mineflayer from 'mineflayer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- ESM COMPATIBILITY ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const config = {
    tgToken: process.env.TELEGRAM_TOKEN || 'YOUR_TG_TOKEN',
    adminId: process.env.ADMIN_ID || 'YOUR_ID',
    mcHost: 'production.agerapvp.club',
    mcPort: 25565,
    mcUser: 'ModerBot_AI',
    mcPass: 'YOUR_PASS',
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
        const prompt = `Проверь никнейм "${nick}" на соответствие правилам (маты, оскорбления, нацизм). Ответь строго JSON: {"violation": true/false, "reason": "почему"}`;
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

    botMC.setMaxListeners(50);

    // Packet Overflow Protection
    botMC._client.on('packet', (data, meta) => {
        if (['map_chunk', 'sound_effect', 'multi_block_change'].includes(meta.name)) return;
    });

    botMC.on('login', () => {
        log('MC', 'Авторизован');
        isConnecting = false;
        setTimeout(() => {
            if (botMC?.chat) {
                botMC.chat(`/login ${config.mcPass}`);
                botMC.chat(`/register ${config.mcPass} ${config.mcPass}`);
            }
        }, 5000);
    });

    botMC.once('spawn', () => {
        log('MC', 'Бот в игре');
        mcReady = true;
        lastTabResponse = Date.now();
        startAutoScan();
        startWatchdog();
    });

    botMC.on('messagestr', (msg) => {
        if (msg.trim()) log('CHAT', msg);
        if (msg.includes('/login') || msg.includes('авторизуйтесь')) {
            botMC.chat(`/login ${config.mcPass}`);
        }
    });

    botMC.on('error', (err) => {
        log('MC-ERROR', err.message);
        scheduleReconnect();
    });

    botMC.on('end', (reason) => {
        log('MC-END', `Выход: ${reason}`);
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
                if (botMC) botMC.removeListener('tab_complete', onTab);
                resolve([]);
            }, config.tabTimeout);

            function onTab(matches) {
                clearTimeout(t);
                resolve(matches);
            }
            botMC.once('tab_complete', onTab);
            botMC.tabComplete('/msg '); 
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

            for (const word of rules.badWords) {
                if (norm.includes(word.toLowerCase())) {
                    violations.push({ nick, reason: `Фильтр: ${word}`, type: 'AUTO' });
                    bad = true;
                    break;
                }
            }

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
                    [Markup.button.callback('🤖 AI Анализ', 'scan_ai')]
                ])
            });
        }

    } catch (e) {
        log('SCAN-ERROR', e.message);
    } finally {
        isScanning = false;
    }
}

// --- WATCHDOG ---
function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
        if (mcReady) {
            if (Date.now() - lastTabResponse > (config.tabTimeout * 3)) {
                log('WATCHDOG', 'Детекция зависания. Реконнект...');
                scheduleReconnect();
            }
            if (Date.now() - lastScanTime > (config.scanInterval * 2)) {
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
    ctx.reply('🛡️ Модератор онлайн.', Markup.keyboard([
        ['🔍 Быстрый скан', '🤖 AI Скан'],
        ['📊 Статус', '🔄 Реконнект']
    ]).resize());
});

botTG.hears('🔍 Быстрый скан', (ctx) => {
    if (!mcReady) return ctx.reply('❌ Оффлайн');
    runScan(false);
    ctx.reply('🔎 Поиск по правилам...');
});

botTG.hears('🤖 AI Скан', (ctx) => {
    if (!mcReady) return ctx.reply('❌ Оффлайн');
    runScan(true);
    ctx.reply('🧠 AI Анализ запущен...');
});

botTG.hears('📊 Статус', (ctx) => {
    const status = mcReady ? '✅ Online' : '❌ Offline';
    ctx.reply(`<b>Система:</b>\n• MC: ${status}\n• Сканер: ${isScanning ? '🔄' : '💤'}`, { parse_mode: 'HTML' });
});

botTG.hears('🔄 Реконнект', (ctx) => {
    ctx.reply('⏳ Перезапуск...');
    scheduleReconnect();
});

botTG.action('scan_fast', (ctx) => runScan(false));
botTG.action('scan_ai', (ctx) => runScan(true));

// --- LIFECYCLE ---
process.on('uncaughtException', (err) => {
    log('CRITICAL', err.message);
    scheduleReconnect();
});

(async () => {
    try {
        await botTG.launch();
        log('TG', 'Telegram запущен');
        connectMC();
    } catch (e) {
        log('FATAL', e.message);
        setTimeout(() => process.exit(1), 10000);
    }
})();

setInterval(() => {
    if (!isConnecting && !mcReady && !reconnectTimer) connectMC();
}, 180000);
