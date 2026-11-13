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
- `XRAY_GRPC_PORT` (27443), `XRAY_GRPC_SERVICE` (`grpc-vk`) — канал
  `reality-grpc`. Имя сервиса уезжает и в инбаунд (`grpcSettings.serviceName`),
  и в ссылку (`serviceName`), и в sing-box-подписку: разойдутся — клиент не
  подключится.
- `XRAY_XHTTP_PORT` (27444), `XRAY_XHTTP_PATH` (`/xhttp`), `XRAY_XHTTP_MODE`
  (`auto`) — канал `reality-xhttp`. Путь стоит заменить на случайный; режимы
  `auto | packet-up | stream-up | stream-one` должны совпадать в ссылке и
  инбаунде.
- `SUB_PUBLIC_URL` — публичный HTTPS-адрес приложения, из него
  `src/subscription/subscription.service.ts:buildSubscriptionUrl` собирает
  `/sub/<uuid>` для кнопки «Одна ссылка — все протоколы». Пусто — ссылки нет,
  бот предлагает прямые `vless://`.
- `XRAY_CDN_XHTTP_HOST/PORT/PATH` — `src/xray/xray.service.ts:buildServerConfig`
  ↔ ingress cloudflared: host/path должны вести на loopback-порт из окружения.
  Порядок включения и совместимость подписки: `docs/cdn-xhttp.md`.

## Каналы

| Инбаунд | Транспорт | Порт | `flow` | Примечание |
|---|---|---|---|---|
| `reality-direct` | tcp + reality | `XRAY_REALITY_PORT`, при self-steal `XRAY_INTERNAL_REALITY_PORT` | `xtls-rprx-vision` | Единственный за nginx: `acceptProxyProtocol` только здесь |
| `reality-grpc` | grpc + reality | `XRAY_GRPC_PORT` | нет | `multiMode: true`; XTLS Vision ломает gRPC |
| `reality-xhttp` | xhttp + reality | `XRAY_XHTTP_PORT` | нет | `path`/`mode` обязаны совпадать с клиентом |

Все три используют один `realitySettings` (dest, SNI, privateKey, shortIds) и
один набор клиентов: UUID пира и `email` одинаковые. gRPC и XHTTP слушают
напрямую (`::` или `0.0.0.0`), nginx на них не стоит — self-steal на 443 к ним
не относится.

## Контракты
- `src/xray/xray.service.ts:activeInboundTags` должен включать все VLESS-входы:
  пропущенный тег не получит `rmu` и сохранит доступ удалённого пира до рестарта.
- `flow` задаётся по инбаунду, а не по клиенту: TCP получает `xtls-rprx-vision`,
  gRPC и XHTTP — объект клиента без `flow`. Одно и то же значение на всех
  инбаундах рвёт подключение к gRPC/XHTTP.
- XHTTP требует совпадения версий ядра Xray на сервере и в клиенте: формат
  `xhttpSettings` и режим передачи менялись между версиями. Для старых клиентов
  остаются gRPC и TCP — версия закреплена в `ARG XRAY_VERSION`.
- gRPC по Reality идёт поверх HTTP/2; ALPN `h2` выставляет сам Reality, отдельной
  настройки в инбаунде нет. Если канал не поднимается, проверять в первую очередь
  версию ядра и `serviceName`, а не ALPN.
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
