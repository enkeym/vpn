<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Два способа подключения

Один конфиг (запись в `peers`) выдаётся сразу двумя способами:

| | AmneziaWG 3 | VLESS (Xray) |
|---|---|---|
| Что выдаётся | файл `.conf` и QR | ссылка-подписка, `vless://`-ссылки, QR |
| Клиент | AmneziaVPN | Hiddify, NekoBox, v2rayNG, Streisand, sing-box |
| Сервис | `AwgService` (`src/wg`) | `XrayService` (`src/xray`) |
| Ключ пира | `publicKey`/`privateKey` | `vlessUuid` |

Они не заменяют, а дополняют друг друга: протоколы блокируются по-разному, и
клиент подключается тем, что живо на его сети. Состав активных пиров
синхронизируется в оба сервиса из `PeersService` — пауза, истечение срока,
удаление и замена конфига отключают сразу оба канала.

## Развёртывание на сервере

Контейнер работает в `network_mode: host`, поэтому всё, что обычно делает за нас
docker — sysctl, проброс портов, фаервол — здесь выставляется на хосте вручную.
Порядок для чистой машины; на уже работающей начинайте с шага 4.

### 1. Требования

Ubuntu 22.04/24.04, доступ root, `docker` с plugin `compose`, устройство
`/dev/net/tun` (есть в любом обычном VPS, нужно для amneziawg-go).

### 2. sysctl на хосте

Без форвардинга туннель поднимется, но трафик клиентов никуда не пойдёт.
IPv6-строки нужны для `AWG_ADDRESS6` — без них дуалстек-сайты висят до таймаута.

```bash
sudo tee /etc/sysctl.d/99-vpn.conf >/dev/null <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
net.ipv6.conf.all.disable_ipv6=0
net.ipv6.conf.default.disable_ipv6=0
EOF
sudo sysctl --system
```

### 3. Фаервол и проброс порта AmneziaWG

```bash
sudo ufw allow 22/tcp      # не заблокируйте себе SSH
sudo ufw allow 443/tcp     # nginx: Reality + CDN-канал
sudo ufw allow 4500/udp    # публичный порт AmneziaWG
sudo ufw enable
```

`awg0` слушает `AWG_PORT` (51821), а клиентам в `Endpoint` уходит
`AWG_PUBLIC_PORT` (4500) — мобильные операторы режут нестандартные UDP-порты, а
4500 (IPsec NAT-T) пропускают везде. В host-режиме docker этот проброс не
делает, проброс `AWG_PUBLIC_PORT → AWG_PORT` (DNAT только на порт) контейнер ставит сам при
подъёме `awg0` (PostUp, только на внешнем интерфейсе, с проверкой `-C`; его
можно задать через `AWG_WAN_IFACE`). Руками ничего делать не нужно.

Именно DNAT на порт, а не REDIRECT: REDIRECT подменяет адрес назначения
первым адресом интерфейса, и с дополнительным IP (`PUBLIC_IPV4`) ответ
AmneziaWG уходил с `AWG_PORT` вместо публичного порта — клиент его отбрасывал,
хендшейка не было. Оставшиеся от прежних редакций REDIRECT снимает сам PostUp.

Правило обязательно привязано к внешнему интерфейсу (`-i`): без него проброс
цепляет и трафик клиентов из туннеля (напр. QUIC на udp/443) и заворачивает его в
сам AmneziaWG. Ручной REDIRECT по старой инструкции (без `-i`) PostUp тоже
снимает, но если он сохранён в `iptables-persistent`, уберите его и оттуда.

Меняете `AWG_PUBLIC_PORT` на работающем сервере — перечислите прежние порты в
`AWG_LEGACY_PUBLIC_PORTS` (например `4500`) и откройте их в `ufw`. Уже скачанные
клиентами файлы остаются со старым `Endpoint`: перевыпуска при смене порта нет, и
без проброса для старого порта отвалятся все, кому конфиг выдали раньше. Правило
от прошлой редакции `PostUp` само по себе не спасёт — `PostDown` нового набора
его не знает, поэтому оно висит на хосте сиротой и исчезает вместе с таблицей
`nat` при перезагрузке.

### 4. Сертификат Cloudflare

Нужен только для CDN-канала (`XRAY_DOMAIN`). Файлы из Cloudflare → SSL/TLS →
Origin Server кладутся в смонтированный том `./configs`:

```bash
sudo install -m 600 origin.pem ./configs/cloudflare-cert.pem
sudo install -m 600 origin.key ./configs/cloudflare-key.pem
```

Без них контейнер не стартует — это осознанно: молча отдавать клиентам 5xx хуже,
чем упасть на старте с понятной ошибкой.

### 5. `.env`

```bash
cp .env.example .env
```

Минимум, без которого не поедет: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_IDS`,
`WG_HOST` (IP сервера). Для второго канала — `XRAY_DOMAIN`. Для оплаты —
`YOOKASSA_*`.

### 6. Сборка и запуск

```bash
docker compose -p vpn-bot build
docker compose -p vpn-bot up -d
```

Миграции БД применяются сами при старте, отдельной команды не нужно.

### 7. Проверка

```bash
docker compose -p vpn-bot logs --tail=80 vpn-bot
sudo ss -tulnp | grep -E ':(443|4500|8443|51821|3000)'
```

В логах должны быть три строки: интерфейс `awg0` поднят, `xray запущен (pid=…)`
с упоминанием `reality-direct на localhost:8444 (за nginx:443, SNI-роутинг)` и
`Xray синхронизирован: N клиент(ов)`. В `ss` — `nginx` на 443, `amneziawg-go` на
51821, `node` на 3000; портов 8444/8445/8880/8881 наружу быть не должно (только
`127.0.0.1`).

Снаружи — проверки из раздела «Настройка CDN-канала».

### Обновление

```bash
git pull
docker compose -p vpn-bot up -d --build
```

Параметры обфускации и ключи Reality лежат в `./configs` и переживают
пересборку — выданные клиентам конфиги продолжают работать.

### Бэкап и переезд

```bash
make backup [OUT=каталог]            # контейнер запущен
make down
make restore FILE=vpn-backup-….tgz [FORCE=1]
make up
```

`make backup` кладёт в `vpn-backup-<дата>.tgz` согласованную копию SQLite
(`db.backup()`, с учётом WAL), `configs/` и `.env`. Архив содержит секреты
(токен бота, ключи Reality/AWG) — храните вне сервера и не коммитьте.

На новом сервере: `git clone`, `make restore FILE=…`, `make up`
(`sudo make bootstrap` перед `make up` — sysctl, порты фаервола, проверка `cpus`;
шаги 2–3 выше он выполняет сам, если ufw или firewalld уже включены).
`FORCE=1` перезаписывает `.env`, `data/vpn.db` и файлы из архива, но не
удаляет лишние файлы в `configs/`, которых в архиве нет.

## Протокол: AmneziaWG 3

Основной туннель сервиса — AmneziaWG 3 на интерфейсе `awg0`. Классический
WireGuard (`wg0`) удалён: интерфейс с включённой обфускацией всё равно
несовместим с обычными WireGuard-клиентами, а держать второй WireGuard-туннель
ради протокола, который блокируется, смысла нет.

| | AmneziaWG 3 |
|---|---|
| Интерфейс | `awg0` |
| Порт | `AWG_PORT` (51821) |
| Подсеть | `AWG_ADDRESS` (10.9.0.0/16) |
| Конфиг сервера | `configs/awg0.conf` |
| MTU клиента и `awg0` | `AWG_MTU` (1200), при включённом IPv6 — не ниже 1280 |
| AllowedIPs | `AWG_ALLOWED_IPS` (`0.0.0.0/0, ::/0`) |
| Клиент | **AmneziaVPN ≥ 5.0.0.5 или AmneziaWG ≥ 3.0.1** |

`AllowedIPs` держим ровно как `0.0.0.0/0, ::/0`: AmneziaVPN сравнивает строку
буквально и без неё блокирует раздельное туннелирование. При доступном IPv6 и
непустом `AWG_ADDRESS6` клиент получает IPv6-адрес и MTU не ниже 1280, даже если
`AWG_MTU=1200`. Для MTU 1200 задайте пустой `AWG_ADDRESS6`: IPv6 внутри туннеля
выключится, а маршрут `::/0` сохранится для блокировки IPv6 вне VPN.
После обновления скачайте конфиг из бота и импортируйте его в Amnezia заново.

`Endpoint` в выданном конфиге всегда собирается из текущих `WG_HOST`/`AWG_PORT`,
а не из поля `peers.endpoint` — оно хранит лишь адрес на момент создания пира.
Поэтому смена порта не требует перевыпуска конфигов: клиенту достаточно скачать
свой заново.

Ключи (`genkey`/`pubkey`/`genpsk`) считает тот же бинарь `awg`, поэтому
отдельный `wireguard-tools` в образе не нужен.

### Как это работает на сервере

`awg0` поднимается на userspace-реализации **amneziawg-go** через `/dev/net/tun`
— модуль ядра на хосте не нужен. `amneziawg-go`, `awg` и `awg-quick` собираются
в отдельном stage Dockerfile. Если их нет в образе, приложение стартует штатно,
но `awg0` не поднимается и бот не может выдавать конфиги (в логах — ошибка).

```bash
docker compose build   # собрать образ с AmneziaWG
docker compose up -d
docker compose logs | grep -i amneziawg
```

Ревизии закреплены в `Dockerfile` (ветки Amnezia переписываются force-push'ем).
`amneziawg-tools` берётся из ветки `feat/awg3`: только она разбирает `S3/S4`,
`HeaderProtectionKey`, `ContentPaddingAddition` и тайминги — в `master` их ещё нет.
Переопределяются при сборке:

```bash
docker compose build --build-arg AWG_GO_REF=<sha> --build-arg AWG_TOOLS_REF=<sha>
```

### Параметры обфускации

`Jc/Jmin/Jmax`, `S1..S4`, `H1..H4` должны совпадать на сервере и у клиента.
При первом запуске они генерируются случайно и сохраняются в `configs/awg0.conf`
(одинаковые у всех значения сами по себе являются сигнатурой для DPI).
Переопределяются через `.env` — либо все одиннадцать, либо ни одного.

В AWG 3 `H1..H4` — диапазоны (`100000-200000`), а не одно число: тип пакета
выбирается из них заново на каждый пакет.

### Параметры AmneziaWG 3

| Переменная | Сторона | Назначение |
|---|---|---|
| `AWG_HEADER_PROTECTION` | — | `false` отключает шифрование заголовков (для старых клиентов) |
| `AWG_HEADER_PROTECTION_KEY` | server-side | ключ шифра заголовков, генерируется сам |
| `AWG_CONTENT_PADDING` | client-side | случайная набивка данных, диапазон |
| `AWG_PERSISTENT_KEEPALIVE` | client-side | число или диапазон (`22-30`) |
| `AWG_REKEY_*`, `AWG_REJECT_AFTER_TIME`, `AWG_KEEPALIVE_TIMEOUT`, `AWG_MAX_HANDSHAKE_ATTEMPTS` | client-side | тайминги протокола |
| `AWG_I1..AWG_I5` | client-side | пакеты-имитации DNS/QUIC/SIP перед хендшейком; без `I1` мобильные операторы режут хендшейк. Применяются и к существующему `awg0.conf`: недостающие дописываются, отличающиеся заменяются (`.env` здесь главнее файла — у выданных конфигов хендшейк от этого не ломается) |

Header protection использует `S1..S4` как nonce, поэтому все четыре обязаны быть ≥ 8.

> ⚠️ **AmneziaVPN теряет `HeaderProtectionKey` при импорте `.conf`-файла**:
> `importController` переносит из нативного конфига только
> `Jc/Jmin/Jmax/S1..S4/H1..H4/I1..I5`, поэтому клиент шлёт хендшейк без
> шифрования заголовков, сервер отбрасывает его пакеты и подключение висит.
> Держите `AWG_HEADER_PROTECTION=false`, пока конфиги раздаются файлами.
> Надпись «(version 2)» при импорте — норма: в клиенте протокол AWG 3
> маркируется как «AmneziaWG 2.0», версия определяется по наличию `S3`/`S4`.
`AWG_J1..AWG_J3` и `AWG_ITIME` из версии 1.5 удалены — `amneziawg-tools` их больше
не разбирает, их роль перешла к тегам внутри `I1..I5`.

### Обновление старого `awg0.conf`

Поддерживается только формат AWG 3 — конфиги версии 2 не собираются и не
раздаются. Конфиг, созданный до AWG 3, при старте дозаполняется на месте:
добавляются `S3/S4`, заголовки переводятся в диапазоны, генерируется
`HeaderProtectionKey`. Приватный ключ сервера и список пиров сохраняются,
пересоздавать пиров не нужно.

Дозаполнение выполняется только при `AWG_ALLOW_CONFIG_UPGRADE=true`: по
умолчанию приложение пишет в лог, чего в файле не хватает, и поднимает `awg0`
как есть — иначе обновление образа молча отключало бы всех клиентов.

> ⚠️ Старые выданные клиентские файлы после этого не подключатся: параметры
> обфускации больше не совпадают. Клиентам нужно заново скачать конфиг из бота
> (конфиг строится на лету, перевыпускать пира не требуется).

> ⚠️ Смена параметров в `.env` после создания `configs/awg0.conf` ни на что не
> влияет — файл читается как источник истины. Чтобы применить новые, удалите
> `configs/awg0.conf` (все выданные awg-конфиги придётся перевыпустить).

## Второй канал: VLESS (Xray)

`XrayService` держит процесс `xray` рядом с `awg0` и даёт до двух независимых
путей обхода:

1. **Reality** — прямой TCP на IP сервера, без CDN. Работает там, где режут
   Cloudflare, но не защищён от блокировки по IP.
2. **VLESS+WS+TLS за Cloudflare CDN** — клиент не видит реальный IP сервера,
   но канал зависит от доступности самого Cloudflare. Опционален: поднимается,
   только если задан `XRAY_DOMAIN`.

Оба канала уезжают клиенту в одной ссылке-подписке (`/sub/:vlessUuid`), и
клиент на движке sing-box (Hiddify, NekoBox) сам держит активным рабочий.
Формат ответа выбирается по User-Agent: sing-box-клиентам — JSON, остальным —
base64 со ссылками (`src/subscription`).

### Порты и SNI-разводчик

Контейнер работает в `network_mode: host`, а оба канала должны жить на одном
стандартном 443. Поэтому публичный порт слушает **nginx** внутри образа: он
читает SNI из ClientHello (`stream` + `ssl_preread`, без расшифровки) и решает,
куда отдать соединение.

```
                     :443  nginx (stream, ssl_preread)
                             │
       SNI = XRAY_DOMAIN ────┤──── всё остальное (SNI маски, зонды, мусор)
                             │                  │
              127.0.0.1:8445 │                  │ 127.0.0.1:8444
         nginx TLS (Origin CA)                  Xray reality-direct
                 │                                     │
        /sub/ → NestJS:3000                    чужой ⇒ проксируется
        /     → NestJS:3000                    на realitySettings.dest
        иначе → Xray ws-cdn:8880
```

Разводчик поднимается **только при заданном `XRAY_DOMAIN`** — без домена
разводить нечего, и тогда Reality слушает публичный порт сам, а nginx не
запускается вовсе (см. `docker/docker-entrypoint.sh` и `XrayService.behindProxy`).
Эти два условия обязаны совпадать: если Xray ждёт PROXY protocol, а nginx его не
шлёт (или наоборот), хендшейк не состоится вообще.

| Порт | Кто слушает | Наружу |
|---|---|---|
| `XRAY_REALITY_PORT` (443/tcp) | nginx (или Xray, если домена нет) | да, открыть в фаерволе |
| `NGINX_INTERNAL_TLS_PORT` (8445) | nginx, `127.0.0.1` | нет |
| `XRAY_INTERNAL_REALITY_PORT` (8444) | Xray, `127.0.0.1` | нет |
| `XRAY_INTERNAL_WS_PORT` (8880) | Xray, `127.0.0.1` | нет |
| `XRAY_STATS_API_PORT` (8881) | Xray, `127.0.0.1` | нет |
| `PORT` (3000) | NestJS | нет, наружу торчит только `/sub/` и `/` |

**443/tcp закреплён за этим узлом.** Нестандартный порт для DPI — отдельный
маркер, такой трафик режут в первую очередь, и сам Xray предупреждает об этом
при старте.

```bash
sudo ufw allow 443/tcp    # XRAY_REALITY_PORT — nginx (Reality + CDN)
```

`/peers` и `/metrics/` наружу намеренно не проксируются: они закрыты ключами, но
публиковать внутреннее API через CDN незачем — с хоста оно и так доступно на
`localhost:3000`.

### Настройка CDN-канала (Cloudflare)

Нужно один раз, и только если хотите второй канал плюс ссылку-подписку.

1. Домен делегирован на Cloudflare (NS меняются у регистратора).
2. DNS-запись: `A` на IP сервера, **Proxied** (оранжевое облако). Серое облако
   бессмысленно — тогда клиент видит ваш IP и обхода блокировки по IP нет.
   AAAA не нужна: Cloudflare сам отдаёт клиентам IPv6, а до origin ходит по IPv4.
3. **SSL/TLS → Full (strict)**. При Flexible Cloudflare пойдёт на origin по HTTP,
   и TLS-сервер разводчика его не примет.
4. **SSL/TLS → Origin Server → Create Certificate**, файлы положить в
   `configs/cloudflare-cert.pem` и `configs/cloudflare-key.pem` (том `./configs`
   уже смонтирован). Без них контейнер не стартует — это лучше, чем молча
   отдавать клиентам 5xx.
5. **Network → WebSockets: On.** Без этого VLESS+WS не работает вообще.
6. **Security → Bots → Bot Fight Mode: Off** — режет нестандартный трафик.
7. В `.env`: `XRAY_DOMAIN=<домен>`, `XRAY_PORT` равен `XRAY_REALITY_PORT`.
8. Чтобы запись следовала за `PUBLIC_IPV4` после бана IP: `CF_API_TOKEN`,
   `CF_ZONE_ID`, `CF_DNS_RECORDS=<домен>` и `CF_DNS_PROXIED=true`. Флаг один на
   все имена списка, а `WG_HOST` и Reality-SNI за оранжевым облаком не работают,
   поэтому `true` — только когда в списке одно CDN-имя; их A-записи тогда
   правятся руками.

Проверка после деплоя:

```bash
# Разводчик отвечает на домене (не 5xx от Cloudflare)
curl -sI https://<домен> -o /dev/null -w '%{http_code}\n'

# Reality на том же порту принимает чужой SNI и притворяется сайтом-маской
echo | openssl s_client -connect <IP>:443 -servername "$XRAY_REALITY_SNI" 2>/dev/null \
  | openssl x509 -noout -subject
```

Первый запрос должен дать код приложения (не 502/525), второй — сертификат
маскировочного сайта, а не ваш.

### Self-steal для Reality

Если на мобильном Reality не подключается (ТСПУ режет SNI чужого сайта на IP
хостера), сайтом-маской делается свой поддомен. Нужен заданный `XRAY_DOMAIN`.

1. DNS: `A` поддомена (например `r.<домен>`) на IP сервера, **DNS only** (серое
   облако) — сертификат должен отдавать наш IP, а не Cloudflare.
2. Сертификат Let's Encrypt через DNS-01 (порта 80 в схеме нет), файлы — в
   `configs/steal-cert.pem` и `configs/steal-key.pem`. После продления:
   `docker exec vpn-tgbot nginx -s reload`.
3. В `.env`: `XRAY_INTERNAL_STEAL_PORT=8446`,
   `XRAY_REALITY_DEST=127.0.0.1:8446`, `XRAY_REALITY_SNI=r.<домен>`, прежний SNI —
   в `XRAY_REALITY_EXTRA_SNI`, чтобы выданные `vless://` не умерли. `make rebuild`.

Проверка: `curl -sI --resolve r.<домен>:443:<IP> https://r.<домен>/` — ответ с
сертификатом Let's Encrypt без `-k`. Подписка подхватит новый SNI при обновлении.

Без `XRAY_DOMAIN` ничего этого не нужно: остаётся один Reality-канал, nginx не
запускается, а бот выдаёт прямую `vless://`-ссылку вместо подписки.

### IPv6

`XRAY_IPV6=true` (по умолчанию) включает дуалстек сразу в трёх местах:

- конфиг сервера — `dns.queryStrategy: UseIP` и `domainStrategy: UseIP` на
  freedom-outbound'е (раньше оба были `UseIPv4`), Reality биндится на `::`;
- подписка sing-box — `domain_strategy: prefer_ipv4` вместо `ipv4_only`, снят
  блок `::/0` в `route.rules`, в TUN добавлен ULA-адрес IPv6;
- готовые настройки Hiddify — `ipv6-mode: prefer_ipv4`.

Заблокированными остаются только служебные диапазоны (`::1/128`, `fc00::/7`,
`fe80::/10`) — это защита от доступа во внутреннюю сеть хоста, а не часть
поддержки IPv6. Блок QUIC (UDP 443) не менялся — он лечит зависание YouTube и
поиска.

Если у VPS пропал исходящий IPv6 — `XRAY_IPV6=false`, иначе дуалстек-домены
будут виснуть на таймауте Happy Eyeballs. IPv6 в туннеле AmneziaWG настраивается
отдельно — `AWG_ADDRESS6`.

Перед включением стоит проверить на хосте два факта:

```bash
# 1. Исходящий IPv6 реально работает
curl -6 -s https://ifconfig.co

# 2. bindv6only=0 — иначе сокет Reality на '::' перестанет принимать IPv4,
#    и отвалятся ВСЕ клиенты без IPv6. Значение по умолчанию в Linux — 0.
sysctl net.ipv6.bindv6only
```

Если `bindv6only=1`, либо верните `0` (`sysctl -w net.ipv6.bindv6only=0` плюс
запись в `/etc/sysctl.d/`), либо поставьте `XRAY_IPV6=false` — тогда Reality
слушает `0.0.0.0`, как раньше.

### Состояние и файлы

| Файл | Что внутри |
|---|---|
| `configs/xray.json` | рабочий конфиг, пересобирается при каждой синхронизации |
| `configs/xray-reality.json` | ключи x25519 и shortId — переживают рестарт |
| `configs/xray-ws.json` | случайный путь WS-эндпоинта |

> ⚠️ Удаление `configs/xray-reality.json` или `configs/xray-ws.json` отключит
> всех, кому уже выданы VLESS-ссылки: ключи и путь сгенерируются заново.
> Клиентам с подпиской достаточно обновить её, остальным — взять ссылку в боте
> заново.

Добавление и удаление клиентов идёт через `xray api adu/rmu` — без перезапуска
процесса, чтобы не рвать соединения остальным. Если API не ответил — процесс
перезапускается (фолбэк).

Бинарник `xray` ставится отдельным stage в `Dockerfile` (версия закреплена в
`ARG XRAY_VERSION`). Если его в образе нет, приложение стартует штатно и
AmneziaWG работает как раньше — `XrayService` пишет об этом в лог и остаётся
выключенным.

### Как это выглядит в боте

В карточке конфига рядом с «📷 QR — AmneziaVPN» и «📄 Файл .conf» появляется
«🌐 VLESS / подписка» (только когда Xray поднят). Она шлёт отдельное сообщение
с подпиской, ссылками и кнопками: QR-код, QR для официального sing-box и
готовый `.json` для импорта локальным профилем.

Раздел «Инструкция» теперь двухуровневый: сначала способ подключения
(AmneziaVPN / VLESS), потом платформа. Сводить их в один текст нельзя —
сообщение не влезло бы в лимит Telegram.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
