import os
import sqlite3
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS

# --- CONFIGURAZIONE DISCO PERSISTENTE ---
# Assicurati che su Render il "Mount Path" del disco sia: /data
DB_PATH = "/data/alerts.db"
PORT = int(os.environ.get("PORT", 5000))
SERVER_DOMAIN = "https://srazu-bot.onrender.com"

# ===============================
# DATABASE
# ===============================
def init_db():
    # Crea la cartella data se non esiste (utile per test locali)
    directory = os.path.dirname(DB_PATH)
    if directory and not os.path.exists(directory):
        os.makedirs(directory, exist_ok=True)
        
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
    c.execute("""
        INSERT INTO alerts 
        (device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price, condition, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(device_id, exchange, symbol) DO UPDATE SET
            target_price=excluded.target_price,
            horiz_price=excluded.horiz_price,
            bot_token=excluded.bot_token,
            chat_id=excluded.chat_id,
            status='active',
            triggered_at=NULL
    """, (
        data['device_id'],
        data['bot_token'],
        data['chat_id'],
        data['exchange'],
        data['symbol'],
        data['target_price'],
        data.get('horiz_price'),
        data.get('condition', 'cross')
    ))
    conn.commit()
    conn.close()

def remove_alert(device_id, exchange, symbol):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        UPDATE alerts SET status='cancelled'
        WHERE device_id=? AND exchange=? AND symbol=?
    """, (device_id, exchange, symbol))
    conn.commit()
    conn.close()

# ===============================
# FLASK
# ===============================
app = Flask(__name__)
CORS(app)

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
    app.run(host="0.0.0.0", port=PORT)
