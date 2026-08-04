#!/bin/sh
set -e

# nginx слушает 443 в режиме stream и по SNI разводит трафик: домен CDN — на
# свой же TLS-сервер (localhost:8444, дальше NestJS и VLESS+WS), всё остальное —
# в Reality на localhost:8443. Домен известен только из .env, поэтому шаблон
# конфига подставляется на старте.
if [ -z "$XRAY_DOMAIN" ]; then
  echo "XRAY_DOMAIN не задан — nginx не сможет развести трафик по SNI" >&2
  exit 1
fi

sed "s/__XRAY_DOMAIN__/${XRAY_DOMAIN}/g" \
  /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Падать сразу, а не после старта Nest: без nginx наружу не работает ни один канал.
nginx -t
# nginx демонизируется сам (без "daemon off").
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
