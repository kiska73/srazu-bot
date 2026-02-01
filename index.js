import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Utilizziamo un percorso relativo per evitare errori di permessi su Render
const ALERT_FILE = "./alerts.json";

/* ---------------- HELPERS PER I FILE ---------------- */

function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        const data = fs.readFileSync(ALERT_FILE, "utf8");
        return JSON.parse(data);
    } catch (e) {
        console.error("❌ Errore lettura alerts.json:", e.message);
        return [];
    }
}

function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
        console.error("❌ Errore salvataggio alerts.json:", e.message);
    }
}

/* ---------------- RECUPERO PREZZI ---------------- */

async function getLastPrice(exchange, symbol) {
    try {
        if (exchange === "bybit") {
            const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            const j = await r.json();
            if (j.result?.list?.[0]?.lastPrice) {
                return Number(j.result.list[0].lastPrice);
            }
        }
        if (exchange === "binance") {
            const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            const j = await r.json();
            if (j.price) {
                return Number(j.price);
            }
        }
    } catch (e) {
        console.error(`⚠️ Errore fetch ${exchange} per ${symbol}:`, e.message);
    }
    return null;
}

/* ---------------- INVIO TELEGRAM ---------------- */

async function sendTelegram(token, chatId, text) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                disable_web_page_preview: true
            })
        });
        const res = await r.json();
        if (!res.ok) throw new Error(res.description);
        return true;
    } catch (e) {
        console.error("❌ Errore invio Telegram:", e.message);
        return false;
    }
}

/* ---------------- ROTTE API ---------------- */

// Riceve l'alert dal browser
app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, direction, tgToken, tgChatId } = req.body;
    
    if (!tgToken || !tgChatId) {
        return res.status(400).json({ ok: false, error: "Mancano Token o ChatID Telegram" });
    }

    let alerts = loadAlerts();
    
    const newAlert = {
        device_id,
        exchange: exchange.toLowerCase(),
        symbol: symbol.toUpperCase(),
        price: Number(price),
        direction,
        tgToken,
        tgChatId,
        triggered: false,
        created: Date.now()
    };

    alerts.push(newAlert);
    saveAlerts(alerts);
    
    console.log(`✅ Alert impostato: ${newAlert.symbol} a ${newAlert.price} (${direction})`);
    res.json({ ok: true });
});

// Rimuove l'alert
app.post("/remove_alert", (req, res) => {
    let alerts = loadAlerts();
    const initialCount = alerts.length;

    alerts = alerts.filter(a => 
        !(a.device_id === req.body.device_id && a.symbol === req.body.symbol)
    );

    if (alerts.length !== initialCount) {
        saveAlerts(alerts);
        console.log(`🗑️ Alert rimosso per ${req.body.symbol}`);
    }
    res.json({ ok: true });
});

/* ---------------- LOOP DI CONTROLLO (Ogni 5 secondi) ---------------- */

setInterval(async () => {
    let alerts = loadAlerts();
    if (alerts.length === 0) return;

    let changed = false;

    for (let alert of alerts) {
        if (alert.triggered) continue;

        const currentPrice = await getLastPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        const isHit = (alert.direction === "up" && currentPrice >= alert.price) ||
                      (alert.direction === "down" && currentPrice <= alert.price);

        if (isHit) {
            console.log(`🎯 TARGET RAGGIUNTO: ${alert.symbol} a ${currentPrice}`);

            const exchangeUrl = alert.exchange === "bybit" 
                ? `https://www.bybit.com/trade/usdt/${alert.symbol}`
                : `https://www.binance.com/en/futures/${alert.symbol}`;

            const message = `🚨 <b>PRICE ALERT</b>\n\n` +
                          `<b>Asset:</b> ${alert.symbol}\n` +
                          `<b>Target:</b> ${alert.price}\n` +
                          `<b>Prezzo Attuale:</b> ${currentPrice}\n` +
                          `<b>Exchange:</b> ${alert.exchange.toUpperCase()}\n\n` +
                          `<a href="${exchangeUrl}">👉 APRI TRADE</a>`;

            const success = await sendTelegram(alert.tgToken, alert.tgChatId, message);
            
            if (success) {
                alert.triggered = true;
                changed = true;
            }
        }
    }

    // Pulizia: rimuoviamo gli alert già inviati per non intasare il file
    if (changed) {
        const remainingAlerts = alerts.filter(a => !a.triggered);
        saveAlerts(remainingAlerts);
        console.log("🧹 File alerts.json aggiornato e pulito.");
    }
}, 5000);

/* ---------------- AVVIO SERVER ---------------- */

app.listen(PORT, () => {
    console.log(`🚀 Alert Server attivo sulla porta ${PORT}`);
    console.log(`📂 File alert: ${path.resolve(ALERT_FILE)}`);
});
