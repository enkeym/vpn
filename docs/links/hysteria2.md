---
paths:
  - "src/hysteria/**"
  - "docker/**"
  - "src/peers/**"
  - "src/subscription/**"
---

## Флаги и переключатели
- `HY2_ENABLED` (`true`) выключает канал целиком. При `false` процесс не
  запускается, бот отдаёт только Reality-каналы.
- `HY2_PORT` (443, **UDP**) — публичный порт QUIC. TCP на нём занят nginx
  (`SUB_TLS_PORT`), протоколы не конфликтуют.
- `HY2_SNI` — домен в TLS-сертификате; по умолчанию `XRAY_REALITY_SNI`, то
  есть self-steal домен. Сертификат публично доверенный, поэтому клиент не
  ставит `insecure`.
- `HY2_STATS_PORT` (9999) — API статистики на `127.0.0.1`, наружу не открыт.
  Ответ `GET /traffic` с заголовком `Authorization: <secret>`:
  `{"<peer>":{"tx":N,"rx":N}}`, где `tx` — uplink, `rx` — downlink.
  Счётчики кумулятивные с момента старта процесса: `clear=true` не передаётся,
  иначе API вернёт дельту, а в БД пишется абсолютный итог.
- `HY2_OBFS` (`true`) включает salamander: у QUIC-пакетов нет узнаваемого
  заголовка. Пароль obfs общий и уезжает в ссылку.
- `HY2_CERT` / `HY2_KEY` — по умолчанию `configs/steal-cert.pem` и
  `configs/steal-key.pem`. Нет файлов — канал не стартует, остальные работают.

## Контракт с пирами
- Логин — `peers.name`, пароль — `HMAC-SHA256(секрет, name)`, обрезанный до
  32 hex-символов. Отдельной колонки в БД нет: пароль восстанавливается при
  каждом старте, поэтому пересоздание образа его не меняет.
- Секреты (`passwordSecret`, `obfsPassword`, `statsSecret`) лежат в
  `configs/hysteria-auth.json`, создаются при первом запуске с правами 0600.
  Файл не в Git: это runtime-секрет.
- `PeersService.syncXrayWithDb` передаёт в `syncClients` всех активных пиров;
  изменение набора перезапускает демон (Hysteria2 не перечитывает конфиг).
- `PeersService.refreshPeerTrafficStats` складывает трафик Hysteria2 с
  туннельным и VLESS: у пира, живущего только на QUIC, счётчики не стоят.

## Подписка
`src/hysteria/hysteria.service.ts:buildShareLink` собирает
`hysteria2://<password>@<host>:<port>/?sni=..&obfs=salamander&obfs-password=..#<name>`.
Ссылка попадает в base64-подписку и в sing-box outbound `type: hysteria2`
(входит в `urltest` auto). В `?format=xray` канала нет — Xray не умеет
hysteria2.

## Проверки
- `pnpm test -- hysteria subscription peers`.
- На сервере: `ufw allow <HY2_PORT>/udp`, затем `hysteria client` с конфигом из
  ссылки и запрос через локальный SOCKS; трафик пира должен вырасти в БД.
