import os
import sqlite3
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS

# Il percorso punta al disco persistente di Render
DB_PATH = "/data/alerts.db"
PORT = int(os.environ.get("PORT", 10000))
SERVER_DOMAIN = "https://srazu-bot.onrender.com"

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
    return f"Server Online. Controlla gli alert su: {SERVER_DOMAIN}/view_alerts"

@app.get("/view_alerts")
def view_alerts():
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT device_id, exchange, symbol, target_price, status, triggered_at FROM alerts ORDER BY id DESC")
        rows = c.fetchall()
        conn.close()
        
        html = "<html><head><style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f2f2f2}</style></head><body>"
        html += "<h1>Alert nel Database</h1><table><tr><th>Device</th><th>Exchange</th><th>Symbol</th><th>Target</th><th>Status</th><th>Data Trigger</th></tr>"
        for r in rows:
            html += f"<tr><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td>{r[4]}</td><td>{r[5] if r[5] else '-'}</td></tr>"
        html += "</table><p><a href='/'>Indietro</a></p></body></html>"
        return html
    except Exception as e:
        return f"Errore lettura DB: {str(e)}"

@app.post("/add_alert")
def add_alert():
    data = request.get_json()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT INTO alerts (device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price, condition, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(device_id, exchange, symbol) DO UPDATE SET
            target_price=excluded.target_price, bot_token=excluded.bot_token, chat_id=excluded.chat_id, status='active', triggered_at=NULL
    """, (data['device_id'], data['bot_token'], data['chat_id'], data['exchange'], data['symbol'], data['target_price'], data.get('horiz_price'), data.get('condition', 'cross')))
    conn.commit()
    conn.close()
    return jsonify({"status": "ok"})

@app.post("/remove_alert")
def remove_alert():
    data = request.get_json()
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM alerts WHERE device_id=? AND exchange=? AND symbol=?", (data["device_id"], data["exchange"], data["symbol"]))
    conn.commit()
    conn.close()
    return jsonify({"status": "removed"})

@app.get("/open_trade")
def open_trade():
    ex, sy = request.args.get("exchange"), request.args.get("symbol")
    if ex == "binance": url = f"https://www.binance.com/en/futures/{sy}"
    else: url = f"https://www.bybit.com/trade/usdt/{sy}"
    return redirect(url)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
