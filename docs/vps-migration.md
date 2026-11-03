# Перенос VPS и диагностика недоступности

Отсутствие подключения и подключение без интернета требуют разных проверок.
Две неудачные TCP-пробы из Москвы не устанавливают причину: возможны остановка
listener, firewall, ошибка маршрутизации или фильтрация. Check-host проверяет TCP,
но не рукопожатие Reality и не передачу данных внутри VPN.

## Что даёт Cloudflare

Обычный прокси Cloudflare обслуживает HTTP(S), включая WebSocket. Он не переносит
AmneziaWG UDP или прямой Reality TCP: для них нужны DNS only либо IP в клиенте.
См. [ограничения проксирования](https://developers.cloudflare.com/dns/proxy-status/limitations/)
и [поддержку WebSocket](https://developers.cloudflare.com/network/websockets/).

Проксируемый CDN-домен и прямой VPN-домен на одном VPS не скрывают общий IP:
его раскрывает DNS only запись. Для разделения нужен отдельный адрес/сервер
входа; смена IP выхода не меняет доступность входа. Дополнительный вход и маршрут
к серверу выхода нужно проверять отдельно. См. [раскрытие origin](https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/exposed-ip-address/).

Cloudflare сообщала об ограничениях доступа из российских сетей с июня 2025 года,
включая обрывы после первых 16 КБ. Поэтому WS через CDN нельзя считать гарантированным
резервом прямого VPN. Это описание известных ограничений, а не диагноз текущего сбоя.
[Отчёт Cloudflare](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/).

В этой конфигурации CDN-SNI допускается к Origin CA только с IPv4-сетей Cloudflare
из `docker/cloudflare-ipv4.conf`; остальные подключения поступают в Reality.
Это ограничение источника, а не аутентификация конкретной зоны Cloudflare.
Список сверяется с [официальным](https://www.cloudflare.com/ips-v4), после изменения
нужна пересборка образа. IPv6-listener для origin отсутствует; AAAA origin не добавлять
без отдельной настройки IPv6. IPv6 для посетителей на стороне CDN этому не мешает.

## Подготовка и перенос

1. На старом сервере выполнить `make backup`, сохранить архив вне VPS. Он содержит
   секреты. Не удалять `configs/awg0.conf`, `xray-reality.json`, `xray-ws.json`:
   без них изменятся ключи, обфускация или WS-путь уже выданных клиентов.
2. На новом VPS клонировать ту же ветку и выполнить `make restore FILE=…`.
   Проверить `.env`: новый `PUBLIC_IPV4` должен быть назначен провайдером этому VPS;
   `AWG_WAN_IFACE` должен соответствовать его внешнему интерфейсу. Старый IP нельзя
   просто навесить на произвольный VPS. Проверить лимит CPU в compose.
3. Задать `CF_DNS_RECORDS` только для переносимых A-записей. `XRAY_DOMAIN` будет
   Proxied; `WG_HOST` и собственный Reality SNI — DNS only. Имена
   разных ролей должны отличаться. Для остальных существующих записей режим
   сохраняется; новые записи без роли создаются как DNS only.
4. До старта проверить сертификат и ключ в `configs/cloudflare-cert.pem` и
   `configs/cloudflare-key.pem`, их соответствие `XRAY_DOMAIN`. Для self-steal
   также перенести действующие `steal-cert.pem`/`steal-key.pem` и продление DNS-01.
5. В Cloudflare оставить Full (strict), включённый WebSockets, DNS-роли как выше.
   Не включать интерактивные challenge для подписок и WS. Добавить Cache Rule
   Bypass cache для CDN-hostname и пути, начинающегося с `/sub/`. Origin CA не заменяет
   публичный сертификат self-steal. См. [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).
6. Выполнить `sudo make bootstrap`, проверить firewall провайдера: TCP-порт Reality
   (обычно 443), UDP `AWG_PORT`, административный SSH. Нельзя разрешать весь TCP 443
   только Cloudflare: прямой Reality использует этот же порт.
7. Выполнить `make up`. Старт автоматически применяет PUBLIC_IPV4/SNAT и обновляет
   перечисленные DNS-записи. Поэтому это момент переключения трафика; два экземпляра
   бота с одним Telegram-токеном одновременно не запускать.
8. Проверить стартовый отчёт, подписку и оба протокола с мобильной и фиксированной
   сети, отдельно подключение и передачу данных. При отказе остановить новый
   экземпляр и вернуть DNS/старый экземпляр согласованно. Старый VPS сохранять
   до проверки и истечения DNS-кэшей клиентов.

NestJS по умолчанию слушает `HTTP_HOST=127.0.0.1`, `PORT=3000`. Встроенный nginx
и healthcheck используют loopback. Внешний reverse proxy для вебхука оплаты должен
достигать этого адреса с того же хоста; иной `HTTP_HOST` требует закрыть прямой
доступ к порту приложения firewall. Не публиковать весь внутренний API через CDN.

## Автоматическое продление сертификатов

Сертификат self-steal продлевает `certbot.timer` через DNS-01 Cloudflare.
API-токен хранится только на VPS в `/root/.secrets/certbot/cloudflare.ini`
с правами 600; параметры DNS-плагина сохранены в конфигурации renewal certbot.

После успешного продления `/etc/letsencrypt/renewal-hooks/deploy/vpn-nginx.sh`
копирует `fullchain.pem` и `privkey.pem` в `configs/steal-cert.pem` и
`configs/steal-key.pem` с правами 600. Если контейнер работает, скрипт выполняет
`nginx -t` и `nginx -s reload` внутри него. Остановка VPN не требуется.

Проверка расписания и пробное продление с выполнением hook:

```sh
systemctl status certbot.timer
certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

Dry run использует тестовый сервер Let's Encrypt. Его недоступность не проверяет
работоспособность боевого продления; детали ошибки находятся в
`/var/log/letsencrypt/letsencrypt.log`. Cloudflare Origin CA — отдельная пара
`cloudflare-cert.pem`/`cloudflare-key.pem`, certbot её не продлевает.

## Автодеплой GitHub Actions

После успешного job `check` push в `dev` запускает SSH-команду `vpn-new`.
Ключ пользователя `deploy` ограничен `restrict` и forced command
`/usr/local/bin/deploy-dispatch`; sudo разрешает только этот root-скрипт без
аргументов. Другие SSH-команды отклоняются. У `deploy` нет доступа к Docker
или ключам VPN.

Установленная копия скрипта обновляется отдельно от репозитория:

```sh
install -o root -g root -m 755 scripts/deploy-dispatch.sh /usr/local/bin/deploy-dispatch
```

Root-конфигурация `/etc/vpn-new/deploy.conf` с правами 600 задаёт
`DEPLOY_PROJECT_DIR`, `DEPLOY_BRANCH`, `DEPLOY_CONTAINER` и
`DEPLOY_HEALTH_TIMEOUT_SECONDS`. Диспетчер блокирует параллельный запуск,
проверяет чистоту рабочего дерева, обновляет ветку только fast-forward,
собирает образ и ждёт healthy после запуска. Расхождение истории или ручные
изменения останавливают деплой.

Секреты репозитория: `DEPLOY_HOST` (адрес:порт), `DEPLOY_SSH_KEY` и
`DEPLOY_KNOWN_HOSTS`. При переносе VPS обновлять все три; приватный ключ и
значения секретов в Git не сохранять.

## Если соединение не устанавливается

На VPS проверить `make logs`, `ss -lntup`, `ip -4 addr`, `ip -4 route`,
`docker compose -p vpn-bot ps` и firewall провайдера. Проверить, что DNS only
домен указывает на новый IP, а CDN-домен возвращает адреса Cloudflare.
Сравнить TCP-доступность из российской и зарубежной сети. Успешный TCP-тест
ещё не подтверждает Reality; проверять выданным клиентским профилем.
Не выключать глобально firewall и не публиковать конфиги, UUID или ключи в логах.

## Если подключается, но интернета нет

Проверить `sysctl net.ipv4.ip_forward`, `ip -4 route`,
`sudo iptables -t nat -S POSTROUTING`, `sudo iptables -S FORWARD` и свежий
handshake/счётчики `docker compose -p vpn-bot exec vpn-bot awg show awg0`.
SNAT должен использовать действительно назначенный адрес; неверный PUBLIC_IPV4
может сломать исходящий трафик. Для Xray проверить ошибки исходящих подключений.

Из клиента проверить отдельно запрос к IP и DNS-запрос к настроенному resolver.
Если не проходит только DNS — проверять resolver и его достижимость. Если мелкие
запросы проходят, а HTTPS зависает — проверять MTU/MSS по разделу AWG в README.
Проверка TCP 443 снаружи не проверяет ни эти маршруты, ни NAT, ни DNS клиента.
