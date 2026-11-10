#!/bin/sh
set -e

STEAL_PORT="$XRAY_INTERNAL_STEAL_PORT"

if [ -z "$STEAL_PORT" ]; then
  echo "XRAY_INTERNAL_STEAL_PORT не задан — nginx не запускается, Reality слушает публичный порт напрямую"
  exec node dist/src/main.js
fi

STEAL_CERT=/app/configs/steal-cert.pem
STEAL_KEY=/app/configs/steal-key.pem
if [ ! -f "$STEAL_CERT" ] || [ ! -f "$STEAL_KEY" ]; then
  echo "Нет сертификата self-steal домена: положите $STEAL_CERT и $STEAL_KEY" >&2
  exit 1
fi
if [ "$XRAY_REALITY_DEST" != "127.0.0.1:$STEAL_PORT" ]; then
  echo "ВНИМАНИЕ: XRAY_INTERNAL_STEAL_PORT=$STEAL_PORT, а XRAY_REALITY_DEST=$XRAY_REALITY_DEST — Reality ходит не на сайт-маску" >&2
fi

PUBLIC_PORT="${XRAY_REALITY_PORT:-443}"

sed -e "s/__STEAL_PORT__/${STEAL_PORT}/g" \
    -e "s/__PUBLIC_PORT__/${PUBLIC_PORT}/g" \
    -e "s/__REALITY_PORT__/${XRAY_INTERNAL_REALITY_PORT:-8444}/g" \
    -e "s/__APP_PORT__/${PORT:-3000}/g" \
    /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

nginx -t
# nginx демонизируется сам (без "daemon off").
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
