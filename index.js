import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALERT_FILE = "./alerts.json";

/* =====================================================
   FILE UTILS
===================================================== */
function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        return JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
    } catch (e) {
        console.error("Read alerts error:", e.message);
        return [];
    }
}

function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
        console.error("Save alerts error:", e.message);
    }
}

/* =====================================================
   PRICE FETCH
===================================================== */
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

/* =====================================================
   TELEGRAM
===================================================== */
async function sendTelegram(chatId, text, botToken) {
    if (!botToken) {
        console.error("🚨 Bot token missing in JSON!");
        return false;
    }

    try {
        const url =
            `https://api.telegram.org/bot${botToken}/sendMessage` +
            `?chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(text)}`;

        const r = await fetch(url);
        const j = await r.json();
        if (!j.ok) throw new Error(j.description);
        return true;
    } catch (e) {
        console.error("Telegram error:", e.message);
        return false;
    }
}

/* =====================================================
   ROUTES
===================================================== */
app.post("/add_alert", (req, res) => {
    const { device_id, exchange, symbol, price, chat_id, bot_token } = req.body;

    if (!device_id || !exchange || !symbol || !price || !chat_id || !bot_token) {
        return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const alerts = loadAlerts();

    alerts.push({
        device_id,
        exchange: exchange.toLowerCase(),
        symbol: symbol.toUpperCase(),
        price: Number(price),
        chat_id,
        bot_token,   // ✅ token preso dal JSON
        created: Date.now()
    });

    saveAlerts(alerts);

    console.log(`✅ ALERT ADDED | ${symbol} @ ${price}`);
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

    if (alerts.length !== before) {
        saveAlerts(alerts);
        console.log(`🗑️ ALERT REMOVED | ${symbol}`);
    }

    res.json({ ok: true });
});

/* =====================================================
   ALERT LOOP
===================================================== */
setInterval(async () => {
    let alerts = loadAlerts();
    if (!alerts.length) return;

    let changed = false;

    for (const alert of alerts) {
        const price = await getLastPrice(alert.exchange, alert.symbol);
        if (!price) continue;

        if (price >= alert.price || price <= alert.price) {
            console.log(`🎯 TARGET HIT | ${alert.symbol} @ ${price}`);

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

            const ok = await sendTelegram(alert.chat_id, msg, alert.bot_token);
            if (ok) {
                alert._done = true;
                changed = true;
            }
        }
    }

    if (changed) {
        alerts = alerts.filter(a => !a._done);
        saveAlerts(alerts);
        console.log("🧹 alerts.json cleaned");
    }
}, 5000);

/* =====================================================
   START SERVER
===================================================== */
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📂 Alert file: ${path.resolve(ALERT_FILE)}`);
});
