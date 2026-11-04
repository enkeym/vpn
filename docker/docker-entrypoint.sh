#!/bin/sh
set -e

STEAL_PORT="$XRAY_INTERNAL_STEAL_PORT"

# nginx слушает публичный порт и отдаёт его в Reality, а на localhost держит
# HTTP-роутер для zrok: туннель терминирует TLS и проксирует сюда /sub и WS.
# Без XRAY_DOMAIN туннеля нет: Reality слушает публичный порт сам (см.
# XrayService.behindProxy), и nginx не нужен.
if [ -z "$XRAY_DOMAIN" ]; then
  # Сайт-маску self-steal отдаёт nginx: без него Reality-dest — пустой порт, и
  # ни один хендшейк Reality не пройдёт. Лучше не стартовать вовсе.
  if [ -n "$STEAL_PORT" ]; then
    echo "XRAY_INTERNAL_STEAL_PORT задан, но без XRAY_DOMAIN nginx не запускается — сайт-маске негде жить" >&2
    exit 1
  fi
  echo "XRAY_DOMAIN не задан — nginx не запускается, Reality слушает публичный порт напрямую"
  exec node dist/src/main.js
fi

if [ -n "$STEAL_PORT" ]; then
  STEAL_CERT=/app/configs/steal-cert.pem
  STEAL_KEY=/app/configs/steal-key.pem
  # Без сертификата nginx не поднимется, а с ним падают оба канала сразу.
  if [ ! -f "$STEAL_CERT" ] || [ ! -f "$STEAL_KEY" ]; then
    echo "Нет сертификата self-steal домена: положите $STEAL_CERT и $STEAL_KEY" >&2
    exit 1
  fi
  # Предупреждение, а не ошибка: dest может намеренно смотреть на чужой сайт,
  # но тогда сайт-маска на STEAL_PORT никому не нужна.
  if [ "$XRAY_REALITY_DEST" != "127.0.0.1:$STEAL_PORT" ]; then
    echo "ВНИМАНИЕ: XRAY_INTERNAL_STEAL_PORT=$STEAL_PORT, а XRAY_REALITY_DEST=$XRAY_REALITY_DEST — Reality ходит не на сайт-маску" >&2
  fi
  STEAL_SED="s/__STEAL_PORT__/${STEAL_PORT}/g"
else
  STEAL_SED='/__STEAL_BEGIN__/,/__STEAL_END__/d'
fi

PUBLIC_PORT="${XRAY_REALITY_PORT:-443}"

sed -e "$STEAL_SED" \
    -e "s/__PUBLIC_PORT__/${PUBLIC_PORT}/g" \
    -e "s/__TUNNEL_PORT__/${NGINX_INTERNAL_TUNNEL_PORT:-8080}/g" \
    -e "s/__REALITY_PORT__/${XRAY_INTERNAL_REALITY_PORT:-8444}/g" \
    -e "s/__WS_PORT__/${XRAY_INTERNAL_WS_PORT:-8880}/g" \
    -e "s/__APP_PORT__/${PORT:-3000}/g" \
    /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Падать сразу, а не после старта Nest: без nginx наружу не работает ни один канал.
nginx -t
# nginx демонизируется сам (без "daemon off").
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
