const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// Configurazione Percorso File (Usa il Volume /data su Render o cartella locale)
const ALERT_FILE = process.env.RENDER ? "/data/alerts.json" : "./alerts.json";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

let alertsData = { active_alerts: [] };

// --- CARICAMENTO DATI ---
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            const raw = fs.readFileSync(ALERT_FILE, "utf8");
            alertsData = JSON.parse(raw);
            // Assicuriamoci che la struttura sia corretta
            if (!alertsData.active_alerts) alertsData.active_alerts = [];
            console.log(`📂 Database caricato. Alert attivi: ${alertsData.active_alerts.length}`);
        } else {
            console.log("🆕 File JSON non trovato. Ne verrà creato uno al primo alert.");
            saveData();
        }
    } catch (e) {
        console.error("❌ Errore inizializzazione JSON:", e.message);
        alertsData = { active_alerts: [] };
    }
}

// --- FUNZIONE DI SALVATAGGIO ---
function saveData() {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    } catch (e) {
        console.error("❌ Errore scrittura su disco:", e.message);
    }
}

// --- API PER L'APP FRONTEND ---

// Endpoint per ricevere nuovi alert
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId) {
        console.log("⚠️ Alert ricevuto ma mancano Token o ChatID. Controlla le impostazioni dell'App.");
        return res.status(400).json({ error: "Dati Telegram mancanti" });
    }

    // Pulizia Token da spazi bianchi o invii
    const cleanToken = token.trim().replace(/\s/g, "");

    // Rimuove vecchi alert identici dello stesso utente
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );

    // Aggiunta nuovo alert
    alertsData.active_alerts.push({
        device_id: device_id || "unknown",
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token: cleanToken,
        chatId: chatId,
        triggered: false,
        lastPrice: null
    });

    saveData();
    console.log(`📌 NUOVO ALERT: ${symbol} a ${price} (Via ${exchange})`);
    res.json({ status: "success", message: "Alert registrato sul server" });
});

// Endpoint per rimuovere alert
app.post("/remove_alert", (req, res) => {
    const { device_id, symbol } = req.body;
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );
    saveData();
    console.log(`🗑️ Rimosso alert per: ${symbol}`);
    res.json({ status: "success" });
});

// --- DEBUG & MONITORAGGIO (Vedi il JSON dal browser) ---
app.get("/debug", (req, res) => {
    res.json({
        uptime: process.uptime(),
        total_tracked: alertsData.active_alerts.length,
        alerts: alertsData.active_alerts
    });
});

app.get("/", (req, res) => res.send("🤖 Srazu Bot Server is RUNNING."));

// --- LOGICA MONITORAGGIO PREZZI ---

async function fetchPrice(exchange, symbol) {
    try {
        if (exchange.toLowerCase() === "binance") {
            const r = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            return parseFloat(r.data.price);
        } else {
            // Default Bybit
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

        // Se è la prima volta che leggiamo il prezzo, lo salviamo e passiamo al prossimo
        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        let crossed = false;
        // Prezzo sale sopra il target
        if (alert.lastPrice < alert.price && currentPrice >= alert.price) crossed = true;
        // Prezzo scende sotto il target
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

    // Pulizia database: eliminiamo quelli già inviati
    if (hasChanged) {
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

async function sendTelegram(token, chatId, text) {
    try {
        // Se il token non è valido, l'URL risponderà 404 (Not Found)
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML"
        });
        console.log("✅ Notifica Telegram inviata!");
        return true;
    } catch (e) {
        if (e.response && e.response.status === 404) {
            console.error("❌ ERRORE 404: Token Telegram non esistente. Verificalo!");
        } else {
            console.error("❌ Errore invio Telegram:", e.response ? e.response.data : e.message);
        }
        return false;
    }
}

// --- AVVIO SERVER ---
loadData();
setInterval(checkAlerts, 5000); // Controlla ogni 5 secondi

app.listen(PORT, () => {
    console.log(`🚀 Server pronto sulla porta ${PORT}`);
});
