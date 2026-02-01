  FROM node:22-alpine AS base
   ENV PNPM_HOME="/pnpm"
   ENV PATH="$PNPM_HOME:$PATH"
   RUN corepack enable

   FROM base AS dependencies
   WORKDIR /app
   RUN apk add --no-cache python3 make g++
   COPY package.json pnpm-lock.yaml ./
   RUN pnpm install --frozen-lockfile

   FROM base AS build
   WORKDIR /app
   COPY package.json pnpm-lock.yaml ./
   COPY --from=dependencies /app/node_modules ./node_modules
   COPY . .
   RUN pnpm run build
   RUN pnpm run generate
   RUN CI=true pnpm prune --prod

   FROM base AS deploy
   WORKDIR /app
   RUN apk add --no-cache wireguard-tools iptables iproute2 openresolv sudo
   COPY --from=build /app/dist ./dist
   COPY --from=build /app/node_modules ./node_modules
   COPY --from=build /app/package.json ./package.json
   COPY --from=build /app/drizzle ./drizzle
   RUN mkdir -p configs
   EXPOSE 51820/udp
   CMD ["node", "dist/src/main.js"]