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
  из Москвы и контрольных узлов вне РФ через check-host.net. Предупреждение
  отправляется после двух последовательных одинаковых отказов: регионального,
  если контрольный узел подключился, или общего, если не подключился ни один
  из четырёх узлов. Это проверка TCP-порта, а не VPN-сессии. Порт берётся из
  того же `XRAY_REALITY_PORT`, что слушает nginx; успешное подключение AWG по
  UDP не проверяет этот TCP-порт.

## Контракты
- VLESS Reality-ссылка собирается в `src/xray/xray.service.ts:buildRealityClientLink`.
  В ней должны совпадать порт, public key, short ID, SNI и XTLS Vision с
  инбаундом Xray. `src/xray/xray.service.ts:buildShareLinks` возвращает
  только Reality TCP; `src/subscription/subscription.service.ts:buildShareLinks`
  добавляет Hysteria2 при включённой выдаче. Base64 собирается из этого массива.
- `GET /sub/<uuid>` в `src/subscription/subscription.controller.ts` отдаёт три
  формата: по умолчанию base64 с прямыми ссылками, `singbox` — клиентам,
  опознанным по User-Agent (`resolveSubscriptionFormat`), `xray` — только явным
  `?format=xray` и в приоритете над UA. Менять список UA-маркеров нельзя без
  проверки выданных ссылок: Happ и прочие получают base64.
- `src/bot/handlers/peer-manage.handler.ts:showAllProtocols` выдаёт URL без
  фиксированного формата; `src/bot/ui/bot.ui.ts:BotUi` направляет официальный
  sing-box на `/sub/<uuid>/full`, остальные приложения — на обычную подписку.
  Полный конфиг с TUN и DNS отдаёт
  `src/subscription/subscription.controller.ts:getFullSubscription`;
  обычный singbox-ответ не заменяет его.
- Трафик VLESS ищется по `peer.name` — см. `xray.md`, «Имя клиента Xray».
