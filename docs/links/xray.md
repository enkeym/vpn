---
paths:
  - "src/xray/**"
  - "docker/**"
  - "src/network/**"
  - "src/main.ts"
---

## Флаги и переключатели
- `XRAY_DOMAIN` — адрес zrok-шары (`*.shares.zrok.io`). Включает nginx в
  `docker/docker-entrypoint.sh`: публичный 443 он отдаёт в Reality, а на
  `127.0.0.1:8080` держит HTTP-роутер для туннеля. Одновременно переводит
  Reality за прокси в `src/xray/xray.service.ts:behindProxy`. Условия должны
  совпадать: иначе либо nginx и Xray дерутся за публичный порт, либо публичный
  порт никто не слушает.
- `XRAY_INTERNAL_REALITY_PORT` / `XRAY_INTERNAL_WS_PORT` / `NGINX_INTERNAL_TUNNEL_PORT` —
  дефолты 8444/8880/8080 в `src/xray/xray.service.ts:internalRealityPort`,
  `internalWsPort` продублированы в `docker/docker-entrypoint.sh` (подстановка в
  `docker/nginx.conf`). Сменил дефолт с одной стороны — nginx шлёт трафик в пустой порт.
- `XRAY_REALITY_PORT` в `src/xray/xray.service.ts:realityPort` задаёт порт обоих
  каналов в ссылках; `docker/docker-entrypoint.sh` подставляет его в публичный
  listener `docker/nginx.conf`. Порты должны совпадать.
- `XRAY_INTERNAL_STEAL_PORT` — включает self-steal сервер в `docker/nginx.conf`
  (блок `__STEAL_BEGIN__`…`__STEAL_END__` вырезается `docker/docker-entrypoint.sh`,
  если порт пуст) и обязан совпадать с портом в `XRAY_REALITY_DEST`
  (`src/xray/xray.service.ts:realityDest`): иначе Reality ходит в пустой порт и
  не проходит ни один хендшейк. Сверка — только предупреждение в entrypoint.
  Без `XRAY_DOMAIN` nginx нет, entrypoint падает.

## Контракты
- PROXY protocol — `proxy_protocol on` в `docker/nginx.conf` ↔
  `acceptProxyProtocol` в `src/xray/xray.service.ts:buildServerConfig`. Включать
  и выключать только вместе, иначе Reality не проходит хендшейк.
- Имя клиента Xray = `peers.name`: `email: client.name` в
  `src/xray/xray.service.ts:buildServerConfig`, разбор `user>>>…>>>traffic` в
  `src/xray/xray.service.ts:getTrafficStats`, ключ `xrayStats.get(peer.name)` в
  `src/peers/peers.service.ts:refreshPeerTrafficStats`. Сменишь email — трафик VLESS
  обнулится, и живые клиенты уйдут в «неактивные».
- Туннель: край zrok терминирует TLS и проксирует HTTP на
  `127.0.0.1:NGINX_INTERNAL_TUNNEL_PORT`. В `docker/nginx.conf` это отдельный
  server: `/sub/` и `/` уходят в NestJS, всё остальное — в WS-порт Xray.
  Снаружи порт не публикуется, в фаерволе его открывать не нужно.
- WS-путь из xray-ws.json (том configs, не в git) nginx не знает: `location /` в
  `docker/nginx.conf` отдаёт всё, кроме `/sub/` и `/`, на WS-порт. Новый
  публичный путь NestJS — добавить `location` перед этим фолбэком.
- Self-steal: SNI-домен (`XRAY_REALITY_SNI`) — DNS only, A на IP сервера;
  за прокси он отдаст чужой сертификат, и смысл self-steal пропадёт.
  Сертификат `configs/steal-cert.pem`/`steal-key.pem` (Let's Encrypt, DNS-01 —
  порта 80 нет) после продления подхватывается `nginx -s reload` внутри
  контейнера, рестарт не нужен. На этот порт ходит только Reality с `xver: 0`,
  поэтому `listen` без `proxy_protocol`.
- DNS-роли в `src/network/dns-sync.service.ts:upsert`: A-записи из
  `CF_DNS_RECORDS` обновляются на `PUBLIC_IPV4`; `WG_HOST` и `XRAY_REALITY_SNI`
  требуют DNS only. `XRAY_DOMAIN` — адрес zrok и в Cloudflare не участвует.
  Для остальных существующих записей сохраняется режим, новые создаются как
  DNS only.
- `HTTP_HOST` в `src/main.ts:bootstrap` по умолчанию loopback; upstream приложения
  в `docker/nginx.conf` и healthcheck в `docker-compose.yml` используют loopback.
  Другой bind-адрес требует сохранить доступ с хоста и закрыть публичный порт приложения.
