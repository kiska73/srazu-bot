const fs = require("fs");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const ALERT_FILE = "./alerts.json";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors()); // Permette alla tua App di comunicare con il server
app.use(express.json());

let alertsData = { active_alerts: [] };

// Caricamento dati salvati all'avvio
function loadData() {
    try {
        if (fs.existsSync(ALERT_FILE)) {
            alertsData = JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
        }
    } catch (e) { console.error("Errore caricamento file:", e); }
}
loadData();

// --- ENDPOINT PER LA TUA APP ---

// Riceve l'alert quando l'utente lo attiva nell'App
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, token, chatId } = req.body;

    // Rimuove eventuali alert duplicati per lo stesso simbolo/dispositivo
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );

    // Aggiunge il nuovo alert con i dati inviati dalla tua App
    alertsData.active_alerts.push({
        device_id,
        exchange: exchange || "bybit",
        symbol: symbol.toUpperCase(),
        price: parseFloat(price),
        token,
        chatId,
        triggered: false,
        timestamp: Date.now()
    });

    saveData();
    console.log(`📌 Alert Registrato: ${symbol} @ ${price} (${exchange})`);
    res.json({ status: "success" });
});

// Rimuove l'alert quando l'utente lo cancella nell'App
app.post("/remove_alert", (req, res) => {
    const { device_id, symbol } = req.body;
    alertsData.active_alerts = alertsData.active_alerts.filter(a => 
        !(a.device_id === device_id && a.symbol === symbol)
    );
    saveData();
    console.log(`🗑️ Alert Rimosso: ${symbol} per device ${device_id}`);
    res.json({ status: "removed" });
});

app.get("/", (req, res) => {
    res.send(`Srazu Bot Server Online. Monitorando ${alertsData.active_alerts.length} alert.`);
});

// --- LOGICA DI MONITORAGGIO PREZZI ---

async function getPrice(exchange, symbol) {
    try {
        if (exchange.toLowerCase() === "binance") {
            const r = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            return parseFloat(r.data.price);
        } else {
            // Default Bybit
            const r = await axios.get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            return parseFloat(r.data.result.list[0].lastPrice);
        }
    } catch (e) { return null; }
}

async function checkAlerts() {
    if (alertsData.active_alerts.length === 0) return;

    let hasChanged = false;

    for (let alert of alertsData.active_alerts) {
        if (alert.triggered) continue;

        const currentPrice = await getPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        // Logica di incrocio: determiniamo la direzione basandoci sul prezzo al momento del set (semplificata)
        // Se non abbiamo la direzione salvata, usiamo un check standard
        let isHit = false;
        
        // Esempio: Se il prezzo corrente tocca o supera il target
        // Nota: Nel tuo frontend gestisci crossedUp/Down. Qui il server fa un controllo di soglia.
        if (Math.abs(currentPrice - alert.price) / alert.price < 0.0005) { // Tolleranza 0.05%
            isHit = true;
        } else if (currentPrice >= alert.price && alert.lastPrice < alert.price) {
             isHit = true;
        } else if (currentPrice <= alert.price && alert.lastPrice > alert.price) {
             isHit = true;
        }
        
        // Salviamo l'ultimo prezzo per il prossimo check di incrocio
        alert.lastPrice = currentPrice;

        if (isHit) {
            console.log(`🎯 TARGET RAGGIUNTO: ${alert.symbol} @ ${currentPrice}`);
            
            const msg = `🚨 <b>PRICE ALERT!</b>\n` +
                        `<b>${alert.symbol}</b> ha raggiunto il target!\n` +
                        `Prezzo: <b>${currentPrice}</b>\n` +
                        `Exchange: ${alert.exchange.toUpperCase()}`;

            await sendTelegram(alert.token, alert.chatId, msg);
            alert.triggered = true;
            hasChanged = true;
        }
    }

    // Pulizia: rimuoviamo gli alert scattati per non sprecare risorse
    if (hasChanged) {
        alertsData.active_alerts = alertsData.active_alerts.filter(a => !a.triggered);
        saveData();
    }
}

async function sendTelegram(token, chatId, text) {
    try {
        // .trim() rimuove spazi vuoti accidentali all'inizio o alla fine
        const cleanToken = token.trim(); 
        const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
        
        await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML"
        });
        console.log("✅ Telegram inviato con successo!");
    } catch (e) {
        // Se l'errore persiste, stampiamo l'URL (senza token completo) per capire
        console.error(`❌ Errore API Telegram: ${e.response ? e.response.statusText : e.message}`);
        if (e.response && e.response.status === 404) {
            console.error("⚠️ Il Token Bot sembra non essere valido. Controllalo su @BotFather.");
        }
    }
}

function saveData() {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
}

// Ciclo di controllo ogni 5 secondi
setInterval(checkAlerts, 5000);

app.listen(PORT, () => console.log(`🚀 Server per Render pronto sulla porta ${PORT}`));
