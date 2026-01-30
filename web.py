import os
import sqlite3
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS

DB_PATH = "/data/alerts.db"
PORT = int(os.environ.get("PORT", 10000))

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
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

app = Flask(__name__)
CORS(app)

@app.get("/")
def health():
    return "Bot Online. Vai su /view_alerts"

@app.get("/view_alerts")
def view_alerts():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT exchange, symbol, target_price, status FROM alerts ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    res = "<h1>Alert Attivi</h1>"
    for r in rows:
        res += f"<p>{r[0].upper()} - {r[1]}: <b>{r[2]}</b> ({r[3]})</p>"
    return res

@app.post("/add_alert")
def add_alert():
    data = request.get_json()
    symbol = data['symbol'].upper().strip() # Pulizia nome
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT INTO alerts (device_id, bot_token, chat_id, exchange, symbol, target_price, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(device_id, exchange, symbol) DO UPDATE SET
            target_price=excluded.target_price, status='active', triggered_at=NULL
    """, (data['device_id'], data['bot_token'], data['chat_id'], data['exchange'].lower(), symbol, data['target_price']))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

@app.get("/open_trade")
def open_trade():
    ex, sy = request.args.get("exchange"), request.args.get("symbol")
    url = f"https://www.binance.com/en/futures/{sy}" if ex == "binance" else f"https://www.bybit.com/trade/usdt/{sy}"
    return redirect(url)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
