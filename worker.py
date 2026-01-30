import json
import time
import sqlite3
import threading
import websocket
import requests
import os
from datetime import datetime

# --- CONFIGURAZIONE DISCO PERSISTENTE ---
DB_PATH = "/data/alerts.db"
SERVER_DOMAIN = "https://srazu-bot.onrender.com"

prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

bybit_ws = None

# ===============================
# DATABASE
# ===============================
def get_active_alerts():
    # Se il DB non esiste ancora (es. primo avvio), ritorna lista vuota
    if not os.path.exists(DB_PATH):
        return []
        
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            SELECT id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price
            FROM alerts WHERE status='active'
        """)
        rows = c.fetchall()
        conn.close()
        return rows
    except Exception as e:
        print("[DB ERROR]", e)
        return []

def mark_triggered(alert_id):
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            UPDATE alerts SET status='triggered', triggered_at=?
            WHERE id=?
        """, (datetime.now(), alert_id))
        conn.commit()
        conn.close()
    except Exception as e:
        print("[DB MARK ERROR]", e)

# ===============================
# TELEGRAM
# ===============================
def send_telegram(bot_token, chat_id, message, exchange, symbol):
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    trade_url = f"{SERVER_DOMAIN}/open_trade?exchange={exchange}&symbol={symbol}"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "reply_markup": {
            "inline_keyboard": [[
                {"text": "Open Trade Now", "url": trade_url}
            ]]
        }
    }
    try:
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print("[TG ERROR]", e)

# ===============================
# ALERT CHECK
# ===============================
def check_all_alerts():
    alerts = get_active_alerts()
    for alert in alerts:
        alert_id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price = alert

        if symbol not in prices[exchange]:
            continue

        current_price = prices[exchange][symbol]
        prev_price = prev_prices[exchange].get(symbol, current_price)

        crossed = (
            prev_price < target_price <= current_price or
            prev_price > target_price >= current_price
        )

        if crossed:
            msg = (
                f"🚨 <b>ALERT {exchange.upper()} {symbol}</b>\n"
                f"Price: <b>{current_price:.8f}</b>\n"
                f"Target: <b>{target_price:.8f}</b>"
            )
            if horiz_price is not None:
                msg += f"\nLine: <b>{horiz_price:.8f}</b>"

            send_telegram(bot_token, chat_id, msg, exchange, symbol)
            mark_triggered(alert_id)
            print("[TRIGGERED]", exchange, symbol, current_price)

        prev_prices[exchange][symbol] = current_price

# ===============================
# BYBIT WS
# ===============================
def bybit_ws_thread():
    global bybit_ws
    url = "wss://stream.bybit.com/v5/public/linear"

    def on_open(ws):
        global bybit_ws
        bybit_ws = ws
        print("[BYBIT] Connected")
        # Iscrizione iniziale
        alerts = get_active_alerts()
        symbols = {a[5] for a in alerts if a[4] == "bybit"}
        for s in symbols:
            try:
                ws.send(json.dumps({"op": "subscribe", "args": [f"tickers.{s}"]}))
            except Exception as e:
                print(f"[BYBIT SUB ERROR] {e}")

    def on_message(ws, message):
        try:
            data = json.loads(message)
            topic = data.get("topic", "")
            if topic.startswith("tickers."):
                symbol = topic.split(".")[1]
                price = float(data["data"].get("lastPrice", 0))
                if price > 0:
                    prices["bybit"][symbol] = price
        except:
            pass

    def on_close(ws, *args):
        print("[BYBIT] Closed. Reconnecting in 5s...")
        time.sleep(5)
        bybit_ws_thread()
    
    def on_error(ws, error):
        print(f"[BYBIT ERROR] {error}")

    websocket.WebSocketApp(
        url,
        on_open=on_open,
        on_message=on_message,
        on_close=on_close,
        on_error=on_error
    ).run_forever()

# ===============================
# BINANCE WS
# ===============================
def binance_ws_thread():
    url = "wss://fstream.binance.com/ws/!ticker@arr"

    def on_message(ws, message):
        try:
            data = json.loads(message)
            for t in data:
                s = t["s"]
                if s.endswith("USDT"):
                    prices["binance"][s] = float(t["c"])
        except:
            pass

    def on_close(ws, *args):
        print("[BINANCE] Closed. Reconnecting in 5s...")
        time.sleep(5)
        binance_ws_thread()
    
    def on_error(ws, error):
        print(f"[BINANCE ERROR] {error}")

    websocket.WebSocketApp(
        url,
        on_message=on_message,
        on_close=on_close,
        on_error=on_error
    ).run_forever()

# ===============================
# MAIN LOOP
# ===============================
def main():
    # Avvia i thread WS
    t1 = threading.Thread(target=bybit_ws_thread)
    t1.daemon = True
    t1.start()
    
    t2 = threading.Thread(target=binance_ws_thread)
    t2.daemon = True
    t2.start()

    print("Worker started. Monitoring alerts on /data/alerts.db")

    while True:
        try:
            check_all_alerts()
            
            # Periodicamente (ogni 30s) controlliamo se ci sono nuovi simboli Bybit da sottoscrivere
            # Nota: Per Binance usiamo !ticker@arr che prende tutto, quindi non serve risottoscrivere
            if bybit_ws and bybit_ws.sock and bybit_ws.sock.connected:
                alerts = get_active_alerts()
                symbols = {a[5] for a in alerts if a[4] == "bybit"}
                for s in symbols:
                    if s not in prices["bybit"]: # Se non abbiamo ancora il prezzo, forse non siamo iscritti
                         bybit_ws.send(json.dumps({"op": "subscribe", "args": [f"tickers.{s}"]}))

        except Exception as e:
            print(f"[MAIN LOOP ERROR] {e}")
            
        time.sleep(2)

if __name__ == "__main__":
    main()
