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
DB_PATH = os.environ.get("DB_PATH", "/data/alerts.db")
PORT = int(os.environ.get("PORT", 5000))

SERVER_DOMAIN = os.environ.get("SERVER_DOMAIN", "https://srazu-bot.onrender.com")

prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

bybit_ws = None
# binance_ws = None  # Disabilitato perché usi solo Bybit

last_price_update = datetime.now()

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
    
    print(f"[DISK] /data esiste? {os.path.exists('/data')}")
    if os.path.exists('/data'):
        print(f"[DISK] Contenuti /data: {os.listdir('/')}")
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

    if data['exchange'] == "bybit":
        subscribe_bybit_symbol(data['symbol'])

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
# BYBIT
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

def send_telegram(bot_token, chat_id, message, exchange, symbol):
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    trade_url = f"{SERVER_DOMAIN}/open_trade?exchange={exchange}&symbol={symbol}"
    keyboard = {"inline_keyboard": [[{"text": "Open Trade Now", "url": trade_url}]]}
    payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML", "reply_markup": json.dumps(keyboard)}
    try:
        r = requests.post(url, json=payload, timeout=10)
        if r.status_code != 200:
            print(f"[TG ERROR] {r.text}")
    except Exception as e:
        print(f"[TG ERROR] {e}")

def check_all_alerts():
    global last_price_update
    alerts = get_active_alerts()
    if not alerts:
        return

    updated_symbols = set()

    for alert in alerts:
        alert_id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price = alert
        target_price = float(target_price)

        if symbol not in prices[exchange]:
            continue
        current_price = prices[exchange][symbol]
        prev_price = prev_prices[exchange].get(symbol, current_price)

        triggered = (prev_price < target_price <= current_price) or (prev_price > target_price >= current_price)

        if triggered:
            message = f"🚨 <b>ALERT {exchange.upper()} {symbol}</b>\nPrice reached: <b>{current_price:.8f}</b>\nTarget: <b>{target_price:.8f}</b>"
            if horiz_price is not None:
                message += f"\nSynchronized line: <b>{horiz_price:.8f}</b>"
            message += f"\n\n⚠️ Alert triggered and cancelled automatically."
            send_telegram(bot_token, chat_id, message, exchange, symbol)
            remove_alert(device_id, exchange, symbol)
            print(f"[{datetime.now()}] [TRIGGERED & CANCELLED] {device_id} {exchange} {symbol} @ {current_price}")
            last_price_update = datetime.now()

        updated_symbols.add((exchange, symbol))

    for exchange, symbol in updated_symbols:
        prev_prices[exchange][symbol] = prices[exchange][symbol]

def bybit_ping_thread():
    while True:
        time.sleep(20)
        global bybit_ws
        if bybit_ws and bybit_ws.sock and bybit_ws.sock.connected:
            try:
                bybit_ws.send(json.dumps({"op": "ping"}))
            except:
                pass

def bybit_ws_thread():
    global bybit_ws, last_price_update
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
        print(f"[{datetime.now()}] [BYBIT] Subscribed totali: {len(symbols)}")

    def on_message(ws, message):
        global last_price_update
        try:
            data = json.loads(message)
            if data.get("topic", "").startswith("tickers."):
                symbol = data["topic"].split(".")[1]
                price_str = data["data"].get("lastPrice")
                if price_str:
                    price = float(price_str)
                    if price > 0:
                        print(f"[{datetime.now()}] [BYBIT UPDATE] {symbol} @ {price:.8f}")
                        prices["bybit"][symbol] = price
                        last_price_update = datetime.now()
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
# MONITOR
# ===============================
def monitor_thread():
    while True:
        time.sleep(60)
        now = datetime.now()
        bybit_conn = bybit_ws.sock.connected if bybit_ws and bybit_ws.sock else False
        bybit_symbols = len(prices["bybit"])
        seconds_since = (now - last_price_update).seconds
        print(f"[{now}] [MONITOR] Bybit WS: {bybit_conn} | Simboli attivi: {bybit_symbols} | Secondi dall'ultimo update: {seconds_since}")

threading.Thread(target=monitor_thread, daemon=True).start()

# ===============================
# FLASK
# ===============================
app = Flask(__name__)
CORS(app, origins=["*"])

# ... (tutte le route Flask uguali al codice precedente, non le ripeto per brevità)

if __name__ == "__main__":
    threading.Thread(target=bybit_ping_thread, daemon=True).start()
    threading.Thread(target=bybit_ws_thread, daemon=True).start()
    # Binance disabilitato: threading.Thread(target=binance_ws_thread, daemon=True).start()

    app.run(host="0.0.0.0", port=PORT)
