---
paths:
  - "src/payment/**"
  - "src/settings/**"
---

## Внешние входы и расписание
- Вебхук ЮKassa `POST /payment/webhook` → `src/payment/payment.controller.ts:handleWebhook`
  → `src/payment/payment-fulfillment.service.ts:fulfillFromWebhookVerifiedPayment`.
  Вызывающего в коде нет, формат тела задаёт ЮKassa
  (`src/payment/payment.controller.ts:parseYooKassaWebhookBody`).
- Cron ежечасно — `src/payment/autopay.service.ts:processDueCharges`.

## Флаги и переключатели
- `TRUST_PROXY_HOPS` — `trust proxy` в `src/main.ts:bootstrap` определяет `req.ip`,
  по которому `src/payment/payment.controller.ts:isIpAllowed` сверяет allow-list
  ЮKassa. Лишний хоп — адрес подделывается через `X-Forwarded-For`.
- `NODE_ENV` — `!== 'production'` пускает localhost мимо allow-list в
  `src/payment/payment.controller.ts:isIpAllowed` и открывает
  `src/payment/payment.controller.ts:completeSucceededForTest` (вместе с тестовым
  режимом `src/settings/settings.service.ts:isTestPayment`). Ни `Dockerfile`, ни
  `docker-compose.yml`, ни `.env.example` `NODE_ENV` не задают — защиту держит
  только флаг тестового режима.
