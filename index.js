const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// Configurazione Percorsi (Usa il Volume /data se presente, altrimenti locale)
const ALERT_FILE = process.env.RENDER ? "/data/alerts.json" : "./alerts.json";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

let alertsData = { active_alerts: [] };

// --- CARICAMENTO INIZIALE ---
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            console.log(`📂 JSON caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 Nessun file JSON trovato, ne verrà creato uno nuovo.");
        }
    } catch (e) {
        console.error("❌ Errore lettura JSON:", e.message);
    }
}
loadData();

// --- API PER L'APP (FRONTEND) ---

app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    // Pulizia: Rimuove vecchi alert per lo stesso simbolo dello stesso utente
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );

    alertsData.active_alerts.push({
        device_id,
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token: token.trim(), // Puliamo il token da spazi
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();
    console.log(`📌 Alert impostato dall'App: ${symbol} @ ${price}`);
    res.json({ status: "success" });
});

app.post("/remove_alert", (req, res) => {
    const { device_id, symbol } = req.body;
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );
    saveData();
    console.log(`🗑️ Alert rimosso: ${symbol}`);
    res.json({ status: "removed" });
});

// --- VISUALIZZAZIONE JSON (Per te) ---
app.get("/check", (req, res) => {
    res.json({
        server_status: "running",
        alerts_count: alertsData.active_alerts.length,
        database: alertsData.active_alerts
    });
});

app.get("/", (req, res) => res.send("🚀 Srazu Backend is Live!"));

// --- LOGICA MONITORAGGIO ---

async function fetchPrice(exchange, symbol) {
    try {
        if (exchange.toLowerCase() === "binance") {
            const r = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            return parseFloat(r.data.price);
        } else {
            const r = await axios.get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            return parseFloat(r.data.result.list[0].lastPrice);
        }
    } catch (e) { return null; }
}

async function checkLoop() {
    if (alertsData.active_alerts.length === 0) return;

    let changed = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await fetchPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        // Inizializza il lastPrice se è la prima volta
        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        let isHit = false;
        // Check incrocio verso l'alto o verso il basso
        if ((alert.lastPrice < alert.price && currentPrice >= alert.price) ||
            (alert.lastPrice > alert.price && currentPrice <= alert.price)) {
            isHit = true;
        }

        alert.lastPrice = currentPrice;

        if (isHit) {
            console.log(`🎯 TARGET RAGGIUNTO: ${alert.symbol}`);
            const msg = `🚨 <b>PRICE ALERT</b>\n\n` +
                        `<b>Coppia:</b> ${alert.symbol}\n` +
                        `<b>Prezzo:</b> ${currentPrice}\n` +
                        `<b>Target:</b> ${alert.price}\n` +
                        `<b>Exchange:</b> ${alert.exchange.toUpperCase()}`;

            const success = await sendTelegram(alert.token, alert.chatId, msg);
            if (success) {
                alert.triggered = true;
                changed = true;
            }
        }
    }

    if (changed) {
        // Pulizia: teniamo solo quelli non ancora scattati
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
        console.error(`❌ Telegram Error: ${e.response ? e.response.statusText : e.message}`);
        return false;
    }
}

function saveData() {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    } catch (e) {
        console.error("❌ Errore salvataggio:", e.message);
    }
}

// Avvio Loop (Ogni 5 secondi)
setInterval(checkLoop, 5000);

app.listen(PORT, () => console.log(`🚀 Server pronto sulla porta ${PORT}`));
