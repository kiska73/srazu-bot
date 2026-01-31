import os
import json
import threading
import sqlite3
from datetime import datetime
import requests
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import time

# ===============================
# CONFIG
# ===============================
DB_PATH = os.environ.get("DB_PATH", "/data/alerts.db")  # Disco persistente
PORT = int(os.environ.get("PORT", 5000))

SERVER_DOMAIN = os.environ.get("SERVER_DOMAIN", "https://srazu-bot.onrender.com")

# Prezzi in RAM + prev_price per cross detection
prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

# Polling interval in seconds
POLL_INTERVAL = 5  # Ogni 5 secondi, controlla prezzi solo per simboli attivi

# ===============================
# DATABASE
# ===============================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        bot_token TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        target_price REAL NOT NULL,
        horiz_price REAL,
        condition TEXT DEFAULT 'cross',
        status TEXT DEFAULT 'active',
        triggered_at TIMESTAMP,
        UNIQUE(device_id, exchange, symbol)
    )''')
    conn.commit()
    conn.close()
    print(f"[DB] Inizializzato su {DB_PATH}")
    
    # DEBUG DISK
    print(f"[DISK] /data esiste? {os.path.exists('/data')}")
    if os.path.exists('/data'):
        print(f"[DISK] Contenuti /data: {os.listdir('/data')}")
        if os.path.exists(DB_PATH):
            print(f"[DISK] alerts.db size: {os.path.getsize(DB_PATH)} bytes")

init_db()

def upsert_alert(data):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""INSERT INTO alerts 
                 (device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price, condition, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
                 ON CONFLICT(device_id, exchange, symbol) DO UPDATE SET
                 target_price=excluded.target_price,
                 horiz_price=excluded.horiz_price,
                 bot_token=excluded.bot_token,
                 chat_id=excluded.chat_id,
                 status='active',
                 triggered_at=NULL""",
              (data['device_id'], data['bot_token'], data['chat_id'], data['exchange'],
               data['symbol'], data['target_price'], data.get('horiz_price'), data.get('condition', 'cross')))
    conn.commit()
    conn.close()
    print(f"[ALERT] Upsert alert: {data['exchange']} {data['symbol']} for {data['device_id']}")

def remove_alert(device_id, exchange, symbol):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE alerts SET status='cancelled' WHERE device_id=? AND exchange=? AND symbol=?",
              (device_id, exchange, symbol))
    conn.commit()
    conn.close()
    print(f"[ALERT] Cancellato alert: {device_id} {exchange} {symbol}")

def get_active_alerts():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price FROM alerts WHERE status='active'")
    alerts = c.fetchall()
    conn.close()
    return alerts

# ===============================
# TELEGRAM
# ===============================
def send_telegram(bot_token, chat_id, message, exchange, symbol):
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    trade_url = f"{SERVER_DOMAIN}/open_trade?exchange={exchange}&symbol={symbol}"
    keyboard = {
        "inline_keyboard": [[
            {"text": "Open Trade Now", "url": trade_url}
        ]]
    }
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "reply_markup": json.dumps(keyboard)
    }
    try:
        r = requests.post(url, json=payload, timeout=10)
        if r.status_code != 200:
            print(f"[TG ERROR] {r.text}")
    except Exception as e:
        print(f"[TG ERROR] {e}")

# ===============================
# ALERT CHECK
# ===============================
def check_all_alerts(alerts):
    updated_symbols = set()

    for alert in alerts:
        alert_id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price = alert
        target_price = float(target_price)

        if symbol not in prices[exchange]:
            continue
        current_price = prices[exchange][symbol]
        prev_price = prev_prices[exchange].get(symbol, current_price)

        # Cross detection bidirezionale: triggera se crossa up o down
        triggered = (prev_price < target_price <= current_price) or (prev_price > target_price >= current_price)

        if triggered:
            message = f"🚨 <b>ALERT {exchange.upper()} {symbol}</b>\nPrice reached: <b>{current_price:.8f}</b>\nTarget: <b>{target_price:.8f}</b>"
            if horiz_price is not None:
                message += f"\nSynchronized line: <b>{horiz_price:.8f}</b>"
            message += f"\n\n⚠️ Alert triggered and cancelled automatically."
            send_telegram(bot_token, chat_id, message, exchange, symbol)
            remove_alert(device_id, exchange, symbol)
            print(f"[{datetime.now()}] [TRIGGERED & CANCELLED] {device_id} {exchange} {symbol} @ {current_price}")

        updated_symbols.add((exchange, symbol))

    # Aggiorna prev_price dopo il loop
    for exchange, symbol in updated_symbols:
        prev_prices[exchange][symbol] = prices[exchange][symbol]

# ===============================
# POLLING THREAD (REST API)
# ===============================
def polling_thread():
    while True:
        alerts = get_active_alerts()
        if not alerts:
            print(f"[{datetime.now()}] [POLL] No active alerts - sleeping {POLL_INTERVAL}s")
            time.sleep(POLL_INTERVAL)
            continue

        # Raccogli simboli unici per exchange
        bybit_symbols = set()
        binance_symbols = set()
        for alert in alerts:
            exchange = alert[4]
            symbol = alert[5]
            if exchange == "bybit":
                bybit_symbols.add(symbol)
            elif exchange == "binance":
                binance_symbols.add(symbol)

        # Fetch Bybit - loop su singoli per non sovraccaricare (rate limit alto, ~200/min)
        for symbol in bybit_symbols:
            try:
                url = f"https://api.bybit.com/v5/market/tickers?category=linear&symbol={symbol}"
                r = requests.get(url, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    if data['retCode'] == 0:
                        price_str = data['result']['list'][0]['lastPrice']
                        price = float(price_str)
                        prices["bybit"][symbol] = price
                        print(f"[{datetime.now()}] [BYBIT POLL] {symbol} @ {price:.8f}")
            except Exception as e:
                print(f"[BYBIT POLL ERROR] {symbol}: {e}")
            time.sleep(0.1)  # Piccolo delay se tanti simboli, per evitare throttle

        # Fetch Binance - loop su singoli
        for symbol in binance_symbols:
            try:
                url = f"https://fapi.binance.com/fapi/v1/ticker/price?symbol={symbol}"
                r = requests.get(url, timeout=5)
                if r.status_code == 200:
                    data = r.json()
                    price = float(data['price'])
                    prices["binance"][symbol] = price
                    print(f"[{datetime.now()}] [BINANCE POLL] {symbol} @ {price:.8f}")
            except Exception as e:
                print(f"[BINANCE POLL ERROR] {symbol}: {e}")
            time.sleep(0.1)  # Piccolo delay

        # Check alerts dopo fetch
        check_all_alerts(alerts)

        time.sleep(POLL_INTERVAL)

# ===============================
# FLASK APP
# ===============================
app = Flask(__name__)
CORS(app, origins=["*"])

@app.post("/add_alert")
def add_alert():
    data = request.get_json()
    required = ["device_id", "bot_token", "chat_id", "exchange", "symbol", "target_price"]
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400
    upsert_alert(data)
    return jsonify({"status": "added"})

@app.post("/update_alert")
def update_alert():
    data = request.get_json()
    required = ["device_id", "bot_token", "chat_id", "exchange", "symbol", "target_price"]
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400
    upsert_alert(data)
    return jsonify({"status": "updated"})

@app.post("/remove_alert")
def remove_alert_route():
    data = request.get_json()
    required = ["device_id", "exchange", "symbol"]
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400
    remove_alert(data["device_id"], data["exchange"], data["symbol"])
    return jsonify({"status": "removed"})

@app.get("/")
def health():
    return f"Server alive – {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

@app.get("/open_trade")
def open_trade():
    exchange = request.args.get("exchange")
    symbol = request.args.get("symbol")
    if not exchange or not symbol:
        return "Missing parameters", 400

    user_agent = request.headers.get('User-Agent', '').lower()
    is_mobile = any(k in user_agent for k in ['mobile', 'android', 'iphone', 'ipad'])

    if exchange == "binance":
        web_url = f"https://www.binance.com/en/futures/{symbol}"
        app_scheme = f"binance://futures/trade?symbol={symbol}"
    elif exchange == "bybit":
        web_url = f"https://www.bybit.com/trade/usdt/{symbol}"
        app_scheme = f"bybit://trade/usdt/{symbol}"
    else:
        return "Unsupported exchange", 400

    if is_mobile:
        return f"""
        <html><body><script>
            window.location = "{app_scheme}";
            setTimeout(() => {{ window.location = "{web_url}"; }}, 2000);
        </script></body></html>
        """
    else:
        return redirect(web_url)

if __name__ == "__main__":
    # Thread polling in background
    threading.Thread(target=polling_thread, daemon=True).start()

    app.run(host="0.0.0.0", port=PORT)
