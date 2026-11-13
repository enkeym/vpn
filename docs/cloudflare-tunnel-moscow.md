# Cloudflare Tunnel из Москвы: канал поднимается, данные не идут

Диагностика 2026-11-10/11. Ветка `dev` @ `349f28c` (подписка только с `CDN WS`).
Этот файл фиксирует уже выполненные проверки, чтобы не повторять их заново.

## Итог

Один и тот же туннель `ssh-tunnel` ломается одинаково для VPN и для SSH:
рукопожатие проходит, полезные данные не идут. Значит дефект не в Xray, не в
профилях подписки и не в Reality-каналах, а на участке «сеть клиента →
Cloudflare edge» при длинных соединениях.

Коротко:

| Проверка | Москва (AS42610) | Стокгольм (AS9009) |
| --- | --- | --- |
| Прямой IP сервера: 22/80/443/2222/8443/27443 | закрыт | некоторые порты открыты |
| `https://cdn.enkeym.site/<путь>` | отвечает за 0.1–0.4 с | отвечает |
| WS Upgrade (`Sec-WebSocket-Key` → `101`) | `101` приходит | `101` приходит |
| Данные после WS-хендшейка | 0–11 КБ, затем таймаут | 1 МБ за 1.5 с |
| Скачивание 1 МБ с `speed.cloudflare.com` напрямую | работает, 0.3 с | работает |
| SSH через тот же туннель | логин ок, 0 байт вывода | работает |

## Окружение проверок

- Клиент: машина пользователя, сеть `46.242.14.241`, AS42610 OJSC National
  Cable Networks, Москва, VPN выключен.
- Контрольная машина агента: `135.136.6.35`, AS9009 M247, Стокгольм — не
  годится для выводов о Москве, но годится для проверки самого сервера.
- Сервер: `82.148.236.233`, `/root/vpn`, контейнер `vpn-tgbot` (healthy).
- Путь WS: значение `XRAY_WS_PATH` из `/root/vpn/.env` (в документации не
  приводится, ниже обозначен как `<WS_PATH>`).

## Что проверено на сервере (всё в порядке)

Инбаунды Xray и клиенты:

```
reality-direct 8444, reality-grpc 27443, reality-xhttp 27444, vless-ws 8002
клиентов в каждом: 13
```

Слушатели: nginx 443/8443 (PROXY protocol → reality 8444), Xray 27443/27444,
`127.0.0.1:8002`, Hysteria2 UDP 8443, `hysteria stats 127.0.0.1:9999`,
AWG UDP 5667. `net.ipv4.ip_forward=1`, SNAT на `net0` в `82.148.236.233`,
исходящий запрос с сервера — 200.

Подписка (после `349f28c`) отдаёт ровно один канал во всех форматах:

```
base64  : 1 ссылка, vless cdn.enkeym.site 443 type=ws
xray    : ['CDN WS'], outbound proxy-ws, sockopt.domainStrategy=UseIPv4
singbox : outbounds [vless CDN WS · cdn.enkeym.site, selector select]
```

Сквозной клиент Xray по этой же ссылке **со Стокгольма**: `generate_204` → 204,
1 МБ (`speed.cloudflare.com/__down?bytes=1000000`) → `got=1000000` за 1.53 с,
выход с `82.148.236.233`. То есть сервер, `cloudflared` и Xray-инбаунд рабочие.

## Что проверено из Москвы (ломается)

Прямой IP закрыт полностью:

```
ping 82.148.236.233                      → 100% packet loss
tcp 22, 80, 443, 2222, 8443, 27443        → timeout
```

Путь через Cloudflare жив для коротких запросов:

```
curl -4 https://cdn.enkeym.site/<чужой_путь>        → 404 (ответ Xray)
curl -4 https://cdn.enkeym.site/<WS_PATH>            → 400 (дошло до Xray)
curl -4 … с Upgrade: websocket                       → 101 Switching Protocols
curl -4 https://speed.cloudflare.com/__down?bytes=1000000 → 200, 1 000 000 байт, 0.3 с
```

Данные через WS-канал не идут. Один и тот же клиент, одна и та же ссылка из
подписки, `sockopt.domainStrategy = UseIPv4`:

```
bytes=1000    → 200, got=1000
bytes=4000    → timeout 25 с, got=0
bytes=60000   → got=11508 и таймаут
bytes=200000  → got=7400 и таймаут
bytes=1MB     → got=8768 и таймаут
```

То есть обрыв стабильно на первых килобайтах ответа, дальше поток стоит.
С `UseIPv6` — `dial tcp [2606:4700:…]:443: connect: network is unreachable`
(IPv6 у пользователя не работает; поэтому в подписке уже принудительный IPv4).

Решающий контроль: **SSH через тот же туннель** (`ssh root`, ProxyCommand
`cloudflared access tcp --hostname ssh.enkeym.site`):

```
Authenticated to ssh.enkeym.site using "publickey"
debug1: channel 0: new session [client-session]
→ вывод пустой, rc=124 (позже rc=0 и тоже 0 байт)
```

SSH не имеет отношения к Xray, подписке и WS-профилям, но ведёт себя так же.
Кроме того, прямой `2222` из Москвы в тот момент был уже закрыт.

Наблюдение, требующее перепроверки: в одном из WS-ответов из этой сети
Cloudflare вернул `CF-RAY: …-ARN` (Стокгольм), а не московский edge. Похоже на
перехват/подмену маршрута к CDN, но замер не повторялся, поэтому это гипотеза,
а не факт.

## Проверки со стороны, не из Москвы

- `check-host.net/check-http` по `https://cdn.enkeym.site/<WS_PATH>` с 6 узлов
  (ca1, ch1, il1, il2, ir3, pt1): все вернули `400` за 0.15–0.54 с — путь
  доходит до Xray, «Bad Request» здесь ожидаем без Upgrade.
- `check-host.net/check-tcp` по `cdn.enkeym.site:443`: все узлы подключаются
  к edge Cloudflare.
- Порты Cloudflare 443/8443/2053/2096 на `cdn.enkeym.site` (со Стокгольма):
  все отвечают `400`, то есть альтернативные порты не меняют картину.

## Что уже исключено (не проверять повторно)

1. **Конфиги Xray и инбаунды** — все четыре живы, по 13 клиентов, ошибок в
   логах нет.
2. **Подписка и профили** — отдаётся один `CDN WS`; наличие пяти профилей
   или балансеров `lowest`/`balance` означает чужую/закэшированную подписку,
   а не нашу.
3. **IPv6 у клиента** — действительно сломан, в подписке уже `UseIPv4`;
   после этой правки картина не изменилась.
4. **Провайдер душит Cloudflare целиком** — нет: 1 МБ с
   `speed.cloudflare.com` напрямую скачивается за 0.3 с.
5. **MTU и маршрутизация сервера** — `net0` MTU 1500, 1 МБ через тот же
   туннель со Стокгольма проходит за 1.5 с.
6. **Смена IP сервера** — пользователь просил не делать: IP живёт ~4 дня,
   а ломается не адрес сервера, а канал клиента до edge.
7. **Смена протокола/транспорта VPN** (Reality TCP/gRPC/XHTTP, Hysteria2,
   AWG) — SSH через тот же туннель страдает идентично, поэтому транспорт
   VPN тут ни при чём.

## Что сделано на сервере в этот заход

Первая попытка лечения — перевести `cloudflared` на HTTP/2 (гипотеза UDP-душилки):

```
protocol: http2 в /etc/cloudflared/config.yml
```

Результат: туннель не поднялся, Cloudflare отдавал `530`. В precheck видно:

```
UDP  QUIC            → pass
TCP  HTTP/2 region1  → pass
TCP  HTTP/2 region2  → "blocked or unreachable"
Unable to establish connection … dial tcp [2606:4700:a8::7]:7844: i/o timeout
```

Причина падения — попытка идти к edge по IPv6 (`dial tcp [2606:…]`), при том
что IPv6 на сервере есть (`2a0b:4140:8399::2/48`, default route), но до edge
не доходит.

Откат и текущее состояние:

- `protocol: http2` из `/etc/cloudflared/config.yml` убран; бэкап исходного
  файла — `/etc/cloudflared/config.yml.bak-quic`.
- Добавлен drop-in `/etc/systemd/system/cloudflared.service.d/edge-ipv4.conf`:

```
[Service]
ExecStart=
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --edge-ip-version 4 --config /etc/cloudflared/config.yml tunnel run
```

- После перезапуска: 4 соединения QUIC к edge (`fra10`, `fra20`),
  `Registered tunnel connection`, туннель активен, WS-хендшейк `101`,
  1 МБ через WS со Стокгольма — 1.53 с.

Drop-in оставлен намеренно: без `--edge-ip-version 4` `cloudflared` пытается
идти по IPv6 и туннель не поднимается.

## Как воспроизвести проверку за минуту

С клиентской машины (без VPN):

```
curl -s https://ipinfo.io/json        # убедиться, что сеть не та, что у агента
curl -4 -o /dev/null -w '%{http_code}\n' https://cdn.enkeym.site/x
curl -4 -s -i --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG9Xb3JsZDEyMzQ1Ng==' \
  "https://cdn.enkeym.site<WS_PATH>" | head -2      # ожидается 101
ssh root 'echo OK'                                   # 0 байт = тот же симптом
```

Локально, через скачанный конфиг клиента по ссылке из подписки:

```
docker run -d --name ws-probe --network host \
  -v /path/to/ws-client.json:/etc/xray/config.json \
  ghcr.io/xtls/xray-core:latest run -c /etc/xray/config.json
curl -x socks5h://127.0.0.1:18090 -o /dev/null \
  -w '%{http_code} %{size_download}\n' --max-time 40 \
  'https://speed.cloudflare.com/__down?bytes=1000000'
```

Если `size_download` меньше 1 000 000 и команда висит — воспроизведён тот же
дефект, новых выводов это не даст.

## Не делать

- Не печатать `.env`, ключи Reality, UUID пиров, `<WS_PATH>`, пароли.
- Не менять IP сервера и не пересоздавать туннель.
- Не гонять повторно `check-host`, `ss`, `statsquery` и замеры размеров —
  их результаты зафиксированы выше.
