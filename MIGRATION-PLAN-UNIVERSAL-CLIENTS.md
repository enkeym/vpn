# План миграции: универсальная подписка, стабильный VLESS, удаление Hysteria2

> Документ-задание для исполнителя (другой модели/разработчика). Все решения уже
> согласованы с владельцем проекта — переспрашивать не нужно, нужно реализовать.
>
> Дата составления: 26 июля 2026. Проект: `/home/enkeym/main/vpn-new` (NestJS + Telegram-бот + Xray-core).

---

## 1. Что болит и почему

Владелец сформулировал три жалобы. Ниже — что реально их вызывает (проверено по коду и внешним источникам).

### Жалоба 1: «VLESS со временем отваливается»

Две независимые причины, обе подтверждены:

**Причина 1.1 — Xray перезапускается процессом при каждом изменении списка пиров.**
В `src/xray/xray.service.ts` метод `applyReload()` делает буквально следующее:

```typescript
this.clients = clients;
await this.writeConfig();
await this.stopProcess();   // SIGTERM → все активные соединения умирают
this.startProcess();
```

`syncXrayWithDb()` вызывается из `createPeer`, `updatedPeer`, `deletePeer`,
`deletePeersByNames`, `deactivateExpiredPeers` (крон!) и `onApplicationBootstrap`.
То есть **любая покупка, продление, пауза или автоматическое истечение чужого
конфига обрывает соединение у всех пользователей разом**. Дебаунс в 1500 мс
и no-op guard по сигнатуре только уменьшают частоту, но не устраняют сам обрыв.

**Причина 1.2 — Cloudflare рвёт idle WebSocket через 100 секунд.**
На планах Free и Pro таймаут WebSocket у Cloudflare жёстко ограничен ~100 секундами
простоя. В `buildServerConfig()` секция `wsSettings` содержит только `path` —
параметр `heartbeatPeriod` не задан, поэтому Xray не шлёт keepalive-фреймы,
и любая пауза в трафике (свернули приложение, поставили видео на паузу) заканчивается
разрывом. В `docker/nginx.conf` стоит `proxy_read_timeout 300s`, но до nginx дело
не доходит — соединение режет CDN раньше.

### Жалоба 2: «Hysteria бесполезна, YouTube через неё не работает»

Решение принято: **Hysteria2 удаляется полностью**. Её роль второго независимого
канала берёт на себя уже существующий VLESS+Reality (прямой TCP на IP сервера,
без CDN). Диагностировать Hysteria смысла нет — код уходит.

### Жалоба 3: «На iPhone нет клиента, на ПК только глючный Hiddify»

Здесь две разные проблемы, и их важно не путать.

**Проблема 3.1 — техническая, полностью в нашей власти.** Эндпоинт `/sub/:uuid`
(`src/subscription/subscription.controller.ts`) отдаёт **только sing-box JSON**.
Такой формат понимают лишь Hiddify, NekoBox, Karing и официальный sing-box.
Все остальные клиенты — v2rayNG, v2rayN, v2RayTun, Streisand, V2Box, Shadowrocket,
Happ — ожидают **base64-строку со ссылками `vless://`**, и с текущей подпиской
просто не работают. Отсюда и «на ПК только Hiddify». Это чинится на сервере
за один вечер и является главным пунктом плана.

**Проблема 3.2 — внешняя, кодом не решается.** По состоянию на июль 2026 в
российском App Store не осталось ни одного подходящего клиента: Streisand, V2Box,
v2RayTun и Happ удалены в марте 2026 по требованию РКН, а последний остававшийся
Happ — Proxy Utility Plus убран 24 июня 2026. Любой iPhone-пользователь обязан
либо сменить регион Apple ID, либо остаться без клиента. Согласованное решение —
**инструкция по смене региона Apple ID на США и установка Streisand** (бесплатный,
open-source, отлично держит VLESS+WS+TLS). Это раздел документации в боте, а не код.

### Отдельно про Amnezia VPN

Рассматривалась, **отклонена**. Amnezia умеет *импортировать* VLESS-конфиги, но
не умеет их создавать и не поддерживает подписки — только одиночный конфиг, который
придётся перевыдавать вручную при каждом изменении. Плюс её iOS-приложение удалено
из российского App Store наравне с остальными, так что главную боль она не решает.

---

## 2. Согласованные решения

| Вопрос | Решение |
| --- | --- |
| iOS | Смена региона Apple ID на США + Streisand (основной), Happ (запасной) |
| Reality | Оставить как второй независимый канал вместо удаляемой Hysteria2 |
| Обрывы VLESS | Обновить Xray-core до v26.3.27 и перейти на `api adu`/`rmu` без рестарта |
| Формат подписки | Добавить base64 со ссылками `vless://` как основной формат |
| Hysteria2 | Удалить полностью — код, бинарник, порт, переменные окружения |
| sing-box JSON | **Оставить** оба эндпоинта: у действующих пользователей Hiddify уже выданы эти ссылки, их нельзя ломать. Формат выбирается по User-Agent |
| Транспорт | Сохраняется как есть: VLESS + WebSocket + TLS на существующих сертификатах |
| Лимит устройств | Два устройства на конфиг. Только уведомление владельцу, без блокировки — см. этап 6 |

Clash.Meta YAML и deep-link-кнопки в плане не участвуют — при желании их можно
добавить позже, точки расширения описаны в разделе 9.

---

## 3. Этап 1. Обновление Xray-core до v26.3.27

**Зачем:** в закреплённой v1.8.24 (конец 2023) нет ни рабочего `api adu`, ни
`heartbeatPeriod`, ни онлайн-статистики по IP. Без обновления этапы 2, 3 и 6 невозможны.

### 3.1. Dockerfile

Найти stage `xray-build` и поднять версию до последнего релиза — на 26 июля 2026
это **v26.3.27** (опубликован 27 марта 2026). Тег фиксируем явно, `latest` не используем.

```dockerfile
FROM base AS xray-build
ARG XRAY_VERSION=v26.3.27   # было v1.8.24
```

Перед началом работ стоит свериться со списком релизов —
https://github.com/XTLS/Xray-core/releases — и взять актуальный тег, если вышел новее.

### 3.2. КРИТИЧНО: сломанный парсинг `xray x25519`

В v25.x изменился формат вывода команды генерации ключей Reality. Было:

```
Private key: <base64>
Public key: <base64>
```

Стало (и менялось внутри самой серии v25 ещё раз):

```
PrivateKey: <base64>
Password: <base64>          # в свежих сборках: "Password (PublicKey): <base64>"
Hash32: <base64>            # нужен только для VLESS encryption, нам не нужен
```

`Password` — это и есть публичный ключ; его переименовали, чтобы люди не
публиковали его бездумно.

Текущий код в `src/xray/xray.service.ts` (метод `generateRealityParams`) парсит
старый формат и на новой версии вернёт `undefined` → сервис упадёт с
«Не удалось разобрать вывод xray x25519».

> Обратите внимание: на **действующем** сервере это выстрелит не сразу. Ключи уже
> лежат в `configs/xray-reality.json`, а генерация запускается только при отсутствии
> файла. Поломка проявится при первом чистом деплое — то есть в самый неудобный момент.
> Чинить обязательно.

Заменить парсинг на устойчивый к обоим форматам:

```typescript
  private async generateRealityParams(): Promise<IXrayRealityParams> {
    const { stdout } = await execAsync('xray x25519');

    // Формат вывода менялся между версиями Xray, поддерживаем оба:
    //   v1.8.x  — "Private key: X" / "Public key: Y"
    //   v25.x   — "PrivateKey: X"  / "Password: Y" (в свежих сборках
    //             "Password (PublicKey): Y"); третья строка Hash32 не нужна.
    const privateKey = stdout.match(/private\s*key:\s*(\S+)/i)?.[1];
    const publicKey =
      stdout.match(/^\s*public\s*key:\s*(\S+)/im)?.[1] ??
      stdout.match(/^\s*password[^:]*:\s*(\S+)/im)?.[1];

    if (!privateKey || !publicKey) {
      throw new InternalServerErrorException(
        `Не удалось разобрать вывод xray x25519: ${stdout}`,
      );
    }

    return {
      privateKey,
      publicKey,
      shortId: randomBytes(8).toString('hex'),
    };
  }
```

Порядок альтернатив важен: `^\s*public\s*key:` с якорем начала строки проверяется
первым, иначе подстрока `(PublicKey):` из нового формата могла бы дать ложное
совпадение.

### 3.3. Включить HandlerService и heartbeat

В `buildServerConfig()` (`src/xray/xray.service.ts`) две правки.

**Секция `api`** — добавить `HandlerService`, без него `adu`/`rmu` вернут ошибку:

```typescript
      api: {
        tag: 'api',
        // HandlerService — добавление/удаление пользователей на лету
        // (xray api adu/rmu), без него правки требуют перезапуска процесса.
        services: ['HandlerService', 'StatsService'],
      },
```

**Секция `policy`** — включить учёт онлайн-подключений, он понадобится на этапе 6
(без этого флага `statsonlineiplist` вернёт пустой результат):

```typescript
      policy: {
        levels: {
          '0': {
            statsUserUplink: true,
            statsUserDownlink: true,
            // Учёт онлайн-подключений пользователя — источник данных для
            // определения числа устройств (см. этап 6). Активным считается
            // соединение в пределах последних 20 секунд.
            statsUserOnline: true,
          },
        },
      },
```

**Инбаунд `ws-cdn`** — добавить `heartbeatPeriod`:

```typescript
          streamSettings: {
            network: 'ws',
            wsSettings: {
              path: this.wsParams.wsPath,
              // Cloudflare рвёт WebSocket после ~100с простоя на планах Free/Pro.
              // Пинг раз в 30с держит канал живым, пока пользователь не шлёт трафик.
              heartbeatPeriod: 30,
            },
          },
```

### 3.4. nginx

В `docker/nginx.conf`, в `location /` (проксирование на Xray), поднять таймауты —
при heartbeat раз в 30 секунд соединение не должно закрываться по нашей же стороне:

```nginx
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
```

### 3.5. Проверка этапа

```bash
docker compose build && docker compose up -d
docker compose exec vpn-bot xray version          # ожидаем v26.3.27
docker compose logs vpn-bot | grep -i xray        # ошибок парсинга/старта нет
```

Подключиться существующим клиентом, дождаться >2 минут простоя без трафика,
убедиться, что соединение живо (это проверка `heartbeatPeriod`).

---

## 4. Этап 2. Hot-reload пользователей без разрыва соединений

**Зачем:** устраняет причину 1.1 — главную причину «отваливается со временем».

### 4.1. Принцип

Разделяем два вида изменений:

- **Изменился только набор клиентов** (создали, удалили, приостановили пира) →
  применяем через gRPC API, процесс не трогаем. Соединения живут.
- **Изменились параметры инбаундов** (ws-путь, ключи Reality, порты) → как и
  раньше, полный перезапуск. Происходит только при старте контейнера.

**Важно:** правки через API живут только в памяти процесса. Если Xray упадёт и
перезапустится (у нас есть авто-restart в `startProcess`), он перечитает `xray.json`
с диска. Поэтому **файл конфига нужно продолжать писать всегда**, даже когда
перезапуска не делаем. Иначе после падения часть пользователей исчезнет.

### 4.2. Синтаксис CLI (проверен по исходникам Xray-core)

Добавление — принимает один или несколько **файлов конфига**, из которых берёт
`inbounds[].tag` и список пользователей:

```
xray api adu [--server=127.0.0.1:8080] <c1.json> [c2.json]...
```

Удаление — принимает тег инбаунда и список email:

```
xray api rmu [--server=127.0.0.1:8080] -tag=<tag> <email1> [email2]...
```

Флаги обеих команд: `-s`/`--server` (по умолчанию `127.0.0.1:8080`),
`-t`/`--timeout` (по умолчанию 3 секунды). Поддерживаемые протоколы: VMess, VLESS,
Trojan, Shadowsocks — VLESS в списке есть.

У нас API слушает на `127.0.0.1:${this.statsApiPort}` (по умолчанию 8881),
инбаунды называются `ws-cdn` и `reality-direct`, а `email` клиента — это `peer.name`.

### 4.3. Реализация в `src/xray/xray.service.ts`

Добавить импорты `os` и `unlink` из `fs/promises`, если их ещё нет.

**Шаг 1.** Вынести сборку конфига так, чтобы её можно было применить к произвольному
подмножеству клиентов — тогда файл для `adu` гарантированно валиден и не разъезжается
с основным конфигом. Изменить сигнатуру:

```typescript
  private buildServerConfig(
    clients: IXrayClient[] = this.clients,
  ): Record<string, unknown> {
    const inboundClients: IXrayInboundClient[] = clients.map((client) => ({
      id: client.uuid,
      email: client.name,
    }));
    // ...остальное тело без изменений
  }
```

**Шаг 2.** Заменить `applyReload()` на инкрементальную версию:

```typescript
  /**
   * Применяет отложенный набор клиентов. Разницу (добавленные/удалённые)
   * отправляем в живой процесс через HandlerService — соединения остальных
   * пользователей не рвутся. Конфиг на диске переписываем всегда: при падении
   * процесса Xray перечитает именно его, а правки через API живут только в памяти.
   * Если API недоступен — откатываемся на перезапуск, как раньше.
   */
  private async applyReload(): Promise<void> {
    const clients = this.pendingClients;
    if (!clients) return;
    this.pendingClients = null;

    const previous = this.clients;

    await this.mutex.runExclusive(async () => {
      this.clients = clients;
      await this.writeConfig();

      // Процесс ещё не поднят — применять через API нечему.
      if (!this.currentProc) {
        this.startProcess();
        return;
      }

      const applied = await this.applyClientsDiff(previous, clients);
      if (!applied) {
        this.logger.warn(
          'Не удалось применить клиентов через Xray API — перезапускаю процесс',
        );
        await this.stopProcess();
        this.startProcess();
      }
    });

    this.appliedSignature = this.clientsSignature(clients);
    this.logger.log(`Xray синхронизирован: ${clients.length} клиент(ов)`);
  }
```

**Шаг 3.** Сам диф и вызовы API:

```typescript
  /** Теги инбаундов, в которых живут VLESS-клиенты (см. buildServerConfig). */
  private static readonly CLIENT_INBOUND_TAGS = ['ws-cdn', 'reality-direct'];

  /**
   * Досылает в работающий Xray разницу между наборами клиентов.
   * Возвращает false, если хоть один вызов API не удался — вызывающий код
   * тогда сделает полный перезапуск.
   */
  private async applyClientsDiff(
    previous: IXrayClient[],
    next: IXrayClient[],
  ): Promise<boolean> {
    const previousByName = new Map(previous.map((c) => [c.name, c.uuid]));
    const nextByName = new Map(next.map((c) => [c.name, c.uuid]));

    // Смена uuid у существующего имени — это удаление плюс добавление.
    const added = next.filter((c) => previousByName.get(c.name) !== c.uuid);
    const removed = previous
      .filter((c) => nextByName.get(c.name) !== c.uuid)
      .map((c) => c.name);

    if (added.length === 0 && removed.length === 0) return true;

    try {
      if (removed.length > 0) await this.removeUsersViaApi(removed);
      if (added.length > 0) await this.addUsersViaApi(added);
      return true;
    } catch (error) {
      this.logger.warn(
        `Xray API отклонил изменение клиентов: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }

  /**
   * xray api adu принимает файл конфига и вытаскивает из него inbounds[].tag
   * вместе со списком пользователей. Переиспользуем buildServerConfig с
   * подмножеством клиентов — так формат гарантированно совпадает с рабочим.
   */
  private async addUsersViaApi(clients: IXrayClient[]): Promise<void> {
    const tmpPath = path.join(
      os.tmpdir(),
      `xray-adu-${randomBytes(6).toString('hex')}.json`,
    );

    try {
      await writeFile(
        tmpPath,
        JSON.stringify(this.buildServerConfig(clients), null, 2),
      );
      await execAsync(
        `xray api adu --server=127.0.0.1:${this.statsApiPort} ${tmpPath}`,
      );
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }

  private async removeUsersViaApi(emails: string[]): Promise<void> {
    // Кавычки вокруг email обязательны: peer.name генерируется нами и безопасен,
    // но команда собирается строкой — оставляем защиту от пробелов явной.
    const args = emails.map((email) => `"${email}"`).join(' ');

    for (const tag of XrayService.CLIENT_INBOUND_TAGS) {
      await execAsync(
        `xray api rmu --server=127.0.0.1:${this.statsApiPort} -tag=${tag} ${args}`,
      );
    }
  }
```

### 4.4. Подводные камни

- **Повторное добавление существующего клиента** `adu` отклонит ошибкой. Наш диф
  этого не допускает, но если `appliedSignature` разъедется с реальностью —
  сработает fallback на перезапуск, это допустимо.
- **`rmu` по несуществующему email** тоже может вернуть ошибку. Она поймается в
  `applyClientsDiff` и приведёт к перезапуску — поведение не хуже текущего.
- **`RELOAD_DEBOUNCE_MS`** можно оставить 1500 мс: коалесцирование всё ещё полезно,
  просто теперь оно экономит вызовы API, а не спасает от обрывов.

### 4.5. Проверка этапа

Главный сценарий — ровно та жалоба, с которой всё началось:

1. Подключиться клиентом, запустить непрерывную нагрузку (видео на YouTube).
2. Из бота создать новый конфиг другому пользователю и удалить третий.
3. Видео **не должно прерваться**. В логах — `Xray синхронизирован`, но
   **без** строки `xray запущен (pid=...)`.
4. Убедиться, что новый пир реально подключается (то есть `adu` отработал, а не
   просто промолчал).

---

## 5. Этап 3. Полное удаление Hysteria2

Порядок: сначала отвязать от кода, затем убрать инфраструктуру.

### 5.1. Удалить целиком

- `src/hysteria/hysteria.service.ts`
- `src/hysteria/hysteria.module.ts`

### 5.2. `src/app.module.ts`

Убрать импорт `HysteriaModule` (строка 7) и запись в массиве `imports` (строка 34).

### 5.3. `src/peers/peers.module.ts`

Убрать импорт (строка 6) и `HysteriaModule` из `imports` (строка 9), оставив `XrayModule`.

### 5.4. `src/peers/peers.service.ts`

Здесь больше всего точек. Все они найдены, доисследование не требуется:

| Строки | Что сделать |
| --- | --- |
| 25–26 | Убрать импорты `HysteriaService` и типа `IHysteriaClient` |
| 65 | Убрать `hysteriaService` из конструктора |
| 72–75 | Поправить комментарий: остаётся только `XrayService` |
| 80–81 | Убрать вызовы `backfillHysteriaPasswords()` и `syncHysteriaWithDb()` из `onApplicationBootstrap` |
| 191–215 | Удалить метод `syncHysteriaWithDb` целиком |
| 218–236 | Удалить метод `backfillHysteriaPasswords` целиком |
| 356, 363 | В `createPeer` убрать генерацию и запись `hysteriaPassword` |
| 389–392 | В `createPeer` убрать вызов `syncHysteriaWithDb`, поправить комментарий |
| 470–473 | То же в `updatedPeer` |
| 504–506 | То же в `deletePeer` |
| 536–538 | То же в `deletePeersByNames` |
| 850–852 | То же в `deactivateExpiredPeers` |
| 1036–1071 | В `refreshPeerTrafficStats` убрать второй источник статистики: `Promise.all` схлопывается в один вызов `xrayService.getTrafficStats()`, из сумм уходят `hysteria?.rx` и `hysteria?.tx` |
| 1366 | Поправить комментарий в `replacePeer` |
| 1432–1456 | `buildCombinedConfigText` — переписывается на этапе 4, см. раздел 6.4 |

Отдельно: убрать проверки вида `if (!peer.vlessUuid || !peer.hysteriaPassword)` —
должно остаться только требование `vlessUuid`.

### 5.5. `src/subscription/subscription.service.ts`

- Убрать импорт и поле `hysteriaService` из конструктора.
- В `buildSingBoxConfig` удалить outbound с тегом `direct-mobile` целиком.
- Из групп `urltest` (`auto`) и `selector` (`select`) убрать `'direct-mobile'`
  из массивов `outbounds` — останется `['cdn-wifi', 'reality-direct']`.
- Тип параметра сузить: `Pick<TPeerSelect, 'name' | 'vlessUuid'>`.
- Обновить докблок класса: описаны три механизма обхода, остаётся два.

Комментарий про плоскую структуру `urltest` **сохранить** — там зафиксирован
реальный инцидент с зависанием вложенных групп, эти грабли нельзя терять.

### 5.6. `src/database/schema.ts`

Колонку `hysteriaPassword` **оставить как есть** (строки 84–86), но обновить
комментарий. Это ровно тот подход, который уже применён в проекте к полям
`publicKey`/`privateKey`/`presharedKey` после отказа от WireGuard:

```typescript
    // Hysteria2 упразднена — поле остаётся nullable ради обратной совместимости
    // со старыми записями, новые пиры его не заполняют (как publicKey/privateKey от WG).
    hysteriaPassword: text('hysteriaPassword').unique(),
```

Миграция для дропа колонки **не создаётся**: в SQLite это пересоздание таблицы с
переносом данных ради нулевой выгоды, плюс так шаг остаётся откатываемым.

### 5.7. Инфраструктура

**`Dockerfile`:** удалить stage `hysteria-build` (строки 64–76) и строку
`COPY --from=hysteria-build /hysteria/hysteria /usr/bin/hysteria` (строка 103).
Комментарий про `openssl` (строка 91) поправить: openssl ставился для генерации
самоподписанного сертификата Hysteria — проверить, не нужен ли он ещё где-то, и
если нет, убрать пакет из `apk add`.

**`docker-compose.yml`:** удалить проброс UDP-порта (строки 44–45):

```yaml
      - '${HYSTERIA_PORT:-8443}:${HYSTERIA_PORT:-8443}/udp'
```

> Обратите внимание: `HYSTERIA_PORT` и `REALITY_PORT` по умолчанию оба равны 8443.
> Порты не конфликтовали только потому, что один UDP, а другой TCP. После удаления
> UDP-строки Reality на 8443/tcp продолжает работать — **менять `REALITY_PORT`
> не нужно**, иначе сломаются все выданные ссылки.

**`.env.example`:** удалить блок `HYSTERIA_*` (строки 20–28).
**`.env` на сервере:** те же переменные можно убрать после успешного деплоя.

**`configs/`:** после деплоя удалить осиротевшие файлы Hysteria
(`hysteria.yaml`, сертификат/ключ — точные имена посмотреть в удаляемом
`hysteria.service.ts` перед удалением файла).

### 5.8. Проверка этапа

```bash
pnpm run build          # сборка без ошибок типов
pnpm exec eslint src    # нет неиспользуемых импортов
grep -ri hysteria src/  # только комментарий в schema.ts
```

---

## 6. Этап 4. Универсальная подписка

**Зачем:** это и есть ответ на «нет клиента ни на одном устройстве». После этого
этапа подписка работает в v2rayNG, v2rayN, v2RayTun, Streisand, V2Box, Shadowrocket,
Happ, Karing, Hiddify, NekoBox и sing-box — без изменений на сервере под каждый.

### 6.1. Исправить рассогласование в `vless://`-ссылке (сделать до остального)

В `src/xray/xray.service.ts`, метод `buildClientLink`, в query-параметрах **нет
`fp=chrome`**, хотя в sing-box-подписке для того же канала `cdn-wifi` включён
uTLS с отпечатком Chrome, и в `buildRealityClientLink` `fp` тоже есть. Из-за этого
DPI видит разный ClientHello у одного и того же канала в зависимости от того, как
клиент импортировал конфиг. Добавить:

```typescript
    const query = new URLSearchParams({
      type: 'ws',
      security: 'tls',
      encryption: 'none',
      path: this.wsParams.wsPath,
      host: this.domain as string,
      sni: this.domain as string,
      // Тот же uTLS-отпечаток, что и в sing-box-подписке — иначе DPI видит
      // рассогласование ClientHello между прямой ссылкой и подпиской.
      fp: 'chrome',
    });
```

### 6.2. `src/subscription/subscription.service.ts` — сборка base64

Добавить два метода (после удаления Hysteria по разделу 5.5):

```typescript
  /**
   * Ссылки vless:// на все каналы пира. Имена в якоре (#...) видит пользователь
   * в списке серверов клиента — они должны быть понятны без объяснений.
   */
  buildShareLinks(peer: Pick<TPeerSelect, 'name' | 'vlessUuid'>): string[] {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    return [
      this.xrayService.buildClientLink(`${peer.name} · CDN`, peer.vlessUuid),
      this.xrayService.buildRealityClientLink(
        `${peer.name} · Прямой`,
        peer.vlessUuid,
      ),
    ];
  }

  /**
   * Универсальный формат подписки: ссылки через перевод строки, всё вместе в
   * base64. Понимают v2rayNG, v2rayN, v2RayTun, Streisand, V2Box, Shadowrocket,
   * Happ, Karing — то есть все клиенты, кроме тех, что хотят sing-box JSON.
   */
  buildBase64Subscription(peer: Pick<TPeerSelect, 'name' | 'vlessUuid'>): string {
    return Buffer.from(this.buildShareLinks(peer).join('\n'), 'utf-8').toString(
      'base64',
    );
  }
```

### 6.3. `src/subscription/subscription.controller.ts` — выбор формата

Ключевое требование: **старый URL `/sub/:uuid` менять нельзя** — он уже выдан
действующим пользователям Hiddify. Поэтому формат выбирается автоматически по
User-Agent, а явный `?format=` даёт ручное управление для отладки и поддержки.

Создать `src/subscription/interfaces/subscription-format.interface.ts`:

```typescript
/** Формат ответа подписки. */
export type TSubscriptionFormat = 'base64' | 'singbox';

/** Клиенты на движке sing-box — им нужен JSON, остальным base64. */
const SINGBOX_CLIENT_MARKERS = [
  'hiddify',
  'sing-box',
  'singbox',
  'nekobox',
  'nekoray',
  'karing',
] as const;

/**
 * Определяет формат по User-Agent клиента. Явный ?format= имеет приоритет,
 * дальше — маркеры sing-box-клиентов, по умолчанию base64 как самый совместимый.
 */
export function resolveSubscriptionFormat(
  userAgent: string | undefined,
  explicit: string | undefined,
): TSubscriptionFormat {
  if (explicit === 'base64' || explicit === 'singbox') return explicit;

  const ua = (userAgent ?? '').toLowerCase();
  return SINGBOX_CLIENT_MARKERS.some((marker) => ua.includes(marker))
    ? 'singbox'
    : 'base64';
}
```

Переписать контроллер:

```typescript
import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PeersService } from 'src/peers/peers.service';
import { SubscriptionService } from './subscription.service';
import { resolveSubscriptionFormat } from './interfaces/subscription-format.interface';

@Controller('sub')
export class SubscriptionController {
  constructor(
    private readonly peersService: PeersService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Формат выбирается по User-Agent: клиентам на движке sing-box (Hiddify,
   * NekoBox, Karing) отдаём JSON — ссылки на этот URL у них уже выданы и
   * ломать их нельзя. Всем остальным — base64 со ссылками vless://.
   */
  @Get(':uuid')
  async getSubscription(
    @Param('uuid') uuid: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);

    this.subscriptionService.applySubscriptionHeaders(res, peer);

    if (resolveSubscriptionFormat(userAgent, format) === 'singbox') {
      res.json(this.subscriptionService.buildSingBoxConfig(peer));
      return;
    }

    res.type('text/plain; charset=utf-8');
    res.send(this.subscriptionService.buildBase64Subscription(peer));
  }

  /** Полный конфиг (log+dns+inbounds) — для официальных клиентов sing-box (SFA/SFI/SFM). */
  @Get(':uuid/full')
  async getFullSubscription(
    @Param('uuid') uuid: string,
    @Res() res: Response,
  ): Promise<void> {
    const peer = await this.peersService.findPeerByVlessUuid(uuid);
    this.subscriptionService.applySubscriptionHeaders(res, peer);
    res.json(this.subscriptionService.buildFullSingBoxConfig(peer));
  }
}
```

### 6.4. Заголовки подписки — срок и трафик прямо в клиенте

Клиенты (Happ, Streisand, v2rayN, Hiddify, v2RayTun) читают стандартные заголовки
и показывают пользователю остаток дней и трафик. Это заметно снижает поток вопросов
в поддержку. Добавить в `SubscriptionService`:

```typescript
  /**
   * Стандартные заголовки подписки. Их читают Happ, Streisand, v2rayN, Hiddify:
   * пользователь видит срок и трафик прямо в приложении, не заходя в бот.
   */
  applySubscriptionHeaders(res: Response, peer: TPeerSelect): void {
    // total=0 — безлимит по трафику; expire в секундах Unix, 0 — бессрочно.
    const expire = peer.expiresAt
      ? Math.floor(peer.expiresAt.getTime() / 1000)
      : 0;

    res.setHeader(
      'Subscription-Userinfo',
      `upload=${peer.txBytes}; download=${peer.rxBytes}; total=0; expire=${expire}`,
    );
    // Через сколько часов клиенту перечитать подписку.
    res.setHeader('Profile-Update-Interval', '12');
    res.setHeader(
      'Profile-Title',
      `base64:${Buffer.from(peer.name, 'utf-8').toString('base64')}`,
    );
  }
```

Импортировать `Response` из `express` типом (`import type { Response } from 'express'`).
`TPeerSelect` уже экспортируется из `peers.service.ts`.

### 6.5. `buildCombinedConfigText` в `peers.service.ts`

Переписать текст, который бот отдаёт пользователю: убрать Hysteria, вывести
универсальную подписку на первое место.

```typescript
  private buildCombinedConfigText(peer: TPeerSelect): string {
    if (!peer.vlessUuid) {
      throw new InternalServerErrorException(
        `У конфига ${peer.name} отсутствует vlessUuid`,
      );
    }

    const subscriptionUrl = this.buildSubscriptionUrl(peer.vlessUuid);
    const links = this.subscriptionService.buildShareLinks(peer);

    return (
      `🔗 *Ссылка-подписка* — работает во всех приложениях, ` +
      `авто-переключение между каналами:\n\`${subscriptionUrl}\`\n\n` +
      `*Если подписка не добавляется* — импортируйте каналы по отдельности:\n` +
      links.map((link) => `\`${link}\``).join('\n\n')
    );
  }
```

Здесь появляется зависимость `PeersService` → `SubscriptionService`. Сейчас
направление обратное (`SubscriptionModule` импортирует `PeersModule`), так что
прямое внедрение создаст цикл. Варианта два, выбрать первый:

1. **Перенести сборку ссылок в `XrayService`** — там уже живут `buildClientLink`
   и `buildRealityClientLink`, добавить туда `buildShareLinks`, а `SubscriptionService`
   пусть вызывает его же. `PeersService` уже зависит от `XrayService`, цикла нет.
   Это и по смыслу правильнее: ссылки — знание транспорта, а не формата подписки.
2. Оставить в `SubscriptionService` и развязать через `forwardRef` — рабочее, но
   `forwardRef` прячет зависимость, чего в проекте стоит избегать.

### 6.6. Проверка этапа

```bash
# Клиент на движке sing-box — должен прийти JSON
curl -H 'User-Agent: Hiddify/2.0' https://<домен>/sub/<uuid> | head -c 200

# Обычный клиент — должен прийти base64
curl -H 'User-Agent: v2rayNG/1.9.0' https://<домен>/sub/<uuid>

# Проверить, что декодируется в осмысленные ссылки
curl -H 'User-Agent: v2rayNG/1.9.0' https://<домен>/sub/<uuid> | base64 -d

# Заголовки на месте
curl -sI https://<домен>/sub/<uuid> | grep -i subscription-userinfo
```

Затем — живой прогон: добавить подписку в v2rayNG на Android и в v2rayN на Windows,
убедиться, что видны оба канала и оба подключаются.

---

## 7. Этап 5. Тексты и инструкции в боте

### 7.1. Вычистить упоминания Hysteria2

`src/bot/ui/bot.ui.ts`, строки 376, 1072, 1076, 1128 — переписать. В частности,
строка 1076 перечисляет три канала (`cdn-wifi`, `reality-direct`, `direct-mobile`) —
должно остаться два.

### 7.2. Раздел «Какое приложение установить»

Добавить в справку бота. Матрица проверена на июль 2026:

| Платформа | Основной клиент | Запасной | Где взять |
| --- | --- | --- | --- |
| iPhone / iPad | Streisand | Happ | App Store с аккаунтом региона США (см. 7.3) |
| Android | v2rayNG | Hiddify | GitHub Releases (`2dust/v2rayNG`) |
| Windows | v2rayN | Hiddify | GitHub Releases (`2dust/v2rayN`) |
| macOS | V2Box | Streisand | App Store с аккаунтом региона США |
| Linux | Hiddify | Nekoray | GitHub Releases |

### 7.3. Инструкция для iPhone (самое важное для поддержки)

Текст должен честно объяснять, почему без смены региона никак — иначе пользователи
будут снова и снова писать «а нет ли приложения попроще».

> **Почему в App Store ничего не находится.** В марте 2026 Apple по требованию
> Роскомнадзора удалила из российского App Store все подобные приложения, а
> 24 июня 2026 — и последнее остававшееся. Это ограничение самого App Store,
> а не нашего сервиса: приложение существует и работает, оно просто не отдаётся
> аккаунтам с российским регионом. Обходится сменой региона Apple ID — бесплатно,
> занимает пять минут, ничего не удаляет с телефона.
>
> **Как сменить регион:**
> 1. Настройки → ваше имя вверху → «Медиаматериалы и покупки» → «Просмотреть учётную запись».
> 2. «Страна/регион» → «Изменить страну или регион» → United States.
> 3. Способ оплаты — **None**. Карта не нужна.
> 4. Адрес — любой существующий американский, телефон в формате `+1 XXX XXX XXXX`.
> 5. Принять условия. Готово.
>
> **Что нужно знать заранее:** баланс Apple ID должен быть нулевым, а активные
> подписки, купленные в российском регионе, придётся отменить до смены. Уже
> установленные приложения и данные остаются на месте. Вернуть регион обратно
> можно в любой момент тем же путём.
>
> **Дальше:** найти в App Store **Streisand** (бесплатно) → открыть ссылку-подписку
> из бота → приложение предложит её добавить → нажать «Подключить».

### 7.4. Убрать привязку к Hiddify в текстах

Формулировки вида «подписка для Hiddify/NekoBox» заменить на «ссылка-подписка,
работает во всех приложениях из списка выше». Hiddify остаётся поддержанным,
но перестаёт быть единственным вариантом.

---

## 8. Этап 6. Лимит устройств: два на конфиг, только уведомления

### 8.1. Встроенного лимита в Xray-core нет — и это важно понимать

Проверено по репозиторию и обсуждениям: параметр `limitIp`, который часто
принимают за возможность ядра, — это **фича панели 3x-ui**, а не Xray-core.
В самом ядре ограничение числа устройств не реализовано, запросы на него висят
открытыми (Discussions #3739, #2271, Issue #3667). Более того, у 3x-ui `limitIp`
известен тем, что не срабатывает для VLESS с потоком `xtls-rprx-vision`.

**Но в v26.3.27 есть то, что нужно для наблюдения** — read-only команда,
возвращающая список активных IP по конкретному пользователю:

```
xray api statsonlineiplist [--server=127.0.0.1:8080] -email <email>
xray api statsonlineiplist [--server=127.0.0.1:8080] -all [-include-traffic] [-reset]
```

Внутри для одного пользователя формируется запрос по имени счётчика
`user>>><email>>>>online`, ответ печатается как JSON. Требует включённого
`statsUserOnline: true` в policy — это уже добавлено на этапе 1 (раздел 3.3).

Это **строго лучше** старого подхода. Прежний `xray-access-log-watcher.service`
парсил access.log регуляркой

```
/from (\S+?):\d+ accepted .*\[reality-direct[^\]]*\].*email: (\S+)/
```

— то есть видел **только канал `reality-direct`**, а весь CDN-трафик через
`ws-cdn` проходил мимо учёта. Плюс в текущем `buildServerConfig()` секция `log`
содержит лишь `{ loglevel: 'warning' }`, без пути к access-логу, так что писать
было и некуда. Новый подход покрывает оба инбаунда и не требует логов вообще.

### 8.2. Что уцелело от старой реализации

Важное уточнение: **в git этого кода нет**. `dist/` числится в `.gitignore`
(строка 2), исходники `src/security/*.ts` никогда не коммитились и на диске
отсутствуют. Единственной сохранившейся копией был скомпилированный
`dist/src/security/device-limit.service.js` от прошлой сборки, который затёрся бы
при следующем `pnpm run build`.

Он уже спасён — копии лежат в **`reference/legacy-device-limit/`**:

- `device-limit.service.js` — эвристика обнаружения и уведомления;
- `xray-access-log-watcher.service.js` — старый сбор IP через access.log
  (берём только как справку — заменяется на `statsonlineiplist`).

Папка отслеживается git, так что больше не потеряется. После переноса
логики в `src/security/` её можно удалить.

Ещё одно наблюдение из того же файла: **блокировка там уже была отключена**.
Метод `flagSecondDevice` пишет запись в таблицу и шлёт уведомление, а в логе
прямым текстом «уведомление владельцу отправлено, бан НЕ применялся». То есть
режим, который сейчас запрашивается, ранее уже был реализован — новая версия
должна его сохранить, изменив лишь порог с одного устройства на два.

Параметры старой эвристики, которые стоит перенести (они выстраданы практикой):

| Константа | Значение | Смысл |
| --- | --- | --- |
| `PRIMARY_STALE_MS` | 5 мин | Смена сети Wi-Fi↔мобильный не считается вторым устройством |
| `MIN_CHALLENGER_SIGHTINGS` | 3 | Разовый всплеск не повод для уведомления |
| `MAX_AUTO_BANS_PER_DAY` | 3 | Защита от спама уведомлениями |
| `DEVICE_LIMIT_WHITELIST_CIDRS` | — | Исключения по подсетям |

### 8.3. ПЕРВЫЙ ШАГ: снять реальный формат вывода

Точная структура JSON у `statsonlineiplist` в документации не зафиксирована, а
CLI просто печатает ответ через `showJSONResponse()`. **Не пишите парсер вслепую.**
После деплоя этапа 1 выполнить на живом сервере с подключённым клиентом:

```bash
docker compose exec vpn-bot xray api statsonlineiplist \
  --server=127.0.0.1:8881 -email <имя_пира>

docker compose exec vpn-bot xray api statsonlineiplist \
  --server=127.0.0.1:8881 -all
```

Записать фактический вывод и написать парсер под него. Ожидается отображение
IP → время последнего обращения, но проверить обязательно. Вариант с `-all`
предпочтителен: один вызов вместо N по числу пиров.

### 8.4. Новая таблица в БД

Таблицы `peerIpBans` из старой версии в текущем `src/database/schema.ts` нет —
её нужно завести заново. Раз блокировок не будет, назовём по факту происходящего:

```typescript
/** Обнаружения превышения лимита устройств. Блокировка не применяется — только уведомление. */
export const peerDeviceAlerts = sqliteTable(
  'peer_device_alerts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    peerName: text('peerName').notNull(),
    /** Сколько одновременных IP насчитали в момент срабатывания. */
    deviceCount: integer('deviceCount').notNull(),
    /** Список IP через запятую — для разбора обращений в поддержку. */
    ips: text('ips').notNull(),
    notifiedAt: integer('notifiedAt', { mode: 'timestamp' }).$defaultFn(
      () => new Date(),
    ),
  },
  (table) => [
    index('peer_device_alerts_peer_idx').on(table.peerName),
    index('peer_device_alerts_notified_idx').on(table.notifiedAt),
  ],
);
```

Затем `pnpm run generate` — drizzle-kit создаст миграцию.

### 8.5. Сервис

Создать `src/security/device-limit.service.ts` и `src/security/security.module.ts`,
подключить модуль в `app.module.ts`. Логика заметно проще старой: `statsonlineiplist`
отдаёт готовый список активных IP, поэтому машина состояний primary/challenger
больше не нужна — достаточно счётчика подряд идущих подтверждений.

```typescript
/** Сколько проверок подряд должны показать превышение, прежде чем уведомлять. */
const CONFIRMATIONS_REQUIRED = 3;
/** Не беспокоить одного владельца чаще, чем раз в сутки. */
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60_000;

@Injectable()
export class DeviceLimitService {
  private readonly logger = new Logger(DeviceLimitService.name);
  /** peerName → сколько проверок подряд лимит был превышен. */
  private readonly strikes = new Map<string, number>();

  private readonly enabled: boolean;
  private readonly maxDevices: number;
  private readonly whitelistCidrs: string[];

  constructor(
    @Inject(DRIZZLE) private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly configService: ConfigService,
    private readonly xrayService: XrayService,
    private readonly notificationService: NotificationService,
  ) {
    this.enabled =
      this.configService.get<string>('DEVICE_LIMIT_ENABLED', 'false') === 'true';
    this.maxDevices = Number(
      this.configService.get<string>('DEVICE_LIMIT_MAX_DEVICES', '2'),
    );
    this.whitelistCidrs = (
      this.configService.get<string>('DEVICE_LIMIT_WHITELIST_CIDRS', '') ?? ''
    )
      .split(',')
      .map((cidr) => cidr.trim())
      .filter((cidr) => cidr.length > 0);
  }

  /**
   * Раз в минуту снимаем список онлайн-IP по всем пирам. Превышение должно
   * подтвердиться CONFIRMATIONS_REQUIRED раз подряд — иначе кратковременное
   * переключение сети (мобильный ↔ Wi-Fi) выглядело бы как лишнее устройство.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkOnlineDevices(): Promise<void> {
    if (!this.enabled) return;

    const onlineByPeer = await this.xrayService.getOnlineIps();

    for (const [peerName, ips] of onlineByPeer) {
      const counted = ips.filter((ip) => !this.isWhitelisted(ip));

      if (counted.length <= this.maxDevices) {
        this.strikes.delete(peerName);
        continue;
      }

      const strikes = (this.strikes.get(peerName) ?? 0) + 1;
      this.strikes.set(peerName, strikes);

      if (strikes < CONFIRMATIONS_REQUIRED) continue;

      this.strikes.delete(peerName);
      await this.reportExcess(peerName, counted);
    }

    // Пиры, пропавшие из выдачи, не должны копить состояние.
    for (const peerName of this.strikes.keys()) {
      if (!onlineByPeer.has(peerName)) this.strikes.delete(peerName);
    }
  }

  /**
   * Фиксируем факт и уведомляем владельца. Блокировка НЕ применяется —
   * режим наблюдения, чтобы сначала оценить, сколько ложных срабатываний даёт
   * эвристика на реальных пользователях.
   */
  private async reportExcess(peerName: string, ips: string[]): Promise<void> {
    if (await this.wasNotifiedRecently(peerName)) return;

    await this.db.insert(schema.peerDeviceAlerts).values({
      peerName,
      deviceCount: ips.length,
      ips: ips.join(','),
    });

    this.logger.warn(
      `Конфиг "${peerName}": ${ips.length} устройств одновременно ` +
        `(лимит ${this.maxDevices}) — владелец уведомлён, блокировка не применялась`,
    );

    await this.notifyOwner(peerName, ips.length);
  }

  private async wasNotifiedRecently(peerName: string): Promise<boolean> {
    const since = new Date(Date.now() - NOTIFY_COOLDOWN_MS);
    const recent = await this.db.query.peerDeviceAlerts.findFirst({
      where: and(
        eq(schema.peerDeviceAlerts.peerName, peerName),
        gte(schema.peerDeviceAlerts.notifiedAt, since),
      ),
      columns: { id: true },
    });
    return !!recent;
  }

  private async notifyOwner(peerName: string, count: number): Promise<void> {
    try {
      const peer = await this.db.query.peers.findFirst({
        where: eq(schema.peers.name, peerName),
        columns: { telegramId: true },
      });
      if (!peer?.telegramId) return;

      await this.notificationService.notifyUser(
        peer.telegramId,
        'Подключено больше устройств, чем предусмотрено',
        `На вашем конфиге сейчас активно ${count} устройств, ` +
          `а одна ссылка рассчитана на ${this.maxDevices}.\n\n` +
          'Пока ничего не отключено — это предупреждение. ' +
          'Чтобы скорость и стабильность не падали, оформите вторую ссылку в боте.',
      );
    } catch (error) {
      this.logger.error(
        `Не удалось уведомить владельца конфига "${peerName}": ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private isWhitelisted(ip: string): boolean {
    if (this.whitelistCidrs.length === 0) return false;
    try {
      return ipRangeCheck(ip, this.whitelistCidrs);
    } catch {
      return false;
    }
  }
}
```

Пакет `ip-range-check` уже есть в `package.json` (версия `^0.2.0`) — остался со
времён старого сервиса, ставить ничего не нужно.

### 8.6. Метод в `XrayService`

Парсинг подогнать под фактический вывод из шага 8.3 — приведённая форма
（`{ "<email>": { "ips": { "<ip>": <timestamp> } } }`）**подлежит проверке**.

```typescript
  /**
   * Список активных IP по каждому пиру через StatsService. Требует
   * statsUserOnline:true в policy. Ошибка не должна ронять вызывающий крон —
   * возвращаем пустую карту (например, пока Xray не поднялся).
   */
  async getOnlineIps(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();

    try {
      const { stdout } = await execAsync(
        `xray api statsonlineiplist --server=127.0.0.1:${this.statsApiPort} -all`,
      );
      // ВНИМАНИЕ: форму ответа сверить с реальным выводом (см. раздел 8.3)
      // и при необходимости поправить разбор ниже.
      const parsed = JSON.parse(stdout) as Record<
        string,
        { ips?: Record<string, number> }
      >;

      for (const [email, entry] of Object.entries(parsed)) {
        const ips = Object.keys(entry.ips ?? {});
        if (ips.length > 0) result.set(email, ips);
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось получить онлайн-IP из Xray: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    return result;
  }
```

### 8.7. Переменные окружения

Добавить в `.env.example` (и в `.env` на сервере):

```bash
# Лимит устройств на конфиг. Режим наблюдения: превышение только логируется
# и приводит к уведомлению владельца, доступ НЕ ограничивается.
DEVICE_LIMIT_ENABLED=true
DEVICE_LIMIT_MAX_DEVICES=2
# Подсети-исключения через запятую, напр. офисный NAT: 203.0.113.0/24
DEVICE_LIMIT_WHITELIST_CIDRS=
```

### 8.8. Проверка этапа

1. Подключиться тремя устройствами к одному конфигу (третье — например, через
   мобильный интернет, чтобы IP гарантированно отличался).
2. Подождать 3–4 минуты (три подтверждения при опросе раз в минуту).
3. В логах появляется `владелец уведомлён, блокировка не применялась`,
   в Telegram приходит уведомление, в `peer_device_alerts` появляется запись.
4. Отключить третье устройство — повторных уведомлений быть не должно, а связь
   на всех устройствах должна остаться живой (проверка того, что бана правда нет).
5. Отдельно проверить ложные срабатывания: переключить телефон с Wi-Fi на
   мобильный интернет и обратно — уведомление приходить **не должно**.

Пожить в этом режиме неделю и посмотреть на долю ложных срабатываний в
`peer_device_alerts`, прежде чем даже обсуждать ужесточение.

---

## 9. Порядок работ, проверка и откат

### Последовательность

Этапы **строго по порядку** — 2 зависит от 1, остальные от них:

1. **Этап 1** (обновление Xray до v26.3.27 + heartbeat + policy) — деплой, наблюдение сутки.
2. **Этап 2** (hot-reload) — деплой, проверка сценария из 4.5.
3. **Этап 3** (удаление Hysteria) — деплой.
4. **Этап 4** (универсальная подписка) — деплой, проверка из 6.6.
5. **Этап 5** (тексты бота) — деплой, рассылка пользователям.
6. **Этап 6** (лимит устройств) — делается **последним**. Начать с шага 8.3
   (снять реальный формат вывода), его можно выполнить сразу после этапа 1.

Этапы 1–2 закрывают жалобу на обрывы, этап 4 — жалобу на клиенты. Если время
ограничено, делать в этом порядке, этапы 3, 5 и 6 можно отложить.

> Важно для этапа 6: перед первой же пересборкой сохраните копию
> `dist/src/security/device-limit.service.js` в безопасное место — это единственная
> сохранившаяся версия той логики, в git её нет.

### Что проверить после всего

- Существующая подписка в Hiddify продолжает работать без переподключения.
- Новая подписка добавляется в v2rayNG (Android) и v2rayN (Windows).
- В клиенте виден срок действия конфига (заголовок `Subscription-Userinfo`).
- Создание конфига в боте не обрывает чужое активное соединение.
- Соединение переживает 5 минут полного простоя (heartbeat против Cloudflare).
- Трафик считается: `refreshPeerTrafficStats` возвращает ненулевые значения.
- Превышение лимита устройств даёт уведомление и **не** обрывает связь.

### Откат

Каждый этап откатывается отдельным revert-коммитом. Особые случаи:

- **Этап 1:** вернуть `ARG XRAY_VERSION=v1.8.24`. Файл `configs/xray-reality.json`
  трогать не нужно — ключи совместимы между версиями.
- **Этап 3:** необратим по данным только в части `configs/` (файлы Hysteria удаляются).
  Колонка `hysteriaPassword` в БД остаётся нетронутой, так что revert кода
  восстанавливает работу — новым пирам понадобится бэкфилл пароля.
- **Этап 4:** параметр `?format=singbox` позволяет вернуть старое поведение
  точечно, без деплоя, если у конкретного клиента что-то не так.
- **Этап 6:** гасится без деплоя — `DEVICE_LIMIT_ENABLED=false` и перезапуск
  контейнера. Никаких следов в конфиге Xray он не оставляет.

### Точки расширения на будущее

Не входят в этот план, но архитектура их уже готова принять:

- **Clash.Meta YAML** — добавить `'clash'` в `TSubscriptionFormat`, маркеры
  `clash`/`stash`/`flclash` в `SINGBOX_CLIENT_MARKERS` и метод `buildClashConfig`.
  Откроет Clash Verge Rev, FlClash и Stash.
- **Deep-link-кнопки в боте** — `v2raytun://import/<url>` (формат подтверждён
  документацией), аналогичные схемы у Happ и Streisand. Импорт в одно касание
  вместо копирования ссылки.
- **XHTTP-транспорт** — третий канал, сейчас наиболее устойчив к DPI. Требует
  Xray v25.x с обеих сторон (после этапа 1 сервер готов), но поддержан не всеми
  клиентами — добавлять только как дополнительный outbound, не заменяя WS.

---

## Источники

- [Apple удалила более 20 VPN-приложений из российского App Store (Хакер, 30.03.2026)](https://xakep.ru/2026/03/30/app-store-vpn-gone/)
- [Happ — Proxy Utility Plus удалён из российского App Store (4PDA, 24.06.2026)](https://4pda.to/2026/06/24/458039/populyarnyj_vpn_klient_happ_proxy_utility_plus_udalyon_iz_rossijskogo_app_store/)
- [Xray-core: исходники команды `api adu`](https://github.com/XTLS/Xray-core/blob/main/main/commands/all/api/inbound_user_add.go)
- [Xray-core: исходники команды `api rmu`](https://github.com/XTLS/Xray-core/blob/main/main/commands/all/api/inbound_user_remove.go)
- [Xray API Interface — HandlerService и StatsService](https://xtls.github.io/en/config/api.html)
- [Xray-core релизы — актуальный v26.3.27](https://github.com/XTLS/Xray-core/releases)
- [Xray-core: исходники команды `api statsonlineiplist`](https://github.com/XTLS/Xray-core/blob/main/main/commands/all/api/stats_online_ip_list.go)
- [Local Policy — `statsUserOnline` и прочие поля levels](https://xtls.github.io/en/config/policy.html)
- [Запрос на встроенный лимит устройств в ядре (Discussion #3739, открыт)](https://github.com/XTLS/Xray-core/discussions/3739)
- [`limitIp` — фича панели 3x-ui, не ядра](https://github.com/MHSanaei/3x-ui/wiki/Configuration)
- [Изменение формата вывода `xray x25519` (Discussion #5159)](https://github.com/XTLS/Xray-core/discussions/5159)
- [Xray WebSocket transport — `heartbeatPeriod`](https://xtls.github.io/config/transports/websocket.html)
- [Cloudflare: таймаут WebSocket 100 секунд на планах Free/Pro](https://community.cloudflare.com/t/wss-closing-only-when-proxied-via-cloudflare/302359)
- [Amnezia Docs: поддерживаемые форматы конфигурации](https://docs.amnezia.org/documentation/supported-configuration-formats/)
- [v2RayTun: формат deep-link](https://docs.v2raytun.com/deep-link)
