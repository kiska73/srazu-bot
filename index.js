const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// Configurazione Porte e Percorsi
const PORT = process.env.PORT || 10000;
const ALERT_FILE = process.env.RENDER ? "/data/alerts.json" : "./alerts.json";

const app = express();
app.use(cors());
app.use(express.json());

// === GESTIONE FILE STATICI ===
// Questo comando dice al server di cercare index.html nella cartella principale
app.use(express.static(__dirname));

let alertsData = { active_alerts: [] };

// --- CARICAMENTO DATI ---
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            console.log(`📂 Database caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 Database non trovato, inizializzo...");
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
        console.error("❌ Errore scrittura file:", e.message);
    }
}

// --- API ROUTES ---

// Impostazione Alert
app.post("/set_alert", async (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId) {
        return res.status(400).json({ error: "Dati mancanti (Token o ChatID)" });
    }

    const cleanToken = token.trim();
    const upperSymbol = symbol.toUpperCase();

    // Rimuove vecchi alert per evitare doppioni
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === upperSymbol)
    );

    if (price !== null && price !== undefined) {
        alertsData.active_alerts.push({
            device_id: device_id || "web",
            exchange: exchange || "bybit",
            symbol: upperSymbol,
            price: parseFloat(price),
            token: cleanToken,
            chatId: chatId,
            triggered: false,
            lastPrice: null
        });

        // Invio conferma immediata su Telegram
        const confirmText = `✅ <b>ALERT ATTIVATO</b>\n\n` +
                            `🪙 <b>Coppia:</b> ${upperSymbol}\n` +
                            `🎯 <b>Target:</b> ${price}\n` +
                            `🏛️ <b>Exchange:</b> ${exchange.toUpperCase()}`;
        
        try {
            await axios.post(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
                chat_id: chatId,
                text: confirmText,
                parse_mode: "HTML"
            });
        } catch (err) {
            console.error("Errore Telegram conferma:", err.message);
        }
    }

    saveData();
    res.json({ status: "ok" });
});

// Debug
app.get("/debug", (req, res) => {
    res.json({
        status: "online",
        alerts: alertsData.active_alerts
    });
});

// Serve l'App (index.html)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Catch-all per evitare il "Not Found" al refresh
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- LOGICA DI CONTROLLO PREZZI ---

async function fetchPrice(exchange, symbol) {
    try {
        const url = exchange.toLowerCase() === "binance" 
            ? `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
            : `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
        
        const r = await axios.get(url);
        return exchange.toLowerCase() === "binance" 
            ? parseFloat(r.data.price) 
            : parseFloat(r.data.result.list[0].lastPrice);
    } catch (e) {
        return null;
    }
}

async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;

    let changed = false;
    for (let alert of alertsData.active_alerts) {
        const currentPrice = await fetchPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        const crossedUp = alert.lastPrice < alert.price && currentPrice >= alert.price;
        const crossedDown = alert.lastPrice > alert.price && currentPrice <= alert.price;

        if (crossedUp || crossedDown) {
            const text = `🚨 <b>PRICE ALERT!</b>\n\n` +
                         `💎 <b>${alert.symbol}</b>\n` +
                         `🎯 Target: ${alert.price}\n` +
                         `💰 Prezzo attuale: ${currentPrice}`;

            const sent = await sendTelegram(alert.token, alert.chatId, text);
            if (sent) {
                alert.triggered = true;
                changed = true;
            }
        }
        alert.lastPrice = currentPrice;
    }

    if (changed) {
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
        return true;
    } catch (e) {
        return false;
    }
}

// Avvio
loadData();
setInterval(checkAlerts, 5000);

app.listen(PORT, () => {
    console.log(`🚀 Server attivo su porta ${PORT}`);
});
