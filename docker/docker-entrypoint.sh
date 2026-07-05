#!/bin/sh
set -e

# nginx демонизируется сам (без "daemon off") и слушает 443, терминируя TLS
# сертификатом Cloudflare Origin CA; проксирует /sub и остальные NestJS-пути
# на localhost:3000, всё остальное — на Xray (localhost:8880, VLESS+WS).
nginx -c /etc/nginx/nginx.conf

exec node dist/src/main.js
