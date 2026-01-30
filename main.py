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
DB_PATH = os.environ.get("DB_PATH", "/data/alerts.db")  # Usa il disco persistente
PORT = int(os.environ.get("PORT", 5000))

# Cambia con il tuo dominio Render (o imposta env SERVER_DOMAIN)
SERVER_DOMAIN = os.environ.get("SERVER_DOMAIN", "https://srazu-bot.onrender.com")

# Prezzi in RAM + prev_price per cross detection
prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

# WebSocket global
bybit_ws = None

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
        subscribe_bybit_symbol(data['symbol'])

def remove_alert(device_id, exchange, symbol):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE alerts SET status='cancelled' WHERE device_id=? AND exchange=? AND symbol=?",
              (device_id, exchange, symbol))
    conn.commit()
    conn.close()

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
    c.execute("UPDATE alerts SET status='triggered', triggered_at=DATETIME('now') WHERE id=?", (alert_id,))
    conn.commit()
    conn.close()

# ===============================
# BYBIT SUBSCRIBE
# ===============================
def subscribe_bybit_symbol(symbol):
    global bybit_ws
    if bybit_ws and bybit_ws.sock and bybit_ws.sock.connected:
        try:
            msg = json.dumps({"op": "subscribe", "args": [f"tickers.{symbol}"]})
            bybit_ws.send(msg)
            print(f"[BYBIT] Subscribed to {symbol}")
        except Exception as e:
            print(f"[BYBIT] Subscribe error: {e}")

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
def check_all_alerts():
    alerts = get_active_alerts()
    if not alerts:
        return

    for alert in alerts:
        alert_id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price = alert
        target_price = float(target_price)

        if symbol not in prices[exchange]:
            continue
        current_price = prices[exchange][symbol]
        prev_price = prev_prices[exchange].get(symbol, current_price)

        # Cross detection
        triggered = (prev_price < target_price <= current_price) or (prev_price > target_price >= current_price)

        if triggered:
            message = f"🚨 <b>ALERT {exchange.upper()} {symbol}</b>\nPrice reached: <b>{current_price:.8f}</b>\nTarget: <b>{target_price:.8f}</b>"
            if horiz_price is not None:
                message += f"\nSynchronized line: <b>{horiz_price:.8f}</b>"
            send_telegram(bot_token, chat_id, message, exchange, symbol)
            mark_triggered(alert_id)
            print(f"[{datetime.now()}] [TRIGGERED] {device_id} {exchange} {symbol} @ {current_price}")

        # Aggiorna prev_price
        prev_prices[exchange][symbol] = current_price

# ===============================
# BYBIT WEBSOCKET + PING
# ===============================
def bybit_ping_thread():
    while True:
        time.sleep(15)
        global bybit_ws
        if bybit_ws and bybit_ws.sock and bybit_ws.sock.connected:
            try:
                bybit_ws.send(json.dumps({"op": "ping"}))
                print(f"[{datetime.now()}] [BYBIT] Ping sent")
            except:
                pass

def bybit_ws_thread():
    global bybit_ws
    url = "wss://stream.bybit.com/v5/public/linear"

    def on_open(ws):
        global bybit_ws
        bybit_ws = ws
        print(f"[{datetime.now()}] [BYBIT] Connected")
        alerts = get_active_alerts()
        symbols = {row[5] for row in alerts if row[4] == "bybit"}
        for sym in symbols:
            ws.send(json.dumps({"op": "subscribe", "args": [f"tickers.{sym}"]}))
            print(f"[BYBIT] Subscribed to {sym}")

    def on_message(ws, message):
        try:
            data = json.loads(message)
            if data.get("topic", "").startswith("tickers."):
                symbol = data["topic"].split(".")[1]
                price_data = data.get("data", {})
                if isinstance(price_data, dict):
                    price_str = price_data.get("lastPrice")
                    if price_str:
                        price = float(price_str)
                        if price > 0:
                            prices["bybit"][symbol] = price
                            check_all_alerts()
        except Exception as e:
            print(f"[BYBIT MSG ERROR] {e}")

    def on_error(ws, error):
        print(f"[{datetime.now()}] [BYBIT ERROR] {error}")

    def on_close(ws, *args):
        global bybit_ws
        bybit_ws = None
        print(f"[{datetime.now()}] [BYBIT] Closed → reconnecting...")
        time.sleep(5)
        bybit_ws_thread()

    ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                on_error=on_error, on_close=on_close)
    ws.run_forever(ping_timeout=10)

# ===============================
# BINANCE WEBSOCKET
# ===============================
def binance_ws_thread():
    url = "wss://fstream.binance.com/ws/!ticker@arr"

    def on_open(ws):
        print(f"[{datetime.now()}] [BINANCE] Connected")

    def on_message(ws, message):
        try:
            data = json.loads(message)
            if isinstance(data, list):
                for ticker in data:
                    symbol = ticker.get("s")
                    if symbol and symbol.endswith("USDT"):
                        price_str = ticker.get("c")
                        if price_str:
                            price = float(price_str)
                            prices["binance"][symbol] = price
                check_all_alerts()  # Una sola volta dopo tutti gli aggiornamenti
        except Exception as e:
            print(f"[BINANCE MSG ERROR] {e}")

    def on_error(ws, error):
        print(f"[{datetime.now()}] [BINANCE ERROR] {error}")

    def on_close(ws, *args):
        print(f"[{datetime.now()}] [BINANCE] Closed → reconnecting...")
        time.sleep(5)
        binance_ws_thread()

    ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                on_error=on_error, on_close=on_close)
    ws.run_forever(ping_interval=20, ping_timeout=10)

# ===============================
# FLASK APP
# ===============================
app = Flask(__name__)
CORS(app, origins=["*"])  # Cambia con il tuo dominio frontend in produzione

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
    # Thread
    threading.Thread(target=bybit_ping_thread, daemon=True).start()
    threading.Thread(target=bybit_ws_thread, daemon=True).start()
    threading.Thread(target=binance_ws_thread, daemon=True).start()

    # Flask (su Render usa gunicorn automaticamente se presente)
    app.run(host="0.0.0.0", port=PORT)
