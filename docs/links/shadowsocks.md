---
paths:
  - "src/shadowsocks/**"
  - "Dockerfile"
  - "src/peers/**"
  - "src/subscription/**"
---

## Флаги и переключатели
- `SS_ENABLED` (`true`) выключает канал целиком. При `false` процесс не
  запускается, бот и подписка отдают остальные каналы.
- `SS_PORT` (2096, **TCP+UDP**) — публичный порт ssserver. Открыть оба
  протокола в фаерволе (`bootstrap-host.sh` делает это сам).
- `SS_METHOD` (`2022-blake3-aes-256-gcm`) — AEAD-2022 из SIP022. Менять не
  нужно: размер ключа фиксирован 32 байта, и деривация ключей ниже рассчитана
  на него.
- `SS_SHARE_LINKS` (`true`) — при `false` сервер работает, но канал прячется
  из подписки, sing-box-конфига и сообщений бота (`SS_ENABLED` не трогаем).

## Контракт с пирами
- Multi-user SIP022 без manager API: один процесс `ssserver` с `users[]`
  (Extensible Identity Header). Клиентский пароль = user key; sing-box
  дополнительно требует server key через `password: <server>:<user>`.
- Ключи деривируются из master-секрета: server key =
  `base64(HMAC-SHA256(master, "shadowsocks-server-key"))`, ключ пира =
  `base64(HMAC-SHA256(master, peerName))` — ровно 32 байта в base64. Отдельной
  колонки в БД нет: ключ восстанавливается при каждом старте.
- Master-секрет лежит в `configs/ss-auth.json`, создаётся при первом запуске
  с правами 0600. Файл не в Git: это runtime-секрет.
- `PeersService.syncXrayWithDb` передаёт в `syncClients` всех активных пиров;
  изменение набора перезапускает демон (ssserver не перечитывает конфиг).
- Конфиг: `configs/shadowsocks.json`, `servers: [{server: "::", mode:
  "tcp_and_udp", method, password: serverKey, users: [{name, password}]}]`.
  Без активных пиров процесс останавливается, конфиг удаляется.

## Подписка
- `src/shadowsocks/shadowsocks.service.ts:buildShareLink` собирает SIP002:
  `ss://<base64url(method:userKey)>@<host>:<port>#<name>`. Ссылка попадает в
  base64-подписку и текст пира в боте.
- sing-box outbound `type: shadowsocks`, `password: <serverKey>:<userKey>`
  (EIH), входит в общий selector вместе с Reality и Hysteria2. В `?format=xray`
  канала нет — Xray не умеет Shadowsocks-2022.

## Проверки
- `pnpm test -- shadowsocks subscription peers`.
- На сервере: `ufw allow 2096/tcp && ufw allow 2096/udp`, затем клиент с
  импортом `ss://`-ссылки; канал должен появиться в sing-box-конфиге
  подписки.
