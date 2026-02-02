const fs = require("fs");
const axios = require("axios");
const express = require("express");

// --- CONFIGURAZIONE ---
const ALERT_FILE = "./alerts.json";
const CHECK_INTERVAL = 5000; // Controlla i prezzi ogni 5 secondi
const PORT = process.env.PORT || 3000;

// Variabile in memoria che conterrà i dati del JSON
let alertsData = { telegram: {}, alerts: [] };

// --- 1. SERVER WEB (Obbligatorio per Render) ---
const app = express();

app.get("/", (req, res) => {
  // Mostra a schermo se il bot sta girando e quanti alert ha caricato
  const alertCount = alertsData.alerts ? alertsData.alerts.length : 0;
  res.send(`
    <h1>🤖 Bot Alert Crypto Attivo</h1>
    <p>Alert caricati dal JSON: <strong>${alertCount}</strong></p>
    <p>Stato server: Online ✅</p>
  `);
});

app.listen(PORT, () => {
  console.log(`🌍 Server web avviato sulla porta ${PORT}`);
});

// --- 2. GESTIONE FILE JSON ---

function loadAlerts() {
  try {
    if (!fs.existsSync(ALERT_FILE)) {
      console.error("❌ ERRORE CRITICO: Il file alerts.json non esiste!");
      return;
    }
    
    // Legge il file in modo sincrono all'avvio
    const raw = fs.readFileSync(ALERT_FILE);
    const data = JSON.parse(raw);
    
    // Aggiorna la variabile globale
    alertsData = data;
    
    console.log("📂 JSON caricato correttamente.");
    
    // Verifica presenza credenziali (senza stamparle per sicurezza)
    if (!alertsData.telegram || !alertsData.telegram.token || !alertsData.telegram.chatId) {
      console.warn("⚠️ ATTENZIONE: Token o ChatID mancanti nel file JSON!");
    } else {
      console.log("✅ Credenziali Telegram rilevate.");
    }
    
    console.log(`📊 Trovati ${alertsData.alerts.length} alert da monitorare.`);
    
  } catch (e) {
    console.error("❌ Errore durante la lettura del JSON:", e.message);
  }
}

function saveAlerts() {
  try {
    // Sovrascrive il file JSON con i dati aggiornati (es. triggered: true)
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alertsData, null, 2));
    // console.log("💾 Stato alert salvato su file.");
  } catch (e) {
    console.error("❌ Errore salvataggio JSON:", e.message);
  }
}

// --- 3. FUNZIONI ESTERNE (Telegram & Binance) ---

async function sendTelegram(message) {
  // Prende i dati DINAMICAMENTE dalla variabile caricata dal JSON
  const { token, chatId } = alertsData.telegram;

  if (!token || !chatId) {
    console.error("⚠️ Impossibile inviare Telegram: Token o ChatID assenti.");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    });
    console.log(`📩 Messaggio inviato: "${message}"`);
  } catch (e) {
    console.error(`❌ Errore API Telegram: ${e.response ? e.response.data.description : e.message}`);
  }
}

async function getBinancePrice(symbol) {
  try {
    const upperSymbol = symbol.toUpperCase();
    const resp = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${upperSymbol}`);
    return parseFloat(resp.data.price);
  } catch (e) {
    console.error(`⚠️ Errore Binance per ${symbol}:`, e.message);
    return null;
  }
}

// --- 4. LOGICA DI CONTROLLO ---

async function checkAlerts() {
  // Se non ci sono alert nel JSON, non fa nulla
  if (!alertsData.alerts || alertsData.alerts.length === 0) return;

  let stateChanged = false;

  for (const alert of alertsData.alerts) {
    // 1. Salta se l'alert è già stato inviato
    if (alert.triggered) continue;

    // 2. Ottieni prezzo corrente
    const currentPrice = await getBinancePrice(alert.symbol);
    if (currentPrice === null) continue;

    let triggered = false;
    let icon = "";
    let message = "";

    // 3. Controlla le condizioni scritte nel JSON
    
    // Condizione "above" (Sopra)
    if (alert.direction === "above" && currentPrice >= alert.price) {
      triggered = true;
      icon = "🚀";
      message = `${icon} **TARGET RAGGIUNTO**\n\n💎 **${alert.symbol}**\n💰 Prezzo: ${currentPrice}\n🎯 Target: > ${alert.price}`;
    } 
    // Condizione "below" (Sotto)
    else if (alert.direction === "below" && currentPrice <= alert.price) {
      triggered = true;
      icon = "🔻";
      message = `${icon} **DUMP ALERT**\n\n💎 **${alert.symbol}**\n💰 Prezzo: ${currentPrice}\n🎯 Target: < ${alert.price}`;
    }

    // 4. Se la condizione è vera, invia e aggiorna
    if (triggered) {
      await sendTelegram(message);
      alert.triggered = true; // Segna come fatto
      stateChanged = true;    // Segna che dobbiamo salvare il file
    }
  }

  // 5. Se abbiamo inviato messaggi, aggiorniamo il file JSON
  if (stateChanged) {
    saveAlerts();
  }
}

// --- 5. START ---

console.log("🚀 Avvio Bot Crypto Alert...");
loadAlerts(); // Carica i dati dal JSON

// Avvia il loop di controllo
setInterval(checkAlerts, CHECK_INTERVAL);
