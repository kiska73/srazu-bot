import express from "express";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALERT_FILE = "./alerts.json";

/* ---------------- FILE HELPERS ---------------- */

function loadAlerts() {
    if (!fs.existsSync(ALERT_FILE)) return [];
    return JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
}

function saveAlerts(alerts) {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
}

/* ---------------- PRICE FETCH ---------------- */

async function getLastPrice(exchange, symbol) {
    try {
        if (exchange === "bybit") {
            const r = await fetch(
                `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
            );
            const j = await r.json();
            return Number(j.result.list[0].lastPrice);
        }

        if (exchange === "binance") {
            const r = await fetch(
                `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
            );
            const j = await r.json();
            return Number(j.price);
        }
    } catch (e) {
        console.error("Price fetch error:", e.message);
    }
    return null;
}

/* ---------------- TELEGRAM ---------------- */

async function sendTelegram(token, chatId, text) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true
        })
    });
}

/* ---------------- API ---------------- */

/*
BODY:
{
  device_id,
  exchange,
  symbol,
  price,
  direction: "up" | "down",
  tgToken,
  tgChatId
}
*/
app.post("/set_alert", (req, res) => {
    const alerts = loadAlerts();

    alerts.push({
        ...req.body,
        triggered: false,
        created: Date.now()
    });

    saveAlerts(alerts);
    res.json({ ok: true });
});

app.post("/remove_alert", (req, res) => {
    let alerts = loadAlerts();

    alerts = alerts.filter(
        a =>
            !(
                a.device_id === req.body.device_id &&
                a.symbol === req.body.symbol &&
                a.exchange === req.body.exchange
            )
    );

    saveAlerts(alerts);
    res.json({ ok: true });
});

/* ---------------- ALERT LOOP ---------------- */

setInterval(async () => {
    const alerts = loadAlerts();
    let changed = false;

    for (const alert of alerts) {
        if (alert.triggered) continue;

        const price = await getLastPrice(alert.exchange, alert.symbol);
        if (!price) continue;

        const hit =
            (alert.direction === "up" && price >= alert.price) ||
            (alert.direction === "down" && price <= alert.price);

        if (hit) {
            const link =
                alert.exchange === "bybit"
                    ? `https://www.bybit.com/trade/usdt/${alert.symbol}`
                    : `https://www.binance.com/en/futures/${alert.symbol}`;

            const msg = `
🚨 <b>PRICE ALERT</b>
<b>${alert.symbol}</b>

Exchange: ${alert.exchange.toUpperCase()}
Alert price: <b>${alert.price}</b>
Current price: <b>${price}</b>

<a href="${link}">Open trade</a>
`;

            try {
                await sendTelegram(alert.tgToken, alert.tgChatId, msg);
                alert.triggered = true;
                changed = true;
                console.log("ALERT SENT:", alert.symbol);
            } catch (e) {
                console.error("Telegram error:", e.message);
            }
        }
    }

    if (changed) saveAlerts(alerts);
}, 5000);

/* ---------------- START SERVER ---------------- */

app.listen(PORT, () => {
    console.log("Alert server running on port", PORT);
});
  let userAlerts = db.data.alerts[device_id] || [];
  userAlerts = userAlerts.filter(a => a.symbol !== symbol);

  db.data.alerts[device_id] = userAlerts;
  await db.write();

  console.log(`Alert rimosso per ${symbol}`);
  res.json({ success: true });
});

// Endpoint debug
app.get('/get_alerts', (req, res) => {
  res.json(db.data.alerts || {});
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

// Get candele (stesso)
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
  for (const device_id in db.data.alerts) {
    for (const alert of db.data.alerts[device_id]) {
      if (alert.triggered) continue;

      const candles = await getLastTwoCandles(alert.symbol, alert.exchange);
      if (!candles) continue;

      const crossedUp = candles.prev.close < alert.price && candles.last.close >= alert.price;
      const crossedDown = candles.prev.close > alert.price && candles.last.close <= alert.price;

      if (crossedUp || crossedDown) {
        const text = `🚨 <b>PRICE ALERT!</b>\n<b>${alert.symbol}</b> ha raggiunto ${alert.price.toFixed(2)}\nPrezzo attuale: <b>${candles.last.close.toFixed(2)}</b>\nExchange: ${alert.exchange.toUpperCase()}`;
        await sendTelegram(alert.tg_token, alert.tg_chatid, text);
        alert.triggered = true;
        await db.write();
      }
    }
  }
}, 10000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo su ${PORT}`));
