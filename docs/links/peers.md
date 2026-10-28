---
paths:
  - "src/peers/**"
  - "src/subscription/**"
---

## Расписание
- Cron `src/peers/peers-scheduler.service.ts`: `handleExpiredPeers` (ежечасно),
  `handlePeerTrafficStats` (00:00), `handleInactiveActivePeers` (01:00),
  `handlePeersRetentionCleanup` (02:00), `handleExpiringSoonNotifications`
  (03:00). Порядок значим: статистика трафика в 00:00 должна успеть до проверки
  неактивных в 01:00, иначе живые клиенты получат «давно не используется».
- `handleReachability` (ежечасно) — тонкая обёртка над
  `src/network/reachability.service.ts:check`: TCP-проверка `PUBLIC_IPV4:XRAY_REALITY_PORT`
  из Москвы через check-host.net, админу пишет только при смене состояния.
  Порт берётся из того же `XRAY_REALITY_PORT`, что слушает nginx; с другим
  портом проверка покажет «бан» на здоровом сервере.

## Контракты
- URL подписки — `src/peers/peers.service.ts:buildSubscriptionUrl` собирает
  `${origin}/sub/${vlessUuid}`, принимает `src/subscription/subscription.controller.ts:getSubscription`,
  публикует наружу `location /sub/` в `docker/nginx.conf`. Ссылки уже у клиентов:
  путь и формат (выбор по User-Agent) менять нельзя.
- Трафик VLESS ищется по `peer.name` — см. `xray.md`, «Имя клиента Xray».
