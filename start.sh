#!/bin/bash

# 1. Avvia il worker in background (la & alla fine è fondamentale)
# Questo processo controlla i prezzi e manda le notifiche
python worker.py &

# 2. Avvia il server web con Gunicorn (più stabile di python web.py)
# Questo processo risponde alle richieste dell'app e ascolta sulla porta
gunicorn web:app --bind 0.0.0.0:$PORT
