# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

Telegram-бот (grammY, long polling) на NestJS 11, который выдаёт и обслуживает
VPN-конфиги. Веб-фронтенда нет; HTTP наружу торчит только подпиской `/sub/:uuid`
и вебхуком ЮKassa. Данные — SQLite (`data/vpn.db`) через Drizzle. Пакетный
менеджер — pnpm 10, Node 22.

## Команды

```bash
pnpm install                 # pnpm обязателен: onlyBuiltDependencies (better-sqlite3)
pnpm dev                     # nest start --watch
pnpm build                   # nest build → dist/
pnpm prod                    # node dist/main

pnpm lint                    # eslint --fix
pnpm exec tsc --noEmit -p tsconfig.json   # типы, как в CI
pnpm test                    # jest, testRegex .*\.spec\.ts$, rootDir=src
pnpm test -- peers.service   # один файл/паттерн
pnpm generate                # drizzle-kit generate — после правки src/database/schema.ts
```

CI (`.github/workflows/ci.yml`, push в `main`/`dev` + PR): eslint → `tsc --noEmit`
→ `pnpm test -- --ci` → `pnpm build`, отдельной джобой `pnpm audit --prod --audit-level=high`.

Docker — только через `Makefile`, потому что имя проекта фиксировано
(`docker compose -p vpn-bot`, без `-p` команды бьют мимо контейнера):

```bash
make up / down / logs / build
make rebuild                 # down → clean → build → up → logs
```

Миграции применяются сами при старте (`DatabaseModule` вызывает `migrate()`),
отдельной команды на сервере не нужно. `pnpm migrate` — для локального прогона.

### Про тесты

`*.spec.ts` в репозитории сейчас нет ни одного, `test/` (и `test/jest-e2e.json`
из скрипта `test:e2e`) тоже нет. `pnpm test` проходит вхолостую — это не
«тесты зелёные». Проверка перед «готово» — `tsc --noEmit` + `lint` + запуск.

## Архитектура

### Один пир — два канала

Одна строка в таблице `peers` выдаётся клиенту двумя независимыми способами, и
они не заменяют, а дублируют друг друга (разные протоколы блокируются по-разному):

| | AmneziaWG 3 | VLESS (Xray) |
|---|---|---|
| Сервис | `AwgService` (`src/wg`) | `XrayService` (`src/xray`) |
| Ключ пира | `publicKey`/`privateKey` | `vlessUuid` |
| Выдача | `.conf` + QR | подписка `/sub/:vlessUuid`, `vless://`, QR |

Классического WireGuard (`wg0`) в проекте нет — только `awg0`. Оба канала
синхронизируются из `PeersService` (`syncWgWithDb`, `syncXrayWithDb`): пауза,
истечение, удаление и замена конфига гасят их одновременно. Любая новая
операция над пиром обязана трогать оба.

### PeersService — центр системы

`src/peers/peers.service.ts` (~1800 строк) держит весь жизненный цикл пира:
выдача IP (кеш занятых адресов), триал, промо-скидка, пауза/возобновление,
retention-удаление, бэкфиллы при старте (`backfillVlessUuid`, `backfillPausedAt`,
`backfillPausedReason`), сбор статистики трафика. Любая правка бизнес-логики
конфигов идёт сюда, а не в обработчики бота.

`PeersSchedulerService` — весь cron: истёкшие (ежечасно), статистика трафика
(00:00), неактивные (01:00), retention-cleanup (02:00), уведомления об
истечении (03:00). Новую периодику добавлять туда же, тонким методом поверх
`PeersService`.

### Бот

`BotService` создаёт `Bot`, вешает error-handler и middleware доступа
(админы из `TELEGRAM_ALLOWED_IDS` + участники «Семьи» из БД, минус
`blocked_users`), затем передаёт бота трём регистраторам:
`UserCommandsRegistrar`, `FamilyCommandsRegistrar`, `AdminCommandsRegistrar`.
Регистраторы объявляют команды и callback-роуты, а логику вызывают у
handler'ов (`src/bot/handlers/*`). Тексты и клавиатуры — в `src/bot/ui/bot.ui.ts`
(90 КБ, единственное место для строк UI). `InvoiceService` и `MainMenuService`
получают `Bot` через `attach()`.

### Оплата

ЮKassa. `PaymentService` создаёт платёж, `PaymentController` принимает вебхук
`POST /payment/webhook` с allow-list IP ЮKassa, `PaymentFulfillmentService`
выдаёт/продлевает конфиг, `AutopayService` ведёт автосписания (`user_autopay`).
IP клиента берётся **только** из `req.ip` — в `main.ts` выставлен
`trust proxy = TRUST_PROXY_HOPS ?? 1`; читать `X-Forwarded-For` руками в
контроллере нельзя, это ровно та дыра, из-за которой allow-list обходился.
`SettingsService` (`app_settings`) держит runtime-флаги приёма оплаты и
тестового режима — переключаются из админки без рестарта.

### Сеть и деплой

Контейнер работает в `network_mode: host`, поэтому sysctl и фаервол хоста
ставит `sudo make bootstrap`. AmneziaWG слушает единственный UDP-порт `AWG_PORT`,
он же указывается в клиентском Endpoint; перенаправлений портов нет. При
`XRAY_INTERNAL_STEAL_PORT` nginx внутри образа слушает публичный 443 и передаёт
его в Reality на localhost; без self-steal Xray слушает публичный порт сам.
PROXY protocol должен быть включён/выключен с обеих сторон одновременно, иначе
не будет хендшейка.

### Состояние в `configs/` (том, не в git)

`awg0.conf`, `xray-reality.json`, `xray-ws.json` — источник истины для
параметров обфускации, ключей Reality и пути WS. Файл главнее `.env`: правка
переменных после создания `awg0.conf` ни на что не влияет. Удаление любого из
этих файлов молча отключает всех, кому уже выданы конфиги/ссылки.

## Инварианты, которые легко сломать

- `AllowedIPs` в клиентском конфиге — ровно строка `0.0.0.0/0, ::/0`: AmneziaVPN
  сравнивает её буквально, иначе ломается раздельное туннелирование.
- `Endpoint` собирается из текущих `WG_HOST`/`AWG_PORT`, а не из поля
  `peers.endpoint` (там адрес на момент создания). Смена порта не требует
  перевыпуска пиров.
- Клиенты Xray добавляются/удаляются через `xray api adu/rmu` без рестарта
  процесса; полный перезапуск — только фолбэк, он рвёт чужие соединения.
- Блок QUIC (UDP 443) в sing-box-подписке трогать нельзя — он лечит зависание
  YouTube и поиска.
- Формат ответа `/sub/:uuid` выбирается по User-Agent (sing-box → JSON,
  остальные → base64). URL и выбор формата ломать нельзя: ссылки уже выданы.
- `deploy.resources.limits.cpus` в compose должен быть ≤ числу ядер хоста,
  иначе docker откажется стартовать контейнер.

## Соглашения кода

- Комментарии в коде — по-русски и только про WHY (почему именно так, какой баг
  обходится); проект этому следует последовательно.
- Интерфейсы с префиксом `I`, типы с `T`, DTO с `class-validator`
  (`ValidationPipe` глобально: `whitelist`, `forbidNonWhitelisted`, `transform`).
- Импорты внутри `src` — и относительные, и от корня (`src/peers/...`);
  `baseUrl: "./"`, path-алиасов нет.
- `noImplicitAny: false` в tsconfig — это не разрешение писать `any`.
- Доступ к БД — `@Inject(DRIZZLE)` из `src/database/database.module.ts`
  (`@Global()`), схема — `src/database/schema.ts`.

## Ветки

`dev` — рабочая (AmneziaWG + Xray), `main` — только Xray. Ветки разошлись
намеренно: фичи переносить точечно, не мержить целиком. Шаги по хосту —
`sudo make bootstrap`; переезд на новый сервер — `make restore` → `sudo make
bootstrap` → `make up`.
