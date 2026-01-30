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
subscribed = set()
ws_bybit = None

def get_active_alerts():
    if not os.path.exists(DB_PATH): return []
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id, bot_token, chat_id, exchange, symbol, target_price FROM alerts WHERE status='active'")
        rows = c.fetchall()
        conn.close()
        return rows
    except: return []

def set_triggered(aid):
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.cursor().execute("UPDATE alerts SET status='triggered', triggered_at=? WHERE id=?", (datetime.now(), aid))
        conn.commit()
        conn.close()
    except: pass

def check_prices():
    alerts = get_active_alerts()
    for alert in alerts:
        aid, token, cid, ex, sy, target = alert
        if sy not in prices[ex]: continue
        
        curr = prices[ex][sy]
        prev = prev_prices[ex].get(sy)
        
        if prev is None:
            prev_prices[ex][sy] = curr
            continue

        # Scatta solo se il prezzo "attraversa" il target
        crossed = (prev < target <= curr) or (prev > target >= curr)
        
        if crossed:
            print(f"🎯 ALERT SCATTATO: {sy} a {curr}")
            # 1. Disattiviamo SUBITO l'alert nel DB per non mandare altri messaggi
            set_triggered(aid)
            
            # 2. Mandiamo il messaggio
            msg = f"🚨 <b>{ex.upper()} TARGET COLPITO!</b>\nCoppia: {sy}\nPrezzo: {curr}\nTarget: {target}"
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            try:
                requests.post(url, json={"chat_id": cid, "text": msg, "parse_mode": "HTML"}, timeout=5)
            except: pass
            
        prev_prices[ex][sy] = curr

# --- WEBSOCKETS ---
def on_msg_bybit(ws, m):
    d = json.loads(m)
    if "data" in d and "lastPrice" in d["data"]:
        sy = d["topic"].split(".")[1]
        prices["bybit"][sy] = float(d["data"]["lastPrice"])

def bybit_run():
    global ws_bybit
    def on_open(ws):
        global ws_bybit
        ws_bybit = ws
        print("Bybit WebSocket Online")
    ws_bybit = websocket.WebSocketApp("wss://stream.bybit.com/v5/public/linear", on_open=on_open, on_message=on_msg_bybit)
    ws_bybit.run_forever()

def binance_run():
    def on_m(ws, m):
        for t in json.loads(m): prices["binance"][t['s']] = float(t['c'])
    websocket.WebSocketApp("wss://fstream.binance.com/ws/!ticker@arr", on_message=on_m).run_forever()

if __name__ == "__main__":
    threading.Thread(target=bybit_run, daemon=True).start()
    threading.Thread(target=binance_run, daemon=True).start()
    
    print("🚀 WORKER IN ASCOLTO 24/7...")
    while True:
        check_prices()
        # Iscrizione dinamica Bybit
        if ws_bybit and ws_bybit.sock and ws_bybit.sock.connected:
            for al in get_active_alerts():
                if al[3] == "bybit" and al[4] not in subscribed:
                    ws_bybit.send(json.dumps({"op": "subscribe", "args": [f"tickers.{al[4]}"]}))
                    subscribed.add(al[4])
        time.sleep(1)
