// Готовый набор параметров Hiddify для наших серверов (TUN=Mixed, регион RU,
// поддельный DNS, отключённая строгая маршрутизация, Sticky session).
// Раздаётся клиентам через кнопку «⚙️ Готовые настройки Hiddify» в разделе
// «Инструкция» → «VLESS».
//
// ipv6-mode = prefer_ipv4, а не ipv4_only: у сервера есть исходящий IPv6, и
// глушить его на клиенте больше не нужно — ресурсы, доступные только по IPv6,
// иначе не открывались бы. IPv4 остаётся первым по приоритету: маршруты по
// нему предсказуемее. Возвращать ipv4_only нужно только вместе с XRAY_IPV6=false.
//
// tls-tricks.enable-fragment намеренно false: фрагментация ClientHello уже
// приводила к обрывам на наших каналах, включать её обратно нельзя.
export const HIDDIFY_OPTIONS_JSON = `{
  "region": "ru",
  "balancer-strategy": "sticky-sessions",
  "block-ads": false,
  "use-xray-core-when-possible": false,
  "execute-config-as-is": false,
  "log-level": "warn",
  "resolve-destination": false,
  "ipv6-mode": "prefer_ipv4",
  "remote-dns-address": "tcp://8.8.8.8",
  "remote-dns-domain-strategy": "prefer_ipv4",
  "direct-dns-address": "1.1.1.1",
  "direct-dns-domain-strategy": "",
  "mixed-port": 12334,
  "tproxy-port": 12335,
  "direct-port": 12337,
  "redirect-port": 12336,
  "tun-implementation": "mixed",
  "mtu": 9000,
  "strict-route": false,
  "connection-test-url": "http://captive.apple.com/hotspot-detect.html",
  "url-test-interval": 600,
  "enable-clash-api": true,
  "clash-api-port": 16756,
  "enable-tun": true,
  "set-system-proxy": false,
  "bypass-lan": true,
  "allow-connection-from-lan": false,
  "enable-fake-dns": true,
  "independent-dns-cache": true,
  "rules": [],
  "tls-tricks": {
    "enable-fragment": false,
    "fragment-size": "10-30",
    "fragment-sleep": "2-8",
    "mixed-sni-case": false,
    "enable-padding": false,
    "padding-size": "1-1500"
  },
  "warp": {
    "enable": false,
    "mode": "warp_over_proxy",
    "wireguard-config": "",
    "license-key": "",
    "account-id": "",
    "access-token": "",
    "clean-ip": "auto",
    "clean-port": 0,
    "noise": "1-3",
    "noise-size": "10-30",
    "noise-delay": "10-30",
    "noise-mode": "m4"
  },
  "warp2": {
    "enable": false,
    "mode": "warp_over_proxy",
    "wireguard-config": "",
    "license-key": "",
    "account-id": "",
    "access-token": "",
    "clean-ip": "auto",
    "clean-port": 0,
    "noise": "1-3",
    "noise-size": "10-30",
    "noise-delay": "10-30",
    "noise-mode": "m4"
  }
}`;
