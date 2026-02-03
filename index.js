const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// Configurazione percorsi: Usa /data solo se sei su Render e hai il disco
const ALERT_DIR = process.env.RENDER ? "/data" : ".";
const ALERT_FILE = `${ALERT_DIR}/alerts.json`;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

let alertsData = { active_alerts: [] };

// --- CARICAMENTO DATI ---
function loadData() {
    try {
        // Se la cartella /data non esiste (manca il Disk), la creiamo o usiamo quella locale
        if (process.env.RENDER && !fs.existsSync(ALERT_DIR)) {
            console.log("⚠️ Attenzione: Cartella /data non trovata. Usando memoria locale.");
        }

        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            console.log(`📂 Database caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 Nessun database trovato. Inizializzo file vuoto.");
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

// --- ROTTE DEL SERVER ---

// Pagina principale (Home)
app.get("/", (req, res) => {
    res.send("<h1>🚀 Srazu Crypto Bot è Online</h1><p>Status: <b>Funzionante</b></p><p>Vai su <a href='/debug'>/debug</a> per i dati.</p>");
});

// Pagina Debug
app.get("/debug", (req, res) => {
    res.json({
        server_time: new Date().toISOString(),
        total_tracked: alertsData.active_alerts.length,
        alerts: alertsData.active_alerts
    });
});

// Ricezione Alert dall'App
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId || !price) {
        return res.status(400).json({ error: "Mancano Token, ChatID o Prezzo" });
    }

    const cleanToken = token.trim();

    // Rimuove vecchi alert per lo stesso simbolo
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol.toUpperCase())
    );

    alertsData.active_alerts.push({
        device_id: device_id || "default",
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token: cleanToken,
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();
    console.log(`📌 Registrato alert per ${symbol} a ${price}`);
    res.json({ status: "ok", message: "Alert salvato correttamente" });
});

// --- LOGICA MONITORAGGIO PREZZI ---

async function fetchPrice(exchange, symbol) {
    try {
        const url = exchange.toLowerCase() === "binance" 
            ? `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
            : `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
        
        const r = await axios.get(url);
        
        if (exchange.toLowerCase() === "binance") {
            return parseFloat(r.data.price);
        } else {
            return parseFloat(r.data.result.list[0].lastPrice);
        }
    } catch (e) {
        return null;
    }
}

async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;

    let hasChanges = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await fetchPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        // Logica di incrocio prezzo
        const crossedUp = alert.lastPrice < alert.price && currentPrice >= alert.price;
        const crossedDown = alert.lastPrice > alert.price && currentPrice <= alert.price;

        if (crossedUp || crossedDown) {
            console.log(`🎯 Trigger! ${alert.symbol} ha toccato ${currentPrice}`);
            
            const text = `🚨 <b>ALERT PREZZO!</b>\n\n` +
                         `💎 <b>${alert.symbol}</b>\n` +
                         `🎯 Target: ${alert.price}\n` +
                         `💰 Prezzo attuale: ${currentPrice}\n` +
                         `🏛️ Exchange: ${alert.exchange.toUpperCase()}`;

            const sent = await sendTelegram(alert.token, alert.chatId, text);
            if (sent) {
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
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
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

// --- AVVIO ---
loadData();
setInterval(checkAlerts, 5000); // Controlla ogni 5 secondi

app.listen(PORT, () => {
    console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});
