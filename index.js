const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const ALERT_FILE = process.env.RENDER ? "/data/alerts.json" : "./alerts.json";
const PORT = process.env.PORT || 10000;  // Trucco per forzare redeploy su Render

const app = express();
app.use(cors());
app.use(express.json());

// === DICHIARAZIONE alertsData PRIMA DELLE ROUTE ===
let alertsData = { active_alerts: [] };

// Carica i dati all'avvio (prima delle route)
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            if (!alertsData.active_alerts) alertsData.active_alerts = [];
            console.log(`📂 Database caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 File JSON non trovato. Creazione nuovo.");
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

loadData();  // Carica subito i dati esistenti

// === SERVING FILE STATICI (frontend) ===
app.use(express.static(path.join(__dirname, 'public')));

// === API ROUTES ===
app.post("/set_alert", async (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId) {
        return res.status(400).json({ error: "Token o ChatID mancanti" });
    }

    const cleanToken = token.trim().replace(/\s/g, "");
    const upperSymbol = symbol.toUpperCase();

    // Rimuove alert vecchi dello stesso device/symbol
    alertsData.active_alerts = alertsData.active_alerts.filter(a =>
        !(a.device_id === device_id && a.symbol === upperSymbol)
    );

    if (price === null || price === undefined) {
        saveData();
        console.log(`🗑️ Alert rimosso: ${upperSymbol}`);
        return res.json({ status: "removed" });
    }

    alertsData.active_alerts.push({
        device_id: device_id || "unknown",
        exchange: exchange || "bybit",
        symbol: upperSymbol,
        price: parseFloat(price),
        token: cleanToken,
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();
    console.log(`📌 Alert impostato: ${upperSymbol} a ${price}`);

    // Messaggio di conferma "ALERT ATTIVATO"
    const confirmText = `✅ <b>ALERT ATTIVATO</b>\n\n` +
                        `<b>Coppia:</b> ${upperSymbol}\n` +
                        `<b>Target price:</b> ${parseFloat(price)}\n` +
                        `<b>Exchange:</b> ${exchange.toUpperCase()}`;

    try {
        await axios.post(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
            chat_id: chatId,
            text: confirmText,
            parse_mode: "HTML"
        });
        console.log("✅ Conferma Telegram inviata");
    } catch (e) {
        console.error("❌ Errore conferma Telegram:", e.response?.data || e.message);
    }

    res.json({ status: "success", message: "Alert registrato" });
});

app.get("/debug", (req, res) => res.json(alertsData));

// Root route serve index.html
app.get("/", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Catch-all per SPA (refresh pagine senza 404)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === FUNZIONI HELPER ===
async function fetchPrice(exchange, symbol) {
    try {
        if (exchange.toLowerCase() === "binance") {
            const r = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            return parseFloat(r.data.price);
        } else {
            const r = await axios.get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            return parseFloat(r.data.result.list[0].lastPrice);
        }
    } catch (e) {
        return null;
    }
}

async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;

    let hasChanged = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await fetchPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        let crossed = false;
        if (alert.lastPrice < alert.price && currentPrice >= alert.price) crossed = true;
        if (alert.lastPrice > alert.price && currentPrice <= alert.price) crossed = true;

        alert.lastPrice = currentPrice;

        if (crossed) {
            console.log(`🎯 TARGET RAGGIUNTO: ${alert.symbol} @ ${currentPrice}`);

            const text = `🚨 <b>PRICE ALERT!</b>\n\n` +
                         `<b>Coppia:</b> ${alert.symbol}\n` +
                         `<b>Target:</b> ${alert.price}\n` +
                         `<b>Prezzo Attuale:</b> ${currentPrice}\n` +
                         `<b>Exchange:</b> ${alert.exchange.toUpperCase()}`;

            const success = await sendTelegram(alert.token, alert.chatId, text);
            if (success) {
                alert.triggered = true;
                hasChanged = true;
            }
        }
    }

    if (hasChanged) {
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

async function sendTelegram(token, chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML"
        });
        console.log("✅ Alert Telegram inviato");
        return true;
    } catch (e) {
        console.error("❌ Errore Telegram:", e.response?.data || e.message);
        return false;
    }
}

// === AVVIO ===
setInterval(checkAlerts, 5000);

app.listen(PORT, () => {
    console.log(`🚀 Server attivo su porta ${PORT}`);
});
