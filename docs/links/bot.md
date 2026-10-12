---
paths:
  - "src/bot/**"
  - "src/notification/**"
---

## Контракты
- `callback_data` — строки кнопок в `src/bot/ui/bot.ui.ts:BotUi` ловят по литералу
  или regex `bot.callbackQuery(...)` в `src/bot/registrars/admin-commands.registrar.ts:register`
  (`admin_*`), `src/bot/registrars/family-commands.registrar.ts:register` (`family_*`,
  `f_*`) и `src/bot/registrars/user-commands.registrar.ts:register`. Переименовал
  или поменял число `:`-частей с одной стороны — кнопка молча перестаёт
  работать. Лимит Telegram — 64 байта, отсюда короткие `f_*`.

## Флаги и переключатели
- `TELEGRAM_BOT_TOKEN` — читают `src/bot/bot.service.ts:onModuleInit` и
  `src/notification/notification.service.ts:onModuleInit` независимо. Смена
  способа получения токена (trim, другой ключ) — в обоих местах.
