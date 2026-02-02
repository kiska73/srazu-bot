import fs from "fs";
import axios from "axios";

const ALERT_FILE = "./alerts.json";
let alertsData = { telegram: {}, alerts: [] };

function loadAlerts() {
  try {
    const raw = fs.readFileSync(ALERT_FILE);
    const data = JSON.parse(raw);

    // Assicuriamoci che siano oggetti/array validi
    alertsData.telegram = data.telegram || {};
    alertsData.alerts = Array.isArray(data.alerts) ? data.alerts : [];

    console.log(`⚡ ${alertsData.alerts.length} alerts caricati`);
  } catch (e) {
    console.error("Errore leggendo JSON:", e.message);
    alertsData.telegram = {};
    alertsData.alerts = [];
  }
}

async function sendTelegram(message) {
  const { token, chatId } = alertsData.telegram;
  if (!token || !chatId) {
    console.log("⚠️ Telegram token o chatId mancanti, messaggio non inviato");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message
    });
    console.log("📩 Messaggio inviato:", message);
  } catch (e) {
    console.error("Errore Telegram:", e.message);
  }
}

async function getBinancePrice(symbol) {
  try {
    const resp = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(resp.data.price);
  } catch (e) {
    console.error(`Errore Binance ${symbol}:`, e.message);
    return null;
  }
}

async function checkAlerts() {
  if (!alertsData.alerts || !Array.isArray(alertsData.alerts) || alertsData.alerts.length === 0) {
    console.log("🔹 Nessun alert da controllare");
    return;
  }

  for (const alert of alertsData.alerts) {
    const price = await getBinancePrice(alert.symbol);
    if (price === null) continue;

    if (!alert.triggered) {
      if (alert.direction === "above" && price >= alert.price) {
        await sendTelegram(`⚠️ ${alert.symbol} è sopra ${alert.price}: ${price}`);
        alert.triggered = true;
      } else if (alert.direction === "below" && price <= alert.price) {
        await sendTelegram(`⚠️ ${alert.symbol} è sotto ${alert.price}: ${price}`);
        alert.triggered = true;
      }
    }
  }
}

// Carica alert
loadAlerts();
console.log("Server price alert attivo ✅");

// Controllo ogni 5 secondi
setInterval(checkAlerts, 5000);
