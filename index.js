const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ALERT_FILE = process.env.RENDER ? "/data/alerts.json" : path.join(__dirname, "alerts.json");

let alertsData = { active_alerts: [] };

// Carica dati all'avvio
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            alertsData = JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
            if (!alertsData.active_alerts) alertsData.active_alerts = [];
            console.log(`📂 Database caricato: ${alertsData.active_alerts.length} alert.`);
        } else {
            console.log("🆕 File alerts.json non trovato. Creazione nuovo.");
            saveData();
        }
    } catch (e) {
        console.error("❌ Errore caricamento:", e.message);
        alertsData = { active_alerts: [] };
    }
}

function saveData() {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    } catch (e) {
        console.error("❌ Errore salvataggio:", e.message);
    }
}

loadData();

// === API ROUTES ===
app.post("/set_alert", async (req, res) => {
    const { device_id, exchange, symbol, alert_price, sync_price, token, chatId } = req.body;

    if (!token || !chatId) {
        return res.status(400).json({ error: "Configurazione Telegram mancante" });
    }

    const cleanToken = token.trim();
    const upperSymbol = symbol.toUpperCase();
    const lowerExchange = (exchange || "bybit").toLowerCase();

    // Rimuovi alert vecchi per stessa coppia e device
    alertsData.active_alerts = alertsData.active_alerts.filter(a =>
        !(a.device_id === device_id && a.symbol === upperSymbol)
    );

    if (alert_price === null || alert_price === undefined || alert_price === 0) {
        saveData();
        return res.json({ status: "removed" });
    }

    // Aggiungi nuovo alert
    alertsData.active_alerts.push({
        device_id: device_id || "unknown",
        exchange: lowerExchange,
        symbol: upperSymbol,
        alert_price: parseFloat(alert_price),      // per controllo scatto
        sync_price: parseFloat(sync_price || alert_price), // per messaggio "approaching level"
        token: cleanToken,
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();

    // Conferma Telegram (usa sync_price se disponibile)
    const confirmPrice = sync_price ? parseFloat(sync_price) : parseFloat(alert_price);
    const confirmText = `✅ <b>Alert Activated</b>\n\n` +
                        `<b>Pair:</b> ${upperSymbol}\n` +
                        `<b>Approach level:</b> ${confirmPrice}\n` +
                        `<b>Exchange:</b> ${lowerExchange.toUpperCase()}`;

    try {
        await axios.post(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
            chat_id: chatId,
            text: confirmText,
            parse_mode: "HTML"
        });
    } catch (e) {
        console.error("❌ Errore conferma Telegram:", e.response?.data || e.message);
    }

    res.json({ status: "ok" });
});

app.get("/debug", (req, res) => res.json(alertsData));

app.get("/", (req, res) => res.send("Backend running – Legge, monitora e messaggia alert."));

// === LOGICA MONITORAGGIO PREZZI ===
async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;

    let changed = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        try {
            const url = alert.exchange === "binance"
                ? `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${alert.symbol}`
                : `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${alert.symbol}`;

            const r = await axios.get(url);
            const currentPrice = alert.exchange === "binance"
                ? parseFloat(r.data.price)
                : parseFloat(r.data.result.list[0].lastPrice);

            if (alert.lastPrice !== null) {
                const crossed = (alert.lastPrice < alert.alert_price && currentPrice >= alert.alert_price) ||
                                (alert.lastPrice > alert.alert_price && currentPrice <= alert.alert_price);

                if (crossed) {
                    const precision = currentPrice < 1 ? 6 : 2;

                    // Messaggio con "approaching level" + valore sync_price
                    const text = `🚨 <b>${alert.symbol} approaching level!</b>\n\n` +
                                 `<b>Level:</b> $${alert.sync_price.toFixed(precision)}\n` +
                                 `<b>Current price:</b> $${currentPrice.toFixed(precision)}\n` +
                                 `<b>Exchange:</b> ${alert.exchange.toUpperCase()}\n\n` +
                                 `Apri in app:`;

                    // Deep link + fallback web
                    let link = "";
                    if (alert.exchange === "bybit") {
                        link = `https://www.bybit.com/trade/usdt/${alert.symbol}`; // apre app Bybit se installata
                    } else if (alert.exchange === "binance") {
                        link = `https://www.binance.com/en/futures/${alert.symbol}`; // apre app Binance Futures se installata
                    }

                    const fullText = text + `\n<a href="${link}">📱 Apri ${alert.exchange.toUpperCase()} app</a>`;

                    await axios.post(`https://api.telegram.org/bot${alert.token}/sendMessage`, {
                        chat_id: alert.chatId,
                        text: fullText,
                        parse_mode: "HTML",
                        disable_web_page_preview: true
                    });

                    alert.triggered = true;
                    changed = true;
                }
            }

            alert.lastPrice = currentPrice;
        } catch (e) {
            console.error(`Errore prezzo ${alert.symbol}:`, e.message);
        }
    }

    if (changed) {
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

setInterval(checkAlerts, 5000);

app.listen(PORT, () => {
    console.log(`🚀 Server pronto sulla porta ${PORT}`);
});
