# Карта скрытых связей — индекс

Связи, которые компилятор и тесты не ловят: «тронул X → обнови Y, потому что Z».
Файл домена подключает хук по его `paths:`, когда правка попала в эти пути;
перед коммитом (impact-проход) открывай его по индексу. Формат строки:
`- <домен> — <файл>.md — <одна фраза>`, проверка ссылок и глобов:
`node ~/.ai-hooks/bin/check-impact-map.mjs`.

- xray — `xray.md` — Xray ↔ nginx-разводчик в образе
- awg — `awg.md` — MTU, TCPMSS и применение PostUp/PostDown
- peers — `peers.md` — cron пиров и URL подписки
- payment — `payment.md` — вебхук ЮKassa, allow-list, тестовый режим
- bot — `bot.md` — callback-роуты и токен бота
- deploy — `deploy.md` — CI-деплой по ssh ↔ таргеты Makefile и ветка `dev`
