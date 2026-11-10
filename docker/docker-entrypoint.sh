#!/bin/sh
set -e

STEAL_PORT="$XRAY_INTERNAL_STEAL_PORT"

if [ -z "$STEAL_PORT" ]; then
  if [ -n "$SUB_TLS_PORT" ]; then
    echo "ВНИМАНИЕ: SUB_TLS_PORT задан, но nginx не запускается без XRAY_INTERNAL_STEAL_PORT — публичного входа для подписки не будет" >&2
  fi
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

# Публичный HTTPS для подписки. Без SUB_TLS_PORT подписка наружу не отдаётся:
# кнопка в боте честно сообщит, что ссылка недоступна.
mkdir -p /etc/nginx/sub
rm -f /etc/nginx/sub/*.conf
if [ -n "$SUB_TLS_PORT" ]; then
  if [ ! -f /app/configs/cloudflare-cert.pem ] || [ ! -f /app/configs/cloudflare-key.pem ]; then
    echo "SUB_TLS_PORT задан, но нет origin-сертификата Cloudflare: положите /app/configs/cloudflare-cert.pem и cloudflare-key.pem" >&2
    exit 1
  fi
  sed -e "s/__SUB_TLS_PORT__/${SUB_TLS_PORT}/g" \
      -e "s/__SUB_HOST__/${SUB_HOST:-_}/g" \
      -e "s/__APP_PORT__/${PORT:-3000}/g" \
      /etc/nginx/sub.conf.template > /etc/nginx/sub/sub.conf
fi

sed -e "s/__STEAL_PORT__/${STEAL_PORT}/g" \
    -e "s/__PUBLIC_PORT__/${PUBLIC_PORT}/g" \
    -e "s/__REALITY_PORT__/${XRAY_INTERNAL_REALITY_PORT:-8444}/g" \
    -e "s/__APP_PORT__/${PORT:-3000}/g" \
    /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

nginx -t
# nginx демонизируется сам (без "daemon off").
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
