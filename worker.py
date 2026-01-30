import json
import time
import sqlite3
import threading
import websocket
import requests
import os
from datetime import datetime

DB_PATH = "/data/alerts.db"
SERVER_DOMAIN = "https://srazu-bot.onrender.com"

prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}
bybit_ws = None

def get_active_alerts():
    if not os.path.exists(DB_PATH): return []
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, bot_token, chat_id, exchange, symbol, target_price FROM alerts WHERE status='active'")
    rows = c.fetchall()
    conn.close()
    return rows

def mark_triggered(alert_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE alerts SET status='triggered', triggered_at=? WHERE id=?", (datetime.now(), alert_id))
    conn.commit()
    conn.close()

def send_telegram(token, chat_id, msg, ex, sy):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    trade_url = f"{SERVER_DOMAIN}/open_trade?exchange={ex}&symbol={sy}"
    payload = {"chat_id": chat_id, "text": msg, "parse_mode": "HTML", 
               "reply_markup": {"inline_keyboard": [[{"text": "APRI TRADE", "url": trade_url}]]}}
    try: requests.post(url, json=payload, timeout=10)
    except: pass

def check_alerts():
    alerts = get_active_alerts()
    for alert in alerts:
        aid, token, cid, ex, sy, target = alert
        if sy not in prices[ex]: continue
        
        curr = prices[ex][sy]
        prev = prev_prices[ex].get(sy, curr)
        
        if (prev < target <= curr) or (prev > target >= curr):
            msg = f"🚨 <b>TARGET COLPITO!</b>\n{ex.upper()} {sy}\nPrezzo: {curr}"
            send_telegram(token, cid, msg, ex, sy)
            mark_triggered(aid)
            print(f"[TRIGGER] {sy} at {curr}")
        
        prev_prices[ex][sy] = curr

def bybit_thread():
    def on_message(ws, msg):
        d = json.loads(msg)
        if "topic" in d:
            sy = d["topic"].split(".")[1]
            prices["bybit"][sy] = float(d["data"]["lastPrice"])
    
    def on_open(ws):
        print("[BYBIT] Connesso")
        als = get_active_alerts()
        for a in set(al[4] for al in als if al[3] == "bybit"):
            ws.send(json.dumps({"op": "subscribe", "args": [f"tickers.{a}"]}))

    websocket.WebSocketApp("wss://stream.bybit.com/v5/public/linear", on_open=on_open, on_message=on_message).run_forever()

def binance_thread():
    def on_message(ws, msg):
        for t in json.loads(msg):
            if t['s'].endswith("USDT"): prices["binance"][t['s']] = float(t['c'])
    websocket.WebSocketApp("wss://fstream.binance.com/ws/!ticker@arr", on_message=on_message).run_forever()

if __name__ == "__main__":
    threading.Thread(target=bybit_thread, daemon=True).start()
    threading.Thread(target=binance_thread, daemon=True).start()
    print("--- WORKER ATTIVO ---")
    while True:
        try:
            check_alerts()
            # Auto-sottoscrizione nuovi simboli Bybit
            if len(get_active_alerts()) > 0:
                pass # Aggiungi logica sub dinamica se necessario
        except: pass
        time.sleep(2)
