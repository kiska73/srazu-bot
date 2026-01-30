#!/bin/bash
# Avvia il worker (log immediati con -u)
python -u worker.py &

# Avvia il server web
gunicorn web:app --bind 0.0.0.0:$PORT
