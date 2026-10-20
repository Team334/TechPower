#!/bin/sh
# Serves the app at http://localhost:8000 (any static file server works).
cd "$(dirname "$0")/web" && exec python3 -m http.server 8000
