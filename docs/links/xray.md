---
paths:
  - "src/xray/**"
  - "docker/**"
---

## Флаги и переключатели
- `XRAY_DOMAIN` — включает nginx в `docker/docker-entrypoint.sh` и одновременно
  переводит Reality за прокси в `src/xray/xray.service.ts:behindProxy`. Условия
  должны совпадать: иначе либо nginx и Xray дерутся за публичный порт, либо
  публичный порт никто не слушает.
- `XRAY_INTERNAL_REALITY_PORT` / `XRAY_INTERNAL_WS_PORT` — дефолты 8444/8880 в
  `src/xray/xray.service.ts:internalRealityPort`, `src/xray/xray.service.ts:internalWsPort`
  продублированы в `docker/docker-entrypoint.sh` (подстановка в
  `docker/nginx.conf`). Сменил дефолт с одной стороны — nginx шлёт трафик в пустой порт.
- `XRAY_PORT` (порт в ссылках, `src/xray/xray.service.ts:port`) обязан равняться
  `XRAY_REALITY_PORT` — это слушает nginx; сверку делает только
  `docker/docker-entrypoint.sh`, и то предупреждением.

## Контракты
- PROXY protocol — `proxy_protocol on` в `docker/nginx.conf` ↔
  `acceptProxyProtocol` в `src/xray/xray.service.ts:buildServerConfig`. Включать
  и выключать только вместе, иначе Reality не проходит хендшейк.
- Имя клиента Xray = `peers.name`: `email: client.name` в
  `src/xray/xray.service.ts:buildServerConfig`, разбор `user>>>…>>>traffic` в
  `src/xray/xray.service.ts:getTrafficStats`, ключ `xrayStats.get(peer.name)` в
  `src/peers/peers.service.ts:refreshPeerTrafficStats`. Сменишь email — трафик VLESS
  обнулится, и живые клиенты уйдут в «неактивные».
- WS-путь из xray-ws.json (том configs, не в git) nginx не знает: `location /` в
  `docker/nginx.conf` отдаёт всё, кроме `/sub/` и `/`, на WS-порт. Новый
  публичный путь NestJS — добавить `location` перед этим фолбэком.
