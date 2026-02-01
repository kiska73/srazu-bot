import express from "express";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ===== RENDER DISK ===== */
const ALERT_FILE = "/data/alerts.json";

/* ---------------- FILE HELPERS ---------------- */

function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        return JSON.parse(fs.readFileSync(ALERT_FILE, "utf8"));
    } catch (e) {
        console.error("Read alerts error:", e.message);
        return [];
    }
}

function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
        console.error("Save alerts error:", e.message);
    }
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
        device_id: req.body.device_id,
        exchange: req.body.exchange,
        symbol: req.body.symbol,
        price: Number(req.body.price),
        direction: req.body.direction,
        tgToken: req.body.tgToken,
        tgChatId: req.body.tgChatId,
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
