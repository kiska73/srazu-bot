const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURAZIONE PORTE E PERCORSI ---
// Render assegna automaticamente una porta, noi usiamo quella o la 10000 di default
const PORT = process.env.PORT || 10000; 

// Percorso per il database JSON (usa il Volume /data se presente su Render)
const ALERT_DIR = process.env.RENDER ? "/data" : ".";
const ALERT_FILE = path.join(ALERT_DIR, "alerts.json");

// 1. SERVI I FILE STATICI: Questo carica la tua App (index.html, app.js) dalla cartella /public
app.use(express.static(path.join(__dirname, "public")));

let alertsData = { active_alerts: [] };

// --- CARICAMENTO DATI ---
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            console.log(`📂 Database caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 Nessun database trovato. Ne creo uno nuovo.");
            saveData();
        }
    } catch (e) {
        console.error("❌ Errore caricamento JSON:", e.message);
        alertsData = { active_alerts: [] };
    }
}

// --- SALVATAGGIO DATI ---
function saveData() {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    } catch (e) {
        console.error("❌ Errore scrittura file:", e.message);
    }
}

// --- ROTTE API ---

// Debug per vedere cosa sta succedendo nel server
app.get("/debug", (req, res) => {
    res.json({
        status: "online",
        server_time: new Date().toISOString(),
        total_tracked: alertsData.active_alerts.length,
        alerts: alertsData.active_alerts
    });
});

// Ricezione alert dall'App
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId || !price) {
        return res.status(400).json({ error: "Dati mancanti (Token, ChatID o Prezzo)" });
    }

    const cleanToken = token.trim();

    // Rimuove vecchi alert per lo stesso simbolo per evitare doppioni
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol.toUpperCase())
    );

    alertsData.active_alerts.push({
        device_id: device_id || "web-user",
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token: cleanToken,
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();
    console.log(`📌 Alert registrato: ${symbol} @ ${price}`);
    res.json({ status: "success", message: "Alert impostato correttamente" });
});

// --- LOGICA MONITORAGGIO ---

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

    let hasChanges = false;

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
            console.log(`🎯 TARGET! ${alert.symbol} a ${currentPrice}`);
            
            const text = `🔔 <b>TARGET RAGGIUNTO!</b>\n\n` +
                         `📈 <b>${alert.symbol}</b>\n` +
                         `🎯 Prezzo Target: ${alert.price}\n` +
                         `💰 Prezzo Attuale: ${currentPrice}\n` +
                         `🏛️ Exchange: ${alert.exchange.toUpperCase()}`;

            const success = await sendTelegram(alert.token, alert.chatId, text);
            if (success) {
                alert.triggered = true;
                hasChanges = true;
            }
        }
        alert.lastPrice = currentPrice;
    }

    if (hasChanges) {
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
        console.error("❌ Errore Telegram:", e.response ? e.response.status : e.message);
        return false;
    }
}

// 2. CATCH-ALL: Gestisce il refresh delle pagine e i link diretti
app.get("*", (req, res) => {
    if (!req.path.startsWith("/debug") && !req.path.startsWith("/set_alert")) {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    }
});

// --- AVVIO ---
loadData();
setInterval(checkAlerts, 5000); // Ogni 5 secondi

app.listen(PORT, () => {
    console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});
