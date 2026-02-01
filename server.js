const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json({ limit: '10mb' }));

// Alerts in memoria (con piano pagato non si perde al restart, ma per sicurezza puoi aggiungere salvataggio su file se vuoi)
let alerts = {}; // { device_id: [{symbol, price, exchange, tg_token, tg_chatid, triggered}] }

const BINANCE_MAP = {"1":"1m","3":"3m","5":"5m","15":"15m","30":"30m","60":"1h","240":"4h","D":"1d"};

// Endpoint per aggiungere alert
app.post('/add_alert', (req, res) => {
  const { device_id, exchange, symbol, price, tg_token, tg_chatid } = req.body;
  if (!device_id || !symbol || !price || !tg_token || !tg_chatid) return res.status(400).json({ error: 'Missing data' });

  if (!alerts[device_id]) alerts[device_id] = [];
  // Rimuovi alert vecchio per lo stesso symbol
  alerts[device_id] = alerts[device_id].filter(a => a.symbol !== symbol);
  alerts[device_id].push({
    symbol,
    price: Number(price),
    exchange,
    tg_token,
    tg_chatid,
    triggered: false
  });

  console.log(`Alert aggiunto per ${symbol} a ${price}`);
  res.json({ success: true });
});

// Endpoint per rimuovere alert
app.post('/remove_alert', (req, res) => {
  const { device_id, symbol } = req.body;
  if (!device_id || !symbol) return res.status(400).json({ error: 'Missing data' });

  if (alerts[device_id]) {
    alerts[device_id] = alerts[device_id].filter(a => a.symbol !== symbol);
    console.log(`Alert rimosso per ${symbol}`);
  }
  res.json({ success: true });
});

// Funzione per inviare messaggio Telegram
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

// Funzione per fetch ultime 2 candele (per check cross)
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

// Polling continuo per controllare tutti gli alert
setInterval(async () => {
  for (const device_id in alerts) {
    for (const alert of alerts[device_id]) {
      if (alert.triggered) continue;

      const candles = await getLastTwoCandles(alert.symbol, alert.exchange, '5');
      if (!candles || !candles.prev || !candles.last) continue;

      const crossedUp = candles.prev.close < alert.price && candles.last.close >= alert.price;
      const crossedDown = candles.prev.close > alert.price && candles.last.close <= alert.price;

      if (crossedUp || crossedDown) {
        const text = `🚨 <b>PRICE ALERT!</b>\n<b>${alert.symbol}</b> ha raggiunto ${alert.price.toFixed(2)}\nPrezzo attuale: <b>${candles.last.close.toFixed(2)}</b>\nExchange: ${alert.exchange.toUpperCase()}`;
        await sendTelegram(alert.tg_token, alert.tg_chatid, text);
        alert.triggered = true;
        console.log(`Alert inviato per ${alert.symbol}`);
      }
    }
  }
}, 10000); // ogni 10 secondi (puoi cambiare a 5000 per più veloce)

// Endpoint base per test (opzionale)
app.get('/', (req, res) => res.send('SRAZU Bot attivo!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo su port ${PORT}`));
