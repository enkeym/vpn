---
paths:
  - "src/xray/**"
  - "docker/**"
  - "src/network/**"
  - "src/main.ts"
---

## Флаги и переключатели
- `XRAY_REALITY_PORT` в `src/xray/xray.service.ts:realityPort` задаёт порт
  Reality в клиентских ссылках. При self-steal `docker/docker-entrypoint.sh`
  подставляет его в публичный listener `docker/nginx.conf`.
- `XRAY_INTERNAL_REALITY_PORT` задаёт локальный порт Reality за nginx при
  self-steal; без `XRAY_INTERNAL_STEAL_PORT` Xray слушает публичный порт сам.
- `XRAY_INTERNAL_STEAL_PORT` включает nginx и обязан совпадать с портом в
  `XRAY_REALITY_DEST`. Для него нужны `configs/steal-cert.pem` и
  `configs/steal-key.pem`; при отсутствии сертификата entrypoint останавливает
  контейнер до старта Xray.

## Контракты
- PROXY protocol — `proxy_protocol on` в `docker/nginx.conf` ↔
  `acceptProxyProtocol` в `src/xray/xray.service.ts:buildServerConfig`. Включать
  и выключать только вместе, иначе Reality не проходит хендшейк.
- Имя клиента Xray = `peers.name`: `email: client.name` в
  `src/xray/xray.service.ts:buildServerConfig`, разбор `user>>>…>>>traffic` в
  `src/xray/xray.service.ts:getTrafficStats`, ключ `xrayStats.get(peer.name)` в
  `src/peers/peers.service.ts:refreshPeerTrafficStats`. Сменишь email — трафик VLESS
  обнулится, и живые клиенты уйдут в «неактивные».
- Self-steal: SNI-домен (`XRAY_REALITY_SNI`) — DNS only, A на IP сервера;
  за прокси он отдаст чужой сертификат, и смысл self-steal пропадёт.
  Сертификат `configs/steal-cert.pem`/`steal-key.pem` (Let's Encrypt, DNS-01 —
  порта 80 нет) после продления подхватывается `nginx -s reload` внутри
  контейнера, рестарт не нужен. На этот порт ходит только Reality с `xver: 0`,
  поэтому `listen` без `proxy_protocol`.
- DNS-роли в `src/network/dns-sync.service.ts:upsert`: A-записи из
  `CF_DNS_RECORDS` обновляются на `PUBLIC_IPV4`; `WG_HOST` и `XRAY_REALITY_SNI`
  требуют DNS only. Для остальных существующих записей сохраняется режим,
  новые создаются как DNS only.
- `HTTP_HOST` в `src/main.ts:bootstrap` по умолчанию loopback; upstream приложения
  в `docker/nginx.conf` и healthcheck в `docker-compose.yml` используют loopback.
  Другой bind-адрес требует сохранить доступ с хоста и закрыть публичный порт приложения.
