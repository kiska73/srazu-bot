import fs from "fs";
import axios from "axios";

// --- Configura il JSON locale ---
const ALERT_FILE = "./alerts.json"; // percorso al tuo JSON
let alertsData = { telegram: {}, alerts: [] };

// --- Funzione per leggere JSON ---
function loadAlerts() {
  try {
    const raw = fs.readFileSync(ALERT_FILE);
    alertsData = JSON.parse(raw);
    if (!alertsData.telegram?.token || !alertsData.telegram?.chatId) {
      console.error("Errore: Telegram token o chatId mancanti nel JSON");
    }
    console.log(`⚡ ${alertsData.alerts.length} alerts caricati`);
  } catch (e) {
    console.error("Errore leggendo JSON:", e.message);
  }
}

// --- Funzione per inviare messaggi Telegram ---
async function sendTelegram(message) {
  const { token, chatId } = alertsData.telegram;
  if (!token || !chatId) return;

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

// --- Funzione per prendere prezzo da Binance (pubblico) ---
async function getBinancePrice(symbol) {
  try {
    const resp = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(resp.data.price);
  } catch (e) {
    console.error(`Errore Binance ${symbol}:`, e.message);
    return null;
  }
}

// --- Controlla alert singoli ---
async function checkAlerts() {
  for (const alert of alertsData.alerts) {
    const price = await getBinancePrice(alert.symbol);
    if (price === null) continue;

    if (!alert.triggered) {
      // all'inizio decidiamo se è "above" o "below"
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

// --- Avvio server ---
loadAlerts();
console.log("Server price alert attivo ✅");

// --- Loop ogni 5 secondi ---
setInterval(checkAlerts, 5000);
