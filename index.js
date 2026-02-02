import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ALERT_FILE = "./alerts.json";

// Carica gli alert esistenti dal file
function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        const data = fs.readFileSync(ALERT_FILE, "utf8");
        return JSON.parse(data);
    } catch (e) {
        console.error("❌ Error reading alerts.json:", e.message);
        return [];
    }
}

// Salva gli alert aggiornati nel file
function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
        console.error("❌ Error saving alerts.json:", e.message);
    }
}

// Ottieni l'ultimo prezzo di mercato da Bybit o Binance
async function getLastPrice(exchange, symbol) {
    try {
        if (exchange === "bybit") {
            const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            const j = await r.json();
            if (j.result?.list?.[0]?.lastPrice) {
                return Number(j.result.list[0].lastPrice);
            }
        }
        if (exchange === "binance") {
            const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            const j = await r.json();
            if (j.price) {
                return Number(j.price);
            }
        }
    } catch (e) {
        console.error(`⚠️ Error fetching ${exchange} for ${symbol}:`, e.message);
    }
    return null;
}

// Funzione per inviare un messaggio Telegram
async function sendTelegram(token, chatId, text) {
    const baseUrl = `https://api.telegram.org/bot${token}`;
    try {
        const url = `${baseUrl}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`;
        const r = await fetch(url);
        const res = await r.json();
        if (!res.ok) throw new Error(res.description);
        return true;
    } catch (e) {
        console.error("❌ Error sending Telegram:", e.message);
        return false;
    }
}

// Endpoint per settare un alert
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, tgToken, tgChatId, direction } = req.body;
    
    // Controllo di validità input
    if (!tgToken || !tgChatId || !exchange || !symbol || !price || !direction) {
        return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    let alerts = loadAlerts();
    
    const newAlert = {
        device_id,
        exchange: exchange.toLowerCase(),
        symbol: symbol.toUpperCase(),
        price: Number(price),
        direction, // direction = "above" or "below"
        tgToken,
        tgChatId,
        triggered: false,
        created: Date.now()
    };

    alerts.push(newAlert);
    saveAlerts(alerts);
    
    console.log(`✅ Alert set: ${newAlert.symbol} at ${newAlert.price}, direction: ${newAlert.direction}`);
    res.json({ ok: true });
});

// Endpoint per rimuovere un alert
app.post("/remove_alert", (req, res) => {
    let alerts = loadAlerts();
    const initialCount = alerts.length;

    alerts = alerts.filter(a => 
        !(a.device_id === req.body.device_id && a.symbol === req.body.symbol && a.exchange === req.body.exchange)
    );

    if (alerts.length !== initialCount) {
        saveAlerts(alerts);
        console.log(`🗑️ Alert removed for ${req.body.symbol}`);
    }
    res.json({ ok: true });
});

// Funzione per controllare gli alert ogni 5 secondi
setInterval(async () => {
    let alerts = loadAlerts();
    if (alerts.length === 0) return;

    let changed = false;

    for (let alert of alerts) {
        if (alert.triggered) continue; // Se l'alert è già stato attivato, salta

        const currentPrice = await getLastPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        // Log per vedere i prezzi
        console.log(`[CHECK] ${alert.symbol} | target=${alert.price} | current=${currentPrice}`);

        // Verifica se il prezzo ha raggiunto il target (in base alla direction)
        const isHit =
            (alert.direction === "above" && currentPrice >= alert.price) ||
            (alert.direction === "below" && currentPrice <= alert.price);

        if (isHit) {
            console.log(`🎯 TARGET HIT: ${alert.symbol} at ${currentPrice}`);

            const exchangeUrl = alert.exchange === "bybit" 
                ? `https://www.bybit.com/trade/usdt/${alert.symbol}`
                : `https://www.binance.com/en/futures/${alert.symbol}`;

            const message = `🚨 <b>PRICE ALERT</b>\n\n` +
                          `<b>Asset:</b> ${alert.symbol}\n` +
                          `<b>Target:</b> ${alert.price}\n` +
                          `<b>Current Price:</b> ${currentPrice}\n` +
                          `<b>Exchange:</b> ${alert.exchange.toUpperCase()}\n\n` +
                          `<a href="${exchangeUrl}">👉 OPEN TRADE</a>`;

            const success = await sendTelegram(alert.tgToken, alert.tgChatId, message);
            
            if (success) {
                alert.triggered = true;
                changed = true;
            }
        }
    }

    // Se ci sono stati cambiamenti, aggiorna il file con gli alert non ancora attivati
    if (changed) {
        const remainingAlerts = alerts.filter(a => !a.triggered);
        saveAlerts(remainingAlerts);
        console.log("🧹 alerts.json updated and cleaned.");
    }
}, 5000);

// Avvia il server
app.listen(PORT, () => {
    console.log(`🚀 Alert Server running on port ${PORT}`);
    console.log(`📂 Alert file: ${path.resolve(ALERT_FILE)}`);
});
