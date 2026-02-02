import fs from 'fs';
import axios from 'axios';

const ALERT_FILE = './alerts.json';
const POLL_INTERVAL = 5000; // 5 secondi
let alerts = [];

// Carica gli alert dal file
function loadAlerts() {
  try {
    const data = fs.readFileSync(ALERT_FILE);
    alerts = JSON.parse(data);
    console.log(`⚡ ${alerts.length} alerts caricati`);
  } catch (err) {
    console.error('Errore caricando alerts.json:', err);
  }
}

// Salva gli alert aggiornati (per triggered)
function saveAlerts() {
  fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
}

// Fetch prezzi Binance
async function fetchBinance(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(res.data.price);
  } catch (err) {
    console.error('Errore Binance', symbol, err.message);
    return null;
  }
}

// Fetch prezzi Bybit
async function fetchBybit(symbol) {
  try {
    const res = await axios.get(`https://api.bybit.com/v2/public/tickers?symbol=${symbol}`);
    if (res.data.result && res.data.result.length > 0) {
      return parseFloat(res.data.result[0].last_price);
    }
    return null;
  } catch (err) {
    console.error('Errore Bybit', symbol, err.message);
    return null;
  }
}

// Fetch solo i simboli necessari
async function fetchPrices() {
  const prices = {};
  const grouped = {};

  for (const alert of alerts) {
    if (alert.triggered) continue; // salta quelli già triggerati
    const key = `${alert.exchange}:${alert.symbol}`;
    grouped[key] = alert;
  }

  await Promise.all(Object.keys(grouped).map(async (key) => {
    const [exchange, symbol] = key.split(':');
    let price = null;
    if (exchange === 'binance') price = await fetchBinance(symbol);
    if (exchange === 'bybit') price = await fetchBybit(symbol);
    if (price !== null) prices[key] = price;
  }));

  return prices;
}

// Controlla alert e aggiorna triggered
function checkAlerts(prices) {
  let triggeredSomething = false;

  for (const alert of alerts) {
    if (alert.triggered) continue;

    const key = `${alert.exchange}:${alert.symbol}`;
    const current = prices[key];
    if (current === undefined) continue;

    if (alert.type === 'above' && current >= alert.price) {
      console.log(`🚨 [${alert.exchange}] ${alert.symbol} sopra ${alert.price}! Prezzo attuale: ${current}`);
      alert.triggered = true;
      triggeredSomething = true;
    } else if (alert.type === 'below' && current <= alert.price) {
      console.log(`🚨 [${alert.exchange}] ${alert.symbol} sotto ${alert.price}! Prezzo attuale: ${current}`);
      alert.triggered = true;
      triggeredSomething = true;
    }
  }

  if (triggeredSomething) saveAlerts();
}

// Loop principale
async function main() {
  loadAlerts();
  console.log('Server price alert attivo ✅');

  setInterval(async () => {
    const prices = await fetchPrices();
    checkAlerts(prices);
  }, POLL_INTERVAL);
}

main();
