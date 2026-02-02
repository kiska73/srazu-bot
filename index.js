const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const ALERT_FILE = "./alerts.json";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

let alertsData = { active_alerts: [] };

// Carica alert salvati all'avvio
if (fs.existsSync(ALERT_FILE)) {
    alertsData = JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
}

// --- API PER LA TUA APP ---

// L'App chiama questo quando l'utente mette un alert
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId, direction } = req.body;

    // Rimuoviamo eventuali vecchi alert per la stessa coppia dello stesso utente
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );

    const newAlert = {
        device_id,
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token,
        chatId,
        direction, // "above" o "below"
        triggered: false
    };

    alertsData.active_alerts.push(newAlert);
    saveData();
    
    console.log(`📌 Nuovo alert ricevuto dall'App: ${symbol} a ${price} (${exchange})`);
    res.json({ status: "ok", message: "Alert impostato sul server" });
});

// L'App chiama questo quando l'utente rimuove un alert
app.post("/remove_alert", (req, res) => {
    const { device_id, symbol } = req.body;
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );
    saveData();
    res.json({ status: "ok" });
});

app.get("/", (req, res) => {
    res.send(`Server Attivo. Alert in monitoraggio: ${alertsData.active_alerts.filter(a => !a.triggered).length}`);
});

// --- LOGICA DI MONITORAGGIO ---

async function getPrice(exchange, symbol) {
    try {
        if (exchange === "binance") {
            const r = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            return parseFloat(r.data.price);
        } else {
            // Bybit
            const r = await axios.get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            return parseFloat(r.data.result.list[0].lastPrice);
        }
    } catch (e) {
        return null;
    }
}

async function checkLoop() {
    let changed = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await getPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        let hit = false;
        if (alert.direction === "above" && currentPrice >= alert.price) hit = true;
        if (alert.direction === "below" && currentPrice <= alert.price) hit = true;

        if (hit) {
            console.log(`🎯 TARGET! Invio messaggio a Telegram per ${alert.symbol}`);
            
            const msg = `🚨 <b>PRICE ALERT</b>\n\n` +
                        `<b>Coppia:</b> ${alert.symbol}\n` +
                        `<b>Prezzo raggiunto:</b> ${currentPrice}\n` +
                        `<b>Target:</b> ${alert.price}\n` +
                        `<b>Exchange:</b> ${alert.exchange.toUpperCase()}`;

            await sendTelegram(alert.token, alert.chatId, msg);
            alert.triggered = true;
            changed = true;
        }
    }

    if (changed) {
        // Rimuoviamo gli alert già scattati per non ingolfare il file
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

async function sendTelegram(token, chatId, text) {
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, { chat_id: chatId, text: text, parse_mode: "HTML" });
    } catch (e) {
        console.error("Errore invio Telegram:", e.message);
    }
}

function saveData() {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
}

// Avvio
setInterval(checkLoop, 5000);
app.listen(PORT, () => console.log(`Backend pronto sulla porta ${PORT}`));
