import fs from "fs";
import fetch from "node-fetch";

const ALERTS_FILE = "./alerts.json";

// Legge gli alert dal JSON
function loadAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  const data = fs.readFileSync(ALERTS_FILE);
  const json = JSON.parse(data);
  return json.alerts || [];
}

// Salva gli alert aggiornati
function saveAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify({ alerts }, null, 2));
}

// Invia messaggio Telegram usando il bot_token dal JSON
async function sendTelegram(chat_id, text, bot_token) {
  try {
    const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text }),
    });
    return res.json();
  } catch (err) {
    console.error("Errore Telegram:", err);
  }
}

// Ottiene il prezzo corrente di una coppia da Binance
async function getPriceBinance(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.price);
  } catch (err) {
    console.error(`Errore Binance per ${symbol}:`, err);
    return null;
  }
}

// Loop di controllo alert
async function checkAlerts() {
  const alerts = loadAlerts();
  if (alerts.length === 0) return;

  // Creiamo un set delle coppie per fare richieste singole
  const symbols = [...new Set(alerts.map(a => a.symbol))];

  // Scarica il prezzo solo per le coppie interessate
  const prices = {};
  await Promise.all(
    symbols.map(async (s) => {
      const p = await getPriceBinance(s);
      if (p !== null) prices[s] = p;
    })
  );

  // Controlla gli alert
  for (const alert of [...alerts]) {
    const currentPrice = prices[alert.symbol];
    if (!currentPrice) continue;

    if (currentPrice >= alert.price) {
      const msg = `⚡ Alert! ${alert.symbol} ha raggiunto ${currentPrice}`;
      await sendTelegram(alert.user_id, msg, alert.bot_token);
      console.log(msg);

      // Rimuove alert inviato
      const index = alerts.indexOf(alert);
      if (index > -1) alerts.splice(index, 1);
      saveAlerts(alerts);
    }
  }
}

// Loop infinito ogni 5 secondi
setInterval(checkAlerts, 5000);

console.log("Server price alert attivo ✅");
