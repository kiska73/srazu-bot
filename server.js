const express = require('express');
const fetch = require('node-fetch');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
app.use(express.json());

const adapter = new FileSync('alerts.json');
const db = low(adapter);

db.defaults({ alerts: {} }).write();

const BINANCE_MAP = {"1":"1m","3":"3m","5":"5m","15":"15m","30":"30m","60":"1h","240":"4h","D":"1d"};

// Endpoint add
app.post('/add_alert', (req, res) => {
  const { device_id, exchange, symbol, price, tg_token, tg_chatid } = req.body;
  if (!device_id || !symbol || !price || !tg_token || !tg_chatid) return res.status(400).json({ error: 'Missing data' });

  let userAlerts = db.get(`alerts.${device_id}`).value() || [];
  userAlerts = userAlerts.filter(a => a.symbol !== symbol);
  userAlerts.push({ symbol, price: Number(price), exchange, tg_token, tg_chatid, triggered: false });

  db.set(`alerts.${device_id}`, userAlerts).write();

  console.log(`Alert aggiunto per ${symbol}`);
  res.json({ success: true });
});

// Endpoint remove
app.post('/remove_alert', (req, res) => {
  const { device_id, symbol } = req.body;
  if (!device_id || !symbol) return res.status(400).json({ error: 'Missing data' });

  let userAlerts = db.get(`alerts.${device_id}`).value() || [];
  userAlerts = userAlerts.filter(a => a.symbol !== symbol);

  db.set(`alerts.${device_id}`, userAlerts).write();

  console.log(`Alert rimosso per ${symbol}`);
  res.json({ success: true });
});

// Endpoint debug: get all alerts
app.get('/get_alerts', (req, res) => {
  const allAlerts = db.get('alerts').value();
  res.json(allAlerts);
});

// Send Telegram
async function sendTelegram(tg_token, tg_chatid, text) {
  const url = `https://api.telegram.org/bot${tg_token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg_chatid, text: text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('Errore Telegram:', e);
  }
}

// Get candele
async function getLastTwoCandles(symbol, exchange, interval = '5') {
  let baseUrl = exchange === 'bybit'
    ? `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=2`
    : `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${BINANCE_MAP[interval] || '5m'}&limit=2`;

  try {
    const res = await fetch(baseUrl);
    if (!res.ok) return null;
    const data = await res.json();

    let rawList = exchange === 'bybit' ? data.result?.list || [] : data;
    if (!Array.isArray(rawList) || rawList.length < 2) return null;

    const klines = rawList.map(c => ({
      time: Number(c[0]) / 1000,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4])
    }));

    return exchange === 'bybit' ? { prev: klines[1], last: klines[0] } : { prev: klines[0], last: klines[1] };
  } catch (e) {
    console.error('Errore fetch candele:', e);
    return null;
  }
}

// Polling
setInterval(async () => {
  const allAlerts = db.get('alerts').value();
  for (const device_id in allAlerts) {
    for (const alert of allAlerts[device_id]) {
      if (alert.triggered) continue;

      const candles = await getLastTwoCandles(alert.symbol, alert.exchange);
      if (!candles) continue;

      const crossedUp = candles.prev.close < alert.price && candles.last.close >= alert.price;
      const crossedDown = candles.prev.close > alert.price && candles.last.close <= alert.price;

      if (crossedUp || crossedDown) {
        const text = `🚨 <b>PRICE ALERT!</b>\n<b>${alert.symbol}</b> ha raggiunto ${alert.price.toFixed(2)}\nPrezzo attuale: <b>${candles.last.close.toFixed(2)}</b>\nExchange: ${alert.exchange.toUpperCase()}`;
        await sendTelegram(alert.tg_token, alert.tg_chatid, text);
        alert.triggered = true;
        db.set('alerts', allAlerts).write();
      }
    }
  }
}, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo su ${PORT}`));
