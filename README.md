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

## Протокол: AmneziaWG 3

Единственный туннель сервиса — AmneziaWG 3 на интерфейсе `awg0`. Классический
WireGuard (`wg0`) удалён: интерфейс с включённой обфускацией всё равно
несовместим с обычными WireGuard-клиентами, а держать второй туннель ради
протокола, который блокируется, смысла нет.

| | AmneziaWG 3 |
|---|---|
| Интерфейс | `awg0` |
| Порт | `AWG_PORT` (51821) |
| Подсеть | `AWG_ADDRESS` (10.9.0.0/16) |
| Конфиг сервера | `configs/awg0.conf` |
| MTU клиента | `AWG_MTU` (1420) |
| AllowedIPs | `AWG_ALLOWED_IPS` (`0.0.0.0/0, ::/0`) |
| Клиент | **AmneziaVPN ≥ 5.0.0.5 или AmneziaWG ≥ 3.0.1** |

`AllowedIPs` держим ровно как `0.0.0.0/0, ::/0`: AmneziaVPN сравнивает строку
буквально и без неё блокирует раздельное туннелирование. Туннель при этом чисто
IPv4 (NAT только через `iptables`, IPv6-адрес клиенту не выдаётся).

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
| `AWG_I1..AWG_I5` | client-side | пакеты-имитации DNS/QUIC/SIP перед хендшейком |

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
