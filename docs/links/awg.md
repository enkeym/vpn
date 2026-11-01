---
paths:
  - "src/wg/**"
---

## Флаги и переключатели
- `AWG_TCP_MSS` — `src/wg/awg.service.ts:firewallRules` сохраняет ограничение TCP
  для обоих направлений `awg0` в PostUp/PostDown; MTU и адреса IPv6 остаются под
  управлением `src/wg/awg.service.ts:buildClientConfig` и не уменьшаются вместе с MSS.

## Применение конфигурации
- `src/wg/awg.service.ts:upgradeExistingConfig` должен вызвать
  `src/wg/tunnel.runtime.ts:bringInterfaceDown` до записи новых PostUp/PostDown:
  awg-quick читает команды удаления с диска. Обратный порядок оставляет прежние
  правила MSS после изменения или очистки `AWG_TCP_MSS`.
  Если интерфейс исчез при пересоздании контейнера, оставшиеся правила удаляет
  `src/wg/awg.service.ts:removeObsoleteMssRules` по прежнему PostDown.
