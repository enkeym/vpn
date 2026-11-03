---
paths:
  - "src/xray/**"
  - "docker/**"
  - "src/network/**"
  - "src/main.ts"
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
- WS-путь из xray-ws.json (том configs, не в git) nginx не знает: `location /` в
  `docker/nginx.conf` отдаёт всё, кроме `/sub/` и `/`, на WS-порт. Новый
  публичный путь NestJS — добавить `location` перед этим фолбэком.
- Self-steal: SNI-домен (`XRAY_REALITY_SNI`) — DNS only (серое облако), A на IP
  сервера; за Cloudflare он отдаст чужой сертификат, и смысл self-steal пропадёт.
  Сертификат `configs/steal-cert.pem`/`steal-key.pem` (Let's Encrypt, DNS-01 —
  порта 80 нет) после продления подхватывается `nginx -s reload` внутри
  контейнера, рестарт не нужен. На этот порт ходит только Reality с `xver: 0`,
  поэтому `listen` без `proxy_protocol`.
- DNS-роли в `src/network/dns-sync.service.ts:upsert`: `XRAY_DOMAIN` требует
  Proxied; `WG_HOST`, `XRAY_HOST`, `XRAY_REALITY_SNI`, `XRAY_REALITY_EXTRA_SNI`
  требуют DNS only. Конфликт ролей отклоняется до обращения к API. Для остальных
  существующих записей сохраняется режим, для новых действует `CF_DNS_PROXIED`.
- `docker/cloudflare-ipv4.conf` — публикуемые IPv4-сети Cloudflare для `geo` в
  `docker/nginx.conf`; `Dockerfile` копирует список в образ. CDN-SNI попадает в
  TLS-ветку только с адресов списка, остальные соединения идут в Reality.
- `HTTP_HOST` в `src/main.ts:bootstrap` по умолчанию loopback; upstream приложения
  в `docker/nginx.conf` и healthcheck в `docker-compose.yml` используют loopback.
  Другой bind-адрес требует сохранить доступ с хоста и закрыть публичный порт приложения.
- Смена `XRAY_REALITY_SNI` — старый SNI перенести в `XRAY_REALITY_EXTRA_SNI`
  (`src/xray/xray.service.ts:realityExtraSni` → `serverNames`): подписка
  обновится сама, а выданные `vless://` несут старый SNI.
