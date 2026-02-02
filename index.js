import fetch from "node-fetch";
import fs from "fs";

const ALERT_FILE = "./alerts.json"; // file JSON con alert
const INTERVAL = 5000; // 5 secondi

// Legge gli alert dal JSON
function loadAlerts() {
  if (!fs.existsSync(ALERT_FILE)) return [];
  const data = fs.readFileSync(ALERT_FILE, "utf8");
  try {
    return JSON.parse(data).alerts || [];
  } catch (err) {
    console.error("Errore parsing JSON:", err);
    return [];
  }
}

// Salva gli alert aggiornati nel JSON
function saveAlerts(alerts) {
  fs.writeFileSync(ALERT_FILE, JSON.stringify({ alerts }, null, 2));
}

// Funzione per inviare messaggio Telegram usando il bot token dell'alert
async function sendTelegram(chat_id, text, bot_token) {
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text }),
    });
  } catch (err) {
    console.error("Errore invio Telegram:", err);
  }
}

// Funzione per ottenere i prezzi attuali da Binance
async function getPrices(symbols) {
  const prices = {};
  try {
    // Binance API pubblica
    const query = symbols.map(s => `symbol=${s.toUpperCase()}`).join("&");
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?${query}`);
    const data = await res.json();

    if (Array.isArray(data)) {
      data.forEach(item => {
        prices[item.symbol] = parseFloat(item.price);
      });
    } else if (data.symbol && data.price) {
      prices[data.symbol] = parseFloat(data.price);
    }
  } catch (err) {
    console.error("Errore fetch prezzi:", err);
  }
  return prices;
}

// Funzione principale che controlla gli alert
async function checkAlerts() {
  let alerts = loadAlerts();
  if (alerts.length === 0) return;

  // Trova tutte le coppie attive
  const symbols = [...new Set(alerts.map(a => a.symbol.toUpperCase()))];

  // Scarica solo prezzi necessari
  const prices = await getPrices(symbols);

  for (const alert of [...alerts]) {
    const symbol = alert.symbol.toUpperCase();
    const currentPrice = prices[symbol];

    if (!currentPrice) continue;

    // Controllo sopra/sotto
    if (
      (alert.type === "above" && currentPrice >= alert.price) ||
      (alert.type === "below" && currentPrice <= alert.price)
    ) {
      const msg = `⚡ Alert! ${symbol} ha raggiunto ${currentPrice} (soglia ${alert.price})`;
      await sendTelegram(alert.user_id, msg, alert.bot_token);

      // Rimuove alert inviato
      alerts = alerts.filter(a => a !== alert);
    }
  }

  // Salva alert aggiornati
  saveAlerts(alerts);
}

// Loop infinito ogni INTERVAL ms
setInterval(checkAlerts, INTERVAL);

// Avvio immediato
checkAlerts();
