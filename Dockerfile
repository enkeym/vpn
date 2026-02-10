# ============================================
# Stage 1: Base image with pnpm
# ============================================
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ============================================
# Stage 2: Install dependencies
# ============================================
FROM base AS dependencies
WORKDIR /app

# Установка build-зависимостей для нативных модулей (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Копируем только файлы зависимостей для лучшего кеширования
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ============================================
# Stage 3: Build application
# ============================================
FROM base AS build
WORKDIR /app

# Копируем зависимости из предыдущего stage
COPY package.json pnpm-lock.yaml ./
COPY --from=dependencies /app/node_modules ./node_modules

# Копируем исходный код
COPY tsconfig*.json nest-cli.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

# Сборка (миграции должны быть уже сгенерированы локально)
RUN pnpm run build

# Удаляем dev-зависимости для production
RUN CI=true pnpm prune --prod

# ============================================
# Stage 4: Production image
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
    # Для healthcheck
    wget \
    # Для отладки (опционально, можно убрать)
    curl

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
EXPOSE 3000

# Health check внутри контейнера
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Запуск приложения
CMD ["node", "dist/src/main.js"]
