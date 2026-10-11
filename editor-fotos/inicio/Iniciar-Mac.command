#!/bin/bash
# Doble clic para abrir el editor en Mac. Arranca un servidor local y abre Google Chrome.
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Falta instalar Node.js (https://nodejs.org, versión LTS). Instálalo y vuelve a abrir este archivo."
  read -n 1 -s -r -p "Pulsa una tecla para cerrar…"; exit 1
fi
PORT=8080
if lsof -i :$PORT >/dev/null 2>&1; then echo "El editor ya estaba en marcha."; else
  node tests/serve.mjs $PORT > /tmp/editor-fotos.log 2>&1 &
  sleep 1
fi
URL="http://localhost:$PORT/"
if [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$URL"; else open "$URL"; echo "Aviso: para el modo automático necesitas Google Chrome o Edge."; fi
echo "Editor abierto en $URL — deja esta ventana abierta mientras lo uses (ciérrala para apagarlo)."
wait
