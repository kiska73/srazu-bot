import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALERT_FILE = "./alerts.json";

// Telegram BOT token (Render ENV)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
if (!TG_BOT_TOKEN) {
    console.error("❌ TG_BOT_TOKEN missing in ENV");
    process.exit(1);
}

/* ================= FILE UTILS ================= */

function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        return JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
    } catch {
        return [];
    }
}

function saveAlerts(alerts) {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
}

/* ================= PRICE FETCH ================= */

async function getLastPrice(exchange, symbol) {
    try {
        if (exchange === "bybit") {
            const r = await fetch(
                `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
            );
            const j = await r.json();
            return Number(j?.result?.list?.[0]?.lastPrice || 0);
        }

        if (exchange === "binance") {
            const r = await fetch(
                `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
            );
            const j = await r.json();
            return Number(j?.price || 0);
        }
    } catch (e) {
        console.error("Price fetch error:", e.message);
    }
    return 0;
}

/* ================= TELEGRAM ================= */

async function sendTelegram(chatId, text) {
    try {
        const url =
            `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage` +
            `?chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(text)}`;

        const r = await fetch(url);
        const j = await r.json();
        return j.ok;
    } catch {
        return false;
    }
}

/* ================= ROUTES ================= */

// compatibile con la tua app
app.post("/add_alert", (req, res) => {
    const { device_id, exchange, symbol, price, chat_id } = req.body;

    if (!device_id || !exchange || !symbol || !price || !chat_id) {
        return res.status(400).json({ ok: false });
    }

    const alerts = loadAlerts();

    alerts.push({
        device_id,
        exchange: exchange.toLowerCase(),
        symbol: symbol.toUpperCase(),
        price: Number(price),
        chat_id,
        created: Date.now()
    });

    saveAlerts(alerts);
    console.log(`✅ ALERT ADDED ${symbol} @ ${price}`);
    res.json({ ok: true });
});

app.post("/remove_alert", (req, res) => {
    const { device_id, symbol, exchange } = req.body;

    let alerts = loadAlerts();
    const before = alerts.length;

    alerts = alerts.filter(
        a =>
            !(
                a.device_id === device_id &&
                a.symbol === symbol &&
                a.exchange === exchange
            )
    );

    if (alerts.length !== before) saveAlerts(alerts);
    res.json({ ok: true });
});

/* ================= ALERT LOOP ================= */

setInterval(async () => {
    let alerts = loadAlerts();
    if (!alerts.length) return;

    let changed = false;

    for (const alert of alerts) {
        const price = await getLastPrice(alert.exchange, alert.symbol);
        if (!price) continue;

        // trigger semplice (come vuoi tu)
        if (price >= alert.price || price <= alert.price) {
            console.log(`🎯 HIT ${alert.symbol} ${price}`);

            const tradeUrl =
                alert.exchange === "bybit"
                    ? `https://www.bybit.com/trade/usdt/${alert.symbol}`
                    : `https://www.binance.com/en/futures/${alert.symbol}`;

            const msg =
                `🚨 <b>PRICE ALERT</b>\n\n` +
                `<b>${alert.symbol}</b>\n` +
                `Target: ${alert.price}\n` +
                `Current: ${price}\n\n` +
                `<a href="${tradeUrl}">OPEN TRADE</a>`;

            const ok = await sendTelegram(alert.chat_id, msg);
            if (ok) {
                alert._done = true;
                changed = true;
            }
        }
    }

    if (changed) {
        alerts = alerts.filter(a => !a._done);
        saveAlerts(alerts);
    }
}, 5000);

/* ================= START ================= */

app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
    console.log(`📂 alerts.json → ${path.resolve(ALERT_FILE)}`);
});
