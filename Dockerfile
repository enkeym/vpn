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
RUN NODE_OPTIONS=--max-old-space-size=768 pnpm run build

# Удаляем dev-зависимости для production
RUN CI=true pnpm prune --prod

# ============================================
# Stage 4: AmneziaWG (обфусцированный WireGuard)
# ============================================
# amneziawg-go — userspace-реализация: работает через /dev/net/tun и не требует
# модуля ядра на хосте. amneziawg-tools даёт awg/awg-quick (аналоги wg/wg-quick).
FROM golang:1.25-alpine AS awg-build

# Ревизии закреплены намеренно: ветки Amnezia переписываются force-push'ем, а
# версия протокола на сервере обязана совпадать с той, что раздана клиентам.
# AWG_GO_REF — коммит «feat: amneziawg 3.0» (24.07.2026).
# AWG_TOOLS_REF — ветка feat/awg3: только она разбирает HeaderProtectionKey,
# ContentPaddingAddition, S3/S4 и тайминги — в master этих ключей ещё нет.
ARG AWG_GO_REF=b5928efb6ca19f0153958460c3d141f04abc5c2e
ARG AWG_TOOLS_REF=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843

RUN apk add --no-cache git build-base bash linux-headers

# fetch по SHA вместо clone --branch: --branch принимает только имена веток и тегов
RUN git init /src/amneziawg-go \
    && cd /src/amneziawg-go \
    && git remote add origin https://github.com/amnezia-vpn/amneziawg-go \
    && git fetch --depth=1 origin "$AWG_GO_REF" \
    && git checkout FETCH_HEAD \
    && GOMAXPROCS=1 GOMEMLIMIT=512MiB go build -p 1 -trimpath -ldflags="-s -w" -o /out/usr/bin/amneziawg-go

RUN git init /src/amneziawg-tools \
    && cd /src/amneziawg-tools \
    && git remote add origin https://github.com/amnezia-vpn/amneziawg-tools \
    && git fetch --depth=1 origin "$AWG_TOOLS_REF" \
    && git checkout FETCH_HEAD \
    && cd src \
    && make \
    # WITH_WGQUICK=yes обязателен: без него ставится только awg, без awg-quick
    && make DESTDIR=/out WITH_WGQUICK=yes WITH_BASHCOMPLETION=no \
            WITH_SYSTEMDUNITS=no install

# ============================================
# Stage 5: Xray-core (VLESS: Reality + WS за CDN)
# ============================================
# Второй канал доступа рядом с AmneziaWG: протоколы блокируются по-разному, и
# клиент подключается тем, что живо на его сети. Xray-core — чистый Go,
# статически слинкован, работает на Alpine без glibc. Версия закреплена (ARG),
# бампать тегом из https://github.com/XTLS/Xray-core/releases.
FROM base AS xray-build
ARG XRAY_VERSION=v26.3.27
WORKDIR /xray
RUN apk add --no-cache curl unzip && \
    curl -fsSL -o xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip xray.zip -d /xray/out && \
    chmod +x /xray/out/xray

# ============================================
# Stage 6: Production image
# ============================================
FROM base AS deploy
WORKDIR /app

# Установка runtime-зависимостей
# --no-cache уменьшает размер образа
RUN apk add --no-cache \
    iptables \
    # В Alpine ip6tables — отдельный пакет: без него правила PostUp для IPv6
    # не применяются, и NAT66 в туннеле не работает
    ip6tables \
    iproute2 \
    openresolv \
    sudo \
    # awg-quick — bash-скрипт
    bash \
    nginx \
    # stream в Alpine отдельным пакетом: без него нет listener'а, отдающего 443 в Reality.
    nginx-mod-stream \
    # Для healthcheck
    wget \
    # Для отладки (опционально, можно убрать)
    curl

# awg, awg-quick и amneziawg-go. Без них приложение стартует, но интерфейс awg0
# не поднимается и бот не может выдавать конфиги. Отдельный wireguard-tools в
# образе не нужен: ключи считает тот же awg (genkey/pubkey/genpsk).
COPY --from=awg-build /out/ /

# Проверка на этапе сборки: без awg-quick интерфейс не поднимется, и без неё мы
# узнали бы об этом только на старте контейнера в проде.
RUN awg --version && command -v awg-quick >/dev/null

# Бинарник Xray-core + geo-данные (второй канал: VLESS Reality/WS).
# Без него приложение стартует и AmneziaWG работает как раньше — XrayService
# просто не поднимется и напишет об этом в лог (см. isBinaryAvailable).
COPY --from=xray-build /xray/out/xray /usr/bin/xray
COPY --from=xray-build /xray/out/geoip.dat /usr/share/xray/geoip.dat
COPY --from=xray-build /xray/out/geosite.dat /usr/share/xray/geosite.dat
ENV XRAY_LOCATION_ASSET=/usr/share/xray
RUN xray version >/dev/null

# Копируем только необходимое для запуска
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
# Целостная копия SQLite для make backup (запускается через docker compose exec)
COPY scripts/db-backup.cjs ./scripts/db-backup.cjs

# nginx: шаблон конфига (домен и порты подставляет entrypoint из .env) и сам
# entrypoint, который поднимает nginx перед стартом NestJS.
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Создаём директории для данных
RUN mkdir -p configs data

# Метаданные
LABEL maintainer="vpn-bot"
LABEL version="1.0"

# Порты. EXPOSE в network_mode: host носит справочный характер — контейнер и
# так слушает порты хоста, открывать их нужно в фаерволе VPS (см. README).
EXPOSE 51821/udp
EXPOSE 443/tcp
EXPOSE 3000

# Health check внутри контейнера
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["/docker-entrypoint.sh"]
