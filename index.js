const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// Configurazione Percorsi: Usa il volume /data se presente, altrimenti locale
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
            if (!alertsData.active_alerts) alertsData.active_alerts = [];
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

// --- API PER L'APP ---

app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    if (!token || !chatId || !price) {
        console.error("⚠️ Ricevuta richiesta incompleta. Token o Price mancanti.");
        return res.status(400).json({ error: "Dati mancanti" });
    }

    // Pulizia token da spazi o invii accidentali
    const cleanToken = token.trim().replace(/\s/g, "");

    // Rimuove eventuali alert duplicati per lo stesso simbolo sullo stesso dispositivo
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
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
    console.log(`🔑 Token usato (prime 6 cifre): ${cleanToken.substring(0, 6)}...`);
    res.json({ status: "success" });
});

// --- DEBUG: VEDI IL CONTENUTO DAL BROWSER ---
app.get("/debug", (req, res) => {
    res.json({
        server_running: true,
        total_alerts: alertsData.active_alerts.length,
        data: alertsData.active_alerts
    });
});

app.get("/", (req, res) => res.send("🚀 Srazu Crypto Bot is Online"));

// --- LOGICA DI MONITORAGGIO ---

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

async function checkLoop() {
    if (alertsData.active_alerts.length === 0) return;

    let changed = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await fetchPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        if (alert.lastPrice === null) {
            alert.lastPrice = currentPrice;
            continue;
        }

        let isHit = false;
        // Check incrocio (prezzo sale sopra o scende sotto il target)
        if ((alert.lastPrice < alert.price && currentPrice >= alert.price) ||
            (alert.lastPrice > alert.price && currentPrice <= alert.price)) {
            isHit = true;
        }

        alert.lastPrice = currentPrice;

        if (isHit) {
            console.log(`🎯 TARGET RAGGIUNTO: ${alert.symbol} @ ${currentPrice}`);
            
            const msg = `🚨 <b>PRICE ALERT!</b>\n\n` +
                        `<b>Coppia:</b> ${alert.symbol}\n` +
                        `<b>Target:</b> ${alert.price}\n` +
                        `<b>Prezzo Attuale:</b> ${currentPrice}\n` +
                        `<b>Exchange:</b> ${alert.exchange.toUpperCase()}`;

            const success = await sendTelegram(alert.token, alert.chatId, msg);
            if (success) {
                alert.triggered = true;
                changed = true;
            }
        }
    }

    if (changed) {
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
        console.log("✅ Telegram inviato con successo!");
        return true;
    } catch (e) {
        const status = e.response ? e.response.status : "No Response";
        console.error(`❌ Errore Telegram (${status}): ${e.message}`);
        if (status === 404) {
            console.error("⚠️ Il Token è invalido o l'URL è malformato.");
        }
        return false;
    }
}

// --- START ---
loadData();
setInterval(checkLoop, 5000); // Controllo ogni 5 secondi

app.listen(PORT, () => {
    console.log(`🌍 Server in ascolto sulla porta ${PORT}`);
});
