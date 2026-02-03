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

// Middleware per file statici
app.use(express.static(__dirname));

let alertsData = { active_alerts: [] };

// Inizializzazione Dati
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            alertsData = JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
            console.log(`📂 Database caricato: ${alertsData.active_alerts.length} alert.`);
        } else {
            saveData();
        }
    } catch (e) {
        console.error("❌ Errore caricamento database:", e.message);
    }
}

function saveData() {
    try {
        if (process.env.RENDER && !fs.existsSync("/data")) {
            // Se non c'è il disco esterno, salva locale per non crashare
            fs.writeFileSync(path.join(__dirname, "alerts.json"), JSON.stringify(alertsData, null, 2));
        } else {
            fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
        }
    } catch (e) {
        console.error("❌ Errore salvataggio:", e.message);
    }
}

// --- ROTTE API ---
app.post("/set_alert", async (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;
    if (!token || !chatId) return res.status(400).json({ error: "Configurazione mancante" });

    const upperSymbol = symbol.toUpperCase();
    alertsData.active_alerts = alertsData.active_alerts.filter(a => !(a.device_id === device_id && a.symbol === upperSymbol));

    if (price) {
        alertsData.active_alerts.push({
            device_id, exchange, symbol: upperSymbol, price: parseFloat(price),
            token, chatId, triggered: false, lastPrice: null
        });
        
        // Conferma Telegram
        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `✅ <b>Alert Attivo</b>\n💰 ${upperSymbol} @ ${price}`,
                parse_mode: "HTML"
            });
        } catch (e) { console.log("Telegram error"); }
    }
    saveData();
    res.json({ status: "ok" });
});

app.get("/debug", (req, res) => res.json(alertsData));

// --- GESTIONE FRONTEND (FIX PERCORSI) ---
app.get("/", (req, res) => {
    const indexPath = path.join(__dirname, "index.html");
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("Errore: index.html non trovato nella root del server.");
    }
});

app.get("*", (req, res) => {
    const indexPath = path.join(__dirname, "index.html");
    if (!req.path.includes(".") && fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("File non trovato.");
    }
});

// --- LOGICA PREZZI ---
async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;
    let changed = false;

    for (let alert of alertsData.active_alerts) {
        try {
            const url = alert.exchange === "binance" 
                ? `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${alert.symbol}`
                : `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${alert.symbol}`;
            
            const r = await axios.get(url);
            const currentPrice = alert.exchange === "binance" ? parseFloat(r.data.price) : parseFloat(r.data.result.list[0].lastPrice);

            if (alert.lastPrice && ((alert.lastPrice < alert.price && currentPrice >= alert.price) || (alert.lastPrice > alert.price && currentPrice <= alert.price))) {
                await axios.post(`https://api.telegram.org/bot${alert.token}/sendMessage`, {
                    chat_id: alert.chatId,
                    text: `🚨 <b>TARGET!</b>\n${alert.symbol}: ${currentPrice}`,
                    parse_mode: "HTML"
                });
                alert.triggered = true;
                changed = true;
            }
            alert.lastPrice = currentPrice;
        } catch (e) { continue; }
    }
    if (changed) {
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

loadData();
setInterval(checkAlerts, 5000);
app.listen(PORT, () => console.log(`🚀 Server pronto sulla porta ${PORT}`));
