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
ARG XRAY_VERSION=v26.3.27
WORKDIR /xray
RUN apk add --no-cache curl unzip && \
    curl -fsSL -o xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip xray.zip -d /xray/out && \
    chmod +x /xray/out/xray

# ============================================
# Stage 5: Production image
# ============================================
FROM base AS deploy
WORKDIR /app

# Установка runtime-зависимостей (--no-cache уменьшает размер образа)
# nginx — терминирует TLS на 443 и разводит трафик между Xray (WS) и
# NestJS (/sub), см. docker/nginx.conf и docker-entrypoint.sh.
RUN apk add --no-cache \
    nginx \
    # stream + ssl_preread: разводит внешний 443 по SNI между Reality и
    # CDN-каналом (см. docker/nginx.conf). В Alpine модуль отдельным пакетом.
    nginx-mod-stream \
    # Для healthcheck
    wget \
    # Для отладки (опционально, можно убрать)
    curl

# Бинарник Xray-core + geo-данные (VLESS + WS + TLS через Cloudflare CDN)
COPY --from=xray-build /xray/out/xray /usr/bin/xray
COPY --from=xray-build /xray/out/geoip.dat /usr/share/xray/geoip.dat
COPY --from=xray-build /xray/out/geosite.dat /usr/share/xray/geosite.dat
ENV XRAY_LOCATION_ASSET=/usr/share/xray

# Копируем только необходимое для запуска
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle

# nginx: stream на 443 разводит по SNI (Reality / CDN), http на localhost:8444
# терминирует TLS и раскидывает /sub и остальные NestJS-пути на localhost:3000,
# всё остальное (VLESS+WS) — на Xray localhost:8880. Домен в шаблоне
# подставляет entrypoint из XRAY_DOMAIN.
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Создаём директории для данных
RUN mkdir -p configs data

# Метаданные
LABEL maintainer="vpn-new-bot"
LABEL version="1.0"

# Наружу торчит только 443/tcp: nginx разводит по SNI Reality и CDN-канал.
EXPOSE 443/tcp
EXPOSE 3000

# Health check внутри контейнера
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Запуск: nginx (443, TLS) + NestJS (см. docker-entrypoint.sh)
CMD ["/docker-entrypoint.sh"]
