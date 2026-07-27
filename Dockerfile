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
# Stage 4: AmneziaWG (обфусцированный WireGuard)
# ============================================
# amneziawg-go — userspace-реализация: работает через /dev/net/tun и не требует
# модуля ядра на хосте. amneziawg-tools даёт awg/awg-quick (аналоги wg/wg-quick).
FROM golang:1.25-alpine AS awg-build

# Ревизии можно закрепить при сборке: --build-arg AWG_GO_REF=v0.2.13
ARG AWG_GO_REF=master
ARG AWG_TOOLS_REF=master

RUN apk add --no-cache git build-base bash linux-headers

RUN git clone --depth=1 --branch "$AWG_GO_REF" \
      https://github.com/amnezia-vpn/amneziawg-go /src/amneziawg-go \
    && cd /src/amneziawg-go \
    && go build -trimpath -ldflags="-s -w" -o /out/usr/bin/amneziawg-go

RUN git clone --depth=1 --branch "$AWG_TOOLS_REF" \
      https://github.com/amnezia-vpn/amneziawg-tools /src/amneziawg-tools \
    && cd /src/amneziawg-tools/src \
    && make \
    # WITH_WGQUICK=yes обязателен: без него ставится только awg, без awg-quick
    && make DESTDIR=/out WITH_WGQUICK=yes WITH_BASHCOMPLETION=no \
            WITH_SYSTEMDUNITS=no install

# ============================================
# Stage 5: Production image
# ============================================
FROM base AS deploy
WORKDIR /app

# Установка runtime-зависимостей
# --no-cache уменьшает размер образа
RUN apk add --no-cache \
    wireguard-tools \
    iptables \
    iproute2 \
    openresolv \
    sudo \
    # awg-quick — bash-скрипт
    bash \
    # Для healthcheck
    wget \
    # Для отладки (опционально, можно убрать)
    curl

# awg, awg-quick и amneziawg-go. Без них приложение работает,
# но интерфейс awg0 не поднимается и бот не предлагает AmneziaWG.
COPY --from=awg-build /out/ /

# Копируем только необходимое для запуска
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle

# Создаём директории для данных
RUN mkdir -p configs data

# Метаданные
LABEL maintainer="vpn-bot"
LABEL version="1.0"

# Порты
EXPOSE 51820/udp
EXPOSE 51821/udp
EXPOSE 3000

# Health check внутри контейнера
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Запуск приложения
CMD ["node", "dist/src/main.js"]
