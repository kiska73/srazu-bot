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
        device_id TEXT,
        bot_token TEXT,
        chat_id TEXT,
        exchange TEXT,
        symbol TEXT,
        target_price REAL,
        status TEXT DEFAULT 'active',
        triggered_at TIMESTAMP,
        UNIQUE(device_id, exchange, symbol)
    )''')
    conn.commit()
    conn.close()

init_db()
app = Flask(__name__)
CORS(app)

@app.route("/")
def health(): return "Srazu Bot Online"

@app.post("/add_alert")
def add_alert():
    data = request.get_json()
    sy = data['symbol'].upper().strip()
    ex = data['exchange'].lower().strip()
    
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Eliminiamo vecchi alert per la stessa coppia per sicurezza
    c.execute("DELETE FROM alerts WHERE device_id=? AND exchange=? AND symbol=?", (data['device_id'], ex, sy))
    # Inseriamo il nuovo alert come 'active'
    c.execute("""
        INSERT INTO alerts (device_id, bot_token, chat_id, exchange, symbol, target_price, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
    """, (data['device_id'], data['bot_token'], data['chat_id'], ex, sy, data['target_price']))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok", "msg": f"Alert {sy} attivato"})

@app.get("/open_trade")
def open_trade():
    ex, sy = request.args.get("exchange"), request.args.get("symbol")
    url = f"https://www.binance.com/en/futures/{sy}" if ex == "binance" else f"https://www.bybit.com/trade/usdt/{sy}"
    return redirect(url)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
