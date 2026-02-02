const fs = require("fs");
const axios = require("axios");
const express = require("express");

// CONFIGURAZIONE
const ALERT_FILE = "./alerts.json";
const CHECK_INTERVAL = 5000; // 5 secondi
const PORT = process.env.PORT || 3000;

// Variabile globale per i dati
let alertsData = { telegram: {}, alerts: [] };

// --- 1. SETUP SERVER WEB (Per Render) ---
const app = express();
app.get("/", (req, res) => {
  res.send("Crypto Alert Bot è attivo! 🚀");
});
app.listen(PORT, () => {
  console.log(`🌍 Web Server in ascolto sulla porta ${PORT}`);
});

// --- 2. GESTIONE FILE JSON ---
function loadAlerts() {
  try {
    if (!fs.existsSync(ALERT_FILE)) {
      console.error("❌ File alerts.json non trovato!");
      return;
    }
    const raw = fs.readFileSync(ALERT_FILE);
    const data = JSON.parse(raw);
    alertsData = data;
    console.log(`⚡ ${alertsData.alerts.length} alerts caricati correttamente.`);
  } catch (e) {
    console.error("❌ Errore caricamento JSON:", e.message);
  }
}

function saveAlerts() {
  try {
    // Salviamo lo stato (es. triggered: true) nel file
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    // console.log("💾 Stato alerts salvato.");
  } catch (e) {
    console.error("❌ Errore salvataggio JSON:", e.message);
  }
}

// --- 3. FUNZIONI API & TELEGRAM ---

async function sendTelegram(message) {
  const { token, chatId } = alertsData.telegram;
  if (!token || !chatId) {
    console.log("⚠️ Configurazione Telegram mancante.");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    });
    console.log(`📩 Telegram inviato: ${message}`);
  } catch (e) {
    console.error(`❌ Errore invio Telegram: ${e.response ? e.response.data.description : e.message}`);
  }
}

// Supporto API Binance (Più stabile per i prezzi spot)
async function getBinancePrice(symbol) {
  try {
    // Normalizza il simbolo (es. btcusdt -> BTCUSDT)
    const upperSymbol = symbol.toUpperCase();
    const resp = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}`);
    return parseFloat(resp.data.price);
  } catch (e) {
    console.error(`⚠️ Errore prezzo Binance per ${symbol}:`, e.message);
    return null;
  }
}

// Supporto API Bybit (Opzionale, se vuoi usare Bybit scommenta la logica in checkAlerts)
async function getBybitPrice(symbol) {
    try {
        const upperSymbol = symbol.toUpperCase();
        const resp = await axios.get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${upperSymbol}`);
        if(resp.data.retCode === 0 && resp.data.result.list.length > 0) {
            return parseFloat(resp.data.result.list[0].lastPrice);
        }
        return null;
    } catch (e) {
        console.error(`⚠️ Errore prezzo Bybit per ${symbol}:`, e.message);
        return null;
    }
}

// --- 4. LOGICA DI CONTROLLO ---

async function checkAlerts() {
  // Ricarica il JSON ogni volta per vedere se hai aggiunto nuovi alert manualmente
  // Nota: Su Render il filesystem è effimero, quindi se riavvii perdi le modifiche fatte via codice, 
  // ma se carichi un nuovo file da Git va bene.
  // Se non modifichi il file esternamente mentre gira, puoi commentare la riga sotto:
  // loadAlerts(); 

  if (!alertsData.alerts || alertsData.alerts.length === 0) {
    return; // Nessun alert da controllare
  }

  let stateChanged = false;

  for (const alert of alertsData.alerts) {
    // Salta se già scattato
    if (alert.triggered) continue;

    // Ottieni prezzo (Usa Binance di default)
    const currentPrice = await getBinancePrice(alert.symbol);
    
    if (currentPrice === null) continue;

    let triggered = false;
    let icon = "";

    // Logica ABOVE (Prezzo sale sopra X)
    if (alert.direction === "above" && currentPrice >= alert.price) {
      triggered = true;
      icon = "🚀";
      await sendTelegram(`${icon} **ALERT PREZZO**\n\n💎 **${alert.symbol}** ha superato ${alert.price}\n💰 Prezzo Attuale: ${currentPrice}`);
    } 
    // Logica BELOW (Prezzo scende sotto X)
    else if (alert.direction === "below" && currentPrice <= alert.price) {
      triggered = true;
      icon = "🔻";
      await sendTelegram(`${icon} **ALERT PREZZO**\n\n💎 **${alert.symbol}** è sceso sotto ${alert.price}\n💰 Prezzo Attuale: ${currentPrice}`);
    }

    if (triggered) {
      alert.triggered = true;
      stateChanged = true;
    }
  }

  // Se qualche alert è scattato, salviamo il file JSON per non reinviare il messaggio
  if (stateChanged) {
    saveAlerts();
  }
}

// --- 5. AVVIO ---

console.log("🤖 Bot Alert Crypto Avviato...");
loadAlerts();

// Esegui controllo ogni X millisecondi
setInterval(checkAlerts, CHECK_INTERVAL);
