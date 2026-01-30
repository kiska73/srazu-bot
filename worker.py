import json
import time
import sqlite3
import threading
import websocket
import requests
from datetime import datetime

DB_PATH = "alerts.db"
SERVER_DOMAIN = "https://srazu-bot.onrender.com"

prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}

bybit_ws = None

# ===============================
# DATABASE
# ===============================
def get_active_alerts():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        SELECT id, device_id, bot_token, chat_id, exchange, symbol, target_price, horiz_price
        FROM alerts WHERE status='active'
    """)
    rows = c.fetchall()
    conn.close()
    return rows

def mark_triggered(alert_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        UPDATE alerts SET status='triggered', triggered_at=?
        WHERE id=?
    """, (datetime.now(), alert_id))
    conn.commit()
    conn.close()

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
        alerts = get_active_alerts()
        symbols = {a[5] for a in alerts if a[4] == "bybit"}
        for s in symbols:
            ws.send(json.dumps({"op": "subscribe", "args": [f"tickers.{s}"]}))

    def on_message(ws, message):
        data = json.loads(message)
        topic = data.get("topic", "")
        if topic.startswith("tickers."):
            symbol = topic.split(".")[1]
            price = float(data["data"].get("lastPrice", 0))
            if price > 0:
                prices["bybit"][symbol] = price

    def on_close(ws, *args):
        print("[BYBIT] Reconnecting...")
        time.sleep(5)
        bybit_ws_thread()

    websocket.WebSocketApp(
        url,
        on_open=on_open,
        on_message=on_message,
        on_close=on_close
    ).run_forever()

# ===============================
# BINANCE WS
# ===============================
def binance_ws_thread():
    url = "wss://fstream.binance.com/ws/!ticker@arr"

    def on_message(ws, message):
        data = json.loads(message)
        for t in data:
            s = t["s"]
            if s.endswith("USDT"):
                prices["binance"][s] = float(t["c"])

    def on_close(ws, *args):
        print("[BINANCE] Reconnecting...")
        time.sleep(5)
        binance_ws_thread()

    websocket.WebSocketApp(
        url,
        on_message=on_message,
        on_close=on_close
    ).run_forever()

# ===============================
# MAIN LOOP (IMPORTANTISSIMO)
# ===============================
def main():
    threading.Thread(target=bybit_ws_thread).start()
    threading.Thread(target=binance_ws_thread).start()

    while True:
        check_all_alerts()
        time.sleep(5)

if __name__ == "__main__":
    main()
