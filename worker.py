import json
import time
import sqlite3
import threading
import websocket
import requests
import os
from datetime import datetime

DB_PATH = "/data/alerts.db"
prices = {"bybit": {}, "binance": {}}
prev_prices = {"bybit": {}, "binance": {}}
subscribed_symbols = {"bybit": set(), "binance": set()}
ws_bybit = None

def get_active_alerts():
    if not os.path.exists(DB_PATH): return []
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, bot_token, chat_id, exchange, symbol, target_price FROM alerts WHERE status='active'")
    rows = c.fetchall()
    conn.close()
    return rows

def check_alerts():
    alerts = get_active_alerts()
    for alert in alerts:
        aid, token, cid, ex, sy, target = alert
        if sy not in prices[ex]: continue
        
        curr = prices[ex][sy]
        prev = prev_prices[ex].get(sy, curr)
        
        # Logica incrocio (Cross)
        if (prev < target <= curr) or (prev > target >= curr):
            print(f"🎯 TRIGGER! {sy} a {curr}")
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            msg = f"🚨 <b>TARGET {sy} COLPITO!</b>\nPrezzo: {curr}"
            try:
                requests.post(url, json={"chat_id": cid, "text": msg, "parse_mode": "HTML"}, timeout=5)
                conn = sqlite3.connect(DB_PATH)
                conn.cursor().execute("UPDATE alerts SET status='triggered', triggered_at=? WHERE id=?", (datetime.now(), aid))
                conn.commit()
                conn.close()
            except: pass
        prev_prices[ex][sy] = curr

def on_message_bybit(ws, msg):
    d = json.loads(msg)
    if "topic" in d:
        sy = d["topic"].split(".")[1]
        prices["bybit"][sy] = float(d["data"]["lastPrice"])

def bybit_thread():
    global ws_bybit
    def on_open(ws):
        global ws_bybit
        ws_bybit = ws
        print("✅ WebSocket Bybit Connesso")
    ws_bybit = websocket.WebSocketApp("wss://stream.bybit.com/v5/public/linear", on_open=on_open, on_message=on_message_bybit)
    ws_bybit.run_forever()

def binance_thread():
    def on_message(ws, msg):
        for t in json.loads(msg):
            prices["binance"][t['s']] = float(t['c'])
    websocket.WebSocketApp("wss://fstream.binance.com/ws/!ticker@arr", on_message=on_message).run_forever()

if __name__ == "__main__":
    threading.Thread(target=bybit_thread, daemon=True).start()
    threading.Thread(target=binance_thread, daemon=True).start()
    
    print("🚀 WORKER MONITORING START")
    while True:
        try:
            check_alerts()
            # Gestione iscrizioni dinamiche Bybit
            if ws_bybit and ws_bybit.sock and ws_bybit.sock.connected:
                active_als = get_active_alerts()
                for al in active_als:
                    if al[3] == "bybit" and al[4] not in subscribed_symbols["bybit"]:
                        ws_bybit.send(json.dumps({"op": "subscribe", "args": [f"tickers.{al[4]}"]}))
                        subscribed_symbols["bybit"].add(al[4])
                        print(f"📡 Iscritto a nuova coppia Bybit: {al[4]}")
        except Exception as e:
            print(f"Error: {e}")
        time.sleep(1) # Controllo ogni secondo per massima velocità
