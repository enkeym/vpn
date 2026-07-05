# ============================================
# Stage 1: Base image with pnpm
# ============================================
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Явная версия pnpm — без поля packageManager в образ подтягивается pnpm 11,
# где onlyBuiltDependencies из package.json отключён → ERR_PNPM_IGNORED_BUILDS.
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# ============================================
# Stage 2: Install dependencies
# ============================================
FROM base AS dependencies
WORKDIR /app

# Установка build-зависимостей для нативных модулей (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Копируем только файлы зависимостей для лучшего кеширования
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ============================================
# Stage 3: Build application
# ============================================
FROM base AS build
WORKDIR /app

# Копируем зависимости из предыдущего stage
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=dependencies /app/node_modules ./node_modules

# Копируем исходный код
COPY tsconfig*.json nest-cli.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

# Генерируем миграции только если их нет (drizzle-kit не трогает БД и данные)
RUN test -n "$(find drizzle -maxdepth 1 -name '*.sql' 2>/dev/null)" || pnpm run generate

# Сборка
RUN pnpm run build

# Удаляем dev-зависимости для production
RUN CI=true pnpm prune --prod

# ============================================
# Stage 4: Fetch Xray-core (VLESS + WS + TLS через Cloudflare CDN)
# ============================================
# Xray-core — чистый Go, статически слинкован, работает на Alpine без glibc.
# Версия закреплена (ARG) — при необходимости бампнуть тегом из релизов
# https://github.com/XTLS/Xray-core/releases.
FROM base AS xray-build
ARG XRAY_VERSION=v1.8.24
WORKDIR /xray
RUN apk add --no-cache curl unzip && \
    curl -fsSL -o xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip xray.zip -d /xray/out && \
    chmod +x /xray/out/xray

# ============================================
# Stage 5: Fetch Hysteria2 (QUIC/UDP, резервный протокол против DPI)
# ============================================
# Hysteria2 — чистый Go, статически слинкован, работает на Alpine без glibc.
# Релизы монорепо тегируются как "app/vX.Y.Z" (в URL — "app%2FvX.Y.Z").
# Версия закреплена (ARG) — при необходимости бампнуть тегом из релизов
# https://github.com/apernet/hysteria/releases.
FROM base AS hysteria-build
ARG HYSTERIA_VERSION=v2.6.0
WORKDIR /hysteria
RUN apk add --no-cache curl && \
    curl -fsSL -o /hysteria/hysteria \
      "https://github.com/apernet/hysteria/releases/download/app%2F${HYSTERIA_VERSION}/hysteria-linux-amd64" && \
    chmod +x /hysteria/hysteria

# ============================================
# Stage 6: Production image
# ============================================
FROM base AS deploy
WORKDIR /app

# Установка runtime-зависимостей (--no-cache уменьшает размер образа)
# nginx — терминирует TLS на 443 и разводит трафик между Xray (WS) и
# NestJS (/sub), см. docker/nginx.conf и docker-entrypoint.sh.
RUN apk add --no-cache \
    nginx \
    # Для healthcheck
    wget \
    # Для генерации самоподписанного сертификата Hysteria2 (HysteriaService)
    openssl \
    # Для отладки (опционально, можно убрать)
    curl

# Бинарник Xray-core + geo-данные (VLESS + WS + TLS через Cloudflare CDN)
COPY --from=xray-build /xray/out/xray /usr/bin/xray
COPY --from=xray-build /xray/out/geoip.dat /usr/share/xray/geoip.dat
COPY --from=xray-build /xray/out/geosite.dat /usr/share/xray/geosite.dat
ENV XRAY_LOCATION_ASSET=/usr/share/xray

# Бинарник Hysteria2 (резервный протокол, QUIC/UDP)
COPY --from=hysteria-build /hysteria/hysteria /usr/bin/hysteria

# Копируем только необходимое для запуска
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle

# nginx: терминирует TLS на 443, разводит /sub и остальные NestJS-пути на
# localhost:3000, всё остальное (VLESS+WS) — на Xray localhost:8880.
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Создаём директории для данных
RUN mkdir -p configs data

# Метаданные
LABEL maintainer="vpn-bot"
LABEL version="1.0"

# Порты
EXPOSE 443/tcp
EXPOSE 443/udp
EXPOSE 8443/udp
EXPOSE 3000

# Health check внутри контейнера
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Запуск: nginx (443, TLS) + NestJS (см. docker-entrypoint.sh)
CMD ["/docker-entrypoint.sh"]
