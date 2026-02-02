import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { Canvas, createCanvas } from "canvas";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ALERT_FILE = "./alerts.json";

// Inizializza ChartJSNodeCanvas
const width = 800;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, chartCallback: (ChartJS) => {
    ChartJS.defaults.global.defaultFontFamily = 'Arial';
} });

function loadAlerts() {
    try {
        if (!fs.existsSync(ALERT_FILE)) return [];
        const data = fs.readFileSync(ALERT_FILE, "utf8");
        return JSON.parse(data);
    } catch (e) {
        console.error("❌ Error reading alerts.json:", e.message);
        return [];
    }
}

function saveAlerts(alerts) {
    try {
        fs.writeFileSync(ALERT_FILE, JSON.stringify(alerts, null, 2));
    } catch (e) {
        console.error("❌ Error saving alerts.json:", e.message);
    }
}

async function getLastPrice(exchange, symbol) {
    try {
        if (exchange === "bybit") {
            const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
            const j = await r.json();
            if (j.result?.list?.[0]?.lastPrice) {
                return Number(j.result.list[0].lastPrice);
            }
        }
        if (exchange === "binance") {
            const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
            const j = await r.json();
            if (j.price) {
                return Number(j.price);
            }
        }
    } catch (e) {
        console.error(`⚠️ Error fetching ${exchange} for ${symbol}:`, e.message);
    }
    return null;
}

async function fetchKlines(exchange, symbol, interval = "30", limit = 50) {
    let baseUrl = "";
    if (exchange === "bybit") {
        baseUrl = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    } else if (exchange === "binance") {
        baseUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=${limit}`;
    }

    try {
        const r = await fetch(baseUrl);
        const j = await r.json();
        let rawList = exchange === "bybit" ? (j.result?.list || []) : j;
        const klines = rawList.map(c => ({
            time: Number(c[0]) / 1000,
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4])
        }));
        return exchange === "bybit" ? klines.reverse() : klines;
    } catch (e) {
        console.error(`❌ Error fetching klines for ${symbol}:`, e.message);
        return [];
    }
}

async function generateChartImage(exchange, symbol, klines) {
    const configuration = {
        type: 'candlestick',
        data: {
            datasets: [{
                label: symbol,
                data: klines.map(k => ({
                    x: k.time * 1000,
                    o: k.open,
                    h: k.high,
                    l: k.low,
                    c: k.close
                })),
                color: {
                    up: '#ffffff',
                    down: '#0051D4',
                    border: {
                        up: '#ffffff',
                        down: '#0051D4'
                    },
                    wick: {
                        up: '#cccccc',
                        down: '#0051D4'
                    }
                }
            }]
        },
        options: {
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'minute',
                        displayFormats: { minute: 'HH:mm' }
                    },
                    ticks: { color: '#d1d4dc' }
                },
                y: { ticks: { color: '#d1d4dc' } }
            },
            plugins: { legend: { display: false } },
            responsive: true
        }
    };

    try {
        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const imagePath = `./chart_${symbol}.png`;
        fs.writeFileSync(imagePath, imageBuffer);
        return imagePath;
    } catch (e) {
        console.error("❌ Error generating chart:", e.message);
        return null;
    }
}

async function sendTelegram(token, chatId, text, photoPath = null) {
    const baseUrl = `https://api.telegram.org/bot${token}`;
    try {
        if (photoPath) {
            const formData = new FormData();
            formData.append('photo', fs.createReadStream(photoPath));
            formData.append('chat_id', chatId);
            formData.append('caption', text);
            formData.append('parse_mode', 'HTML');

            const r = await fetch(`${baseUrl}/sendPhoto`, { method: "POST", body: formData });
            const res = await r.json();
            if (!res.ok) throw new Error(res.description);
            fs.unlinkSync(photoPath);
            return true;
        } else {
            const url = `${baseUrl}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`;
            const r = await fetch(url);
            const res = await r.json();
            if (!res.ok) throw new Error(res.description);
            return true;
        }
    } catch (e) {
        console.error("❌ Error sending Telegram:", e.message);
        return false;
    }
}

app.post("/set_alert", (req, res) => {
    const { device_id, exchange, symbol, price, direction, tgToken, tgChatId } = req.body;
    
    if (!tgToken || !tgChatId) {
        return res.status(400).json({ ok: false, error: "Missing Telegram Token or ChatID" });
    }

    let alerts = loadAlerts();
    
    const newAlert = {
        device_id,
        exchange: exchange.toLowerCase(),
        symbol: symbol.toUpperCase(),
        price: Number(price),
        direction,
        tgToken,
        tgChatId,
        triggered: false,
        created: Date.now()
    };

    alerts.push(newAlert);
    saveAlerts(alerts);
    
    console.log(`✅ Alert set: ${newAlert.symbol} at ${newAlert.price} (${direction})`);
    res.json({ ok: true });
});

app.post("/remove_alert", (req, res) => {
    let alerts = loadAlerts();
    const initialCount = alerts.length;

    alerts = alerts.filter(a => 
        !(a.device_id === req.body.device_id && a.symbol === req.body.symbol)
    );

    if (alerts.length !== initialCount) {
        saveAlerts(alerts);
        console.log(`🗑️ Alert removed for ${req.body.symbol}`);
    }
    res.json({ ok: true });
});

setInterval(async () => {
    let alerts = loadAlerts();
    if (alerts.length === 0) return;

    let changed = false;

    for (let alert of alerts) {
        if (alert.triggered) continue;

        const currentPrice = await getLastPrice(alert.exchange, alert.symbol);
        if (!currentPrice) continue;

        const isHit = (alert.direction === "up" && currentPrice >= alert.price) ||
                      (alert.direction === "down" && currentPrice <= alert.price);

        if (isHit) {
            console.log(`🎯 TARGET HIT: ${alert.symbol} at ${currentPrice}`);

            const exchangeUrl = alert.exchange === "bybit" 
                ? `https://www.bybit.com/trade/usdt/${alert.symbol}`
                : `https://www.binance.com/en/futures/${alert.symbol}`;

            const message = `🚨 <b>PRICE ALERT</b>\n\n` +
                          `<b>Asset:</b> ${alert.symbol}\n` +
                          `<b>Target:</b> ${alert.price}\n` +
                          `<b>Current Price:</b> ${currentPrice}\n` +
                          `<b>Exchange:</b> ${alert.exchange.toUpperCase()}\n\n` +
                          `<a href="${exchangeUrl}">👉 OPEN TRADE</a>`;

            const klines = await fetchKlines(alert.exchange, alert.symbol);
            const photoPath = klines.length > 0 ? await generateChartImage(alert.exchange, alert.symbol, klines) : null;

            const success = await sendTelegram(alert.tgToken, alert.tgChatId, message, photoPath);
            
            if (success) {
                alert.triggered = true;
                changed = true;
            }
        }
    }

    if (changed) {
        const remainingAlerts = alerts.filter(a => !a.triggered);
        saveAlerts(remainingAlerts);
        console.log("🧹 alerts.json updated and cleaned.");
    }
}, 5000);

app.listen(PORT, () => {
    console.log(`🚀 Alert Server running on port ${PORT}`);
    console.log(`📂 Alert file: ${path.resolve(ALERT_FILE)}`);
});
