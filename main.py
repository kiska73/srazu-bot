import os
import json
import threading
import sqlite3
from datetime import datetime
import websocket
import requests
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import time

# ===============================
# CONFIG
# ===============================
# Rileva automaticamente se il Persistent Disk è montato su /data
if os.path.exists("/data"):
    DB_PATH = "/data/alerts.db"
    print("[DB] Using persistent disk: /data/alerts.db")
else:
    DB_PATH = "alerts.db"
    print("[DB] WARNING: No persistent disk detected. Using ephemeral path: alerts.db (data will be lost on restart)")

PORT = int(os.environ.get("PORT", 5000))

# Prezzi in RAM + prev_price per cross detection
prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

# WebSocket global per Bybit
bybit_ws = None

# Set dei symbol attualmente sottoscritti su Bybit
subscribed_bybit_symbols = set()

# Dominio del server (impostalo su Render come env var SERVER_DOMAIN se cambia)
SERVER_DOMAIN = os.environ.get("SERVER_DOMAIN", "https://srazu-bot.onrender.com")

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

    if data['exchange'] == "bybit":
        refresh_bybit_subscriptions()

def remove_alert(device_id, exchange, symbol):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE alerts SET status='cancelled' WHERE device_id=? AND exchange=? AND symbol=?",
              (device_id, exchange, symbol))
    conn.commit()
    conn.close()

    if exchange == "bybit":
        refresh_bybit_subscriptions()

def get_active_alerts():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price FROM alerts WHERE status='active'")
    alerts = c.fetchall()
    conn.close()
    return alerts

def mark_triggered(alert_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE alerts SET status='triggered', triggered_at=? WHERE id=?", (datetime.now(), alert_id))
    conn.commit()
    conn.close()

# ===============================
# BYBIT SUBSCRIBE / UNSUBSCRIBE
# ===============================
def refresh_bybit_subscriptions():
    global bybit_ws, subscribed_bybit_symbols
    if not bybit_ws:
        return

    alerts = get_active_alerts()
    desired_symbols = {row[5] for row in alerts if row[4] == "bybit"}

    to_subscribe = desired_symbols - subscribed_bybit_symbols
    to_unsubscribe = subscribed_bybit_symbols - desired_symbols

    for sym in to_subscribe:
        msg = json.dumps({"op": "subscribe", "args": [f"tickers.{sym}"]})
        try:
            bybit_ws.send(msg)
            print(f"[BYBIT] Subscribed to {sym}")
        except Exception as e:
            print(f"[BYBIT] Subscribe error {sym}: {e}")

    for sym in to_unsubscribe:
        msg = json.dumps({"op": "unsubscribe", "args": [f"tickers.{sym}"]})
        try:
            bybit_ws.send(msg)
            print(f"[BYBIT] Unsubscribed from {sym}")
        except Exception as e:
            print(f"[BYBIT] Unsubscribe error {sym}: {e}")

    subscribed_bybit_symbols = desired_symbols

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
        "reply_markup": keyboard
    }
    try:
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print(f"[TG ERROR] {e}")

# ===============================
# ALERT CHECK
# ===============================
def check_all_alerts():
    alerts = get_active_alerts()
    for alert in alerts:
        alert_id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price = alert
        target_price = float(target_price)
        if symbol not in prices[exchange]:
            continue
        current_price = prices[exchange][symbol]
        prev_price = prev_prices[exchange].get(symbol, current_price)

        triggered = False
        if (prev_price < target_price <= current_price) or (prev_price > target_price >= current_price):
            triggered = True

        if triggered:
            message = f"🚨 <b>ALERT {exchange.upper()} {symbol}</b>\nPrice reached: <b>{current_price:.8f}</b>\nTarget: <b>{target_price:.8f}</b>"
            if horiz_price is not None:
                message += f"\nSynchronized line: <b>{horiz_price:.8f}</b>"
            send_telegram(bot_token, chat_id, message, exchange, symbol)
            mark_triggered(alert_id)
            print(f"[TRIGGERED] {device_id} {exchange} {symbol} at {current_price}")

            if exchange == "bybit":
                refresh_bybit_subscriptions()

        prev_prices[exchange][symbol] = current_price

def alert_checker_thread():
    while True:
        time.sleep(2)
        check_all_alerts()

# ===============================
# WEBSOCKET BYBIT (V5)
# ===============================
def bybit_ws_thread():
    global bybit_ws, subscribed_bybit_symbols
    url = "wss://stream.bybit.com/v5/public/linear"

    def on_open(ws):
        global bybit_ws, subscribed_bybit_symbols
        bybit_ws = ws
        subscribed_bybit_symbols = set()
        print("[BYBIT] Connected")
        refresh_bybit_subscriptions()

    def on_message(ws, message):
        try:
            data = json.loads(message)
            if data.get("topic", "").startswith("tickers."):
                symbol = data["topic"].split(".")[1]
                price_data = data.get("data", {})
                if isinstance(price_data, dict):
                    price = float(price_data.get("lastPrice", 0))
                    if price > 0:
                        prices["bybit"][symbol] = price
        except Exception as e:
            print(f"[BYBIT MSG ERROR] {e}")

    def on_error(ws, error):
        print(f"[BYBIT ERROR] {error}")

    def on_close(ws, *args):
        global bybit_ws
        bybit_ws = None
        print("[BYBIT] Closed, reconnecting in 5s...")
        time.sleep(5)
        bybit_ws_thread()

    ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                on_error=on_error, on_close=on_close)
    ws.run_forever()

# ===============================
# WEBSOCKET BINANCE
# ===============================
def binance_ws_thread():
    url = "wss://fstream.binance.com/ws/!ticker@arr"

    def on_open(ws):
        print("[BINANCE] Connected")

    def on_message(ws, message):
        try:
            data = json.loads(message)
            for ticker in data:
                symbol = ticker["s"]
                if symbol.endswith("USDT"):
                    price = float(ticker["c"])
                    prices["binance"][symbol] = price
        except Exception as e:
            print(f"[BINANCE MSG ERROR] {e}")

    def on_error(ws, error):
        print(f"[BINANCE ERROR] {error}")

    def on_close(ws, *args):
        print("[BINANCE] Closed, reconnecting in 5s...")
        time.sleep(5)
        binance_ws_thread()

    ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                on_error=on_error, on_close=on_close)
    ws.run_forever()

# ===============================
# FLASK APP
# ===============================
app = Flask(__name__)
CORS(app, origins=["https://srazu.vercel.app"])  # Cambia se il tuo frontend ha altro dominio

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
    if not all(k in data for k in ["device_id", "exchange", "symbol"]):
        return jsonify({"error": "missing fields"}), 400
    remove_alert(data["device_id"], data["exchange"], data["symbol"])
    return jsonify({"status": "removed"})

@app.get("/")
def health():
    return "Server alive"

# Endpoint debug (rimuovilo o proteggilo in produzione)
@app.get("/list_alerts")
def list_alerts():
    alerts = get_active_alerts()
    return jsonify([{
        "id": a[0],
        "device_id": a[1],
        "exchange": a[4],
        "symbol": a[5],
        "target_price": a[6],
        "horiz_price": a[7] if a[7] is not None else None
    } for a in alerts])

@app.get("/open_trade")
def open_trade():
    exchange = request.args.get("exchange")
    symbol = request.args.get("symbol")
    if not exchange or not symbol:
        return "Missing parameters", 400

    user_agent = request.headers.get('User-Agent', '').lower()
    is_mobile = any(k in user_agent for k in ['mobile', 'android', 'iphone', 'ipad', 'windows phone'])

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
    threading.Thread(target=alert_checker_thread, daemon=True).start()
    threading.Thread(target=bybit_ws_thread, daemon=True).start()
    threading.Thread(target=binance_ws_thread, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT)
