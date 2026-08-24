#!/bin/sh
set -e

# nginx нужен только ради CDN-канала: он слушает публичный порт и по SNI
# разводит трафик — домен уходит на свой TLS-сервер (дальше NestJS и VLESS+WS),
# всё остальное в Reality. Без XRAY_DOMAIN разводить нечего: Reality тогда
# слушает публичный порт сам (см. XrayService.behindProxy), и nginx не нужен.
if [ -z "$XRAY_DOMAIN" ]; then
  echo "XRAY_DOMAIN не задан — nginx не запускается, Reality слушает публичный порт напрямую"
  exec node dist/src/main.js
fi

CERT=/app/configs/cloudflare-cert.pem
KEY=/app/configs/cloudflare-key.pem

# Падаем сразу, а не после старта Nest: без сертификата nginx не поднимется, и
# CDN-канал молча не заработал бы — Cloudflare отдавал бы клиентам 5xx.
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "Нет сертификата Cloudflare Origin CA: положите $CERT и $KEY" >&2
  exit 1
fi

PUBLIC_PORT="${XRAY_REALITY_PORT:-443}"
LINK_PORT="${XRAY_PORT:-443}"

# nginx слушает один публичный порт на оба канала, поэтому порт в ссылках
# CDN-канала обязан совпадать с ним — иначе клиенты стучатся туда, где никто
# не слушает. Это предупреждение, а не ошибка: порты могут расходиться
# намеренно, если перед сервером стоит ещё один прокси.
if [ "$PUBLIC_PORT" != "$LINK_PORT" ]; then
  echo "ВНИМАНИЕ: XRAY_PORT=$LINK_PORT, а nginx слушает $PUBLIC_PORT — ссылки CDN-канала укажут на порт, который здесь не обслуживается" >&2
fi

sed -e "s/__XRAY_DOMAIN__/${XRAY_DOMAIN}/g" \
    -e "s/__PUBLIC_PORT__/${PUBLIC_PORT}/g" \
    -e "s/__TLS_PORT__/${NGINX_INTERNAL_TLS_PORT:-8445}/g" \
    -e "s/__REALITY_PORT__/${XRAY_INTERNAL_REALITY_PORT:-8444}/g" \
    -e "s/__WS_PORT__/${XRAY_INTERNAL_WS_PORT:-8880}/g" \
    -e "s/__APP_PORT__/${PORT:-3000}/g" \
    /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Падать сразу, а не после старта Nest: без nginx наружу не работает ни один канал.
nginx -t
# nginx демонизируется сам (без "daemon off").
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
