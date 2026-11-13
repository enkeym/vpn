#!/usr/bin/env bash
# make bootstrap — подготовка чистого хоста: sysctl, фаервол, проверка cpus.
# Идемпотентно, запускать от root (или через sudo). Контейнер в network_mode: host
# не может менять sysctl и фаервол хоста — поэтому это делается здесь, один раз.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${NAME:-vpn-bot}"
SYSCTL_FILE="/etc/sysctl.d/99-vpn.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "нужен root: sudo make bootstrap" >&2
  exit 1
fi

warn() { echo "⚠ $*" >&2; }

# --- docker и compose ---
command -v docker >/dev/null 2>&1 || { echo "docker не установлен" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "нет плагина docker compose" >&2; exit 1; }
AWG_PORT="$(docker compose -p "$NAME" config --environment | awk -F= '$1 == "AWG_PORT" { print $2 }')"
AWG_PORT="${AWG_PORT:-51821}"
if [[ ! "$AWG_PORT" =~ ^[0-9]{1,5}$ ]] || ((10#$AWG_PORT < 1 || 10#$AWG_PORT > 65535)); then
  echo "AWG_PORT должен быть UDP-портом от 1 до 65535" >&2
  exit 1
fi
HY2_PORT="$(docker compose -p "$NAME" config --environment | awk -F= '$1 == "HY2_PORT" { print $2 }')"
HY2_PORT="${HY2_PORT:-443}"
if [[ ! "$HY2_PORT" =~ ^[0-9]{1,5}$ ]] || ((10#$HY2_PORT < 1 || 10#$HY2_PORT > 65535)); then
  echo "HY2_PORT должен быть UDP-портом от 1 до 65535" >&2
  exit 1
fi
[ -e /dev/net/tun ] || warn "нет /dev/net/tun — amneziawg-go не поднимется"

# --- sysctl ---
# Без форвардинга клиенты подключатся, но трафик не пойдёт; IPv6-строки нужны
# для AWG_ADDRESS6.
cat >"$SYSCTL_FILE" <<'EOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
net.ipv6.conf.all.disable_ipv6=0
net.ipv6.conf.default.disable_ipv6=0
EOF
sysctl --system >/dev/null
echo "sysctl: $SYSCTL_FILE применён (ip_forward=$(cat /proc/sys/net/ipv4/ip_forward))"

# --- фаервол ---
# ufw не включаем сами: на чужом хосте это закрыло бы SSH. Если он выключен,
# правила не добавляем и говорим об этом.
open_ports=("443/tcp" "${AWG_PORT}/udp" "${HY2_PORT}/udp")

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  for port in "${open_ports[@]}"; do
    ufw allow "$port" >/dev/null
  done
  echo "ufw: открыто ${open_ports[*]}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  for port in "${open_ports[@]}"; do
    firewall-cmd --permanent --add-port="$port" >/dev/null
  done
  firewall-cmd --reload >/dev/null
  echo "firewalld: открыто ${open_ports[*]}"
else
  warn "ни ufw, ни firewalld не активны — порты ${open_ports[*]} откройте в фаерволе провайдера/хоста"
fi

# --- cpus ---
# Первое значение cpus в compose — limits; больше числа ядер docker не стартует контейнер.
cores="$(nproc)"
limit="$(awk '/cpus:/ { gsub(/[\047"]/, "", $2); print $2; exit }' docker-compose.yml)"
if [ -n "$limit" ] && awk -v l="$limit" -v c="$cores" 'BEGIN { exit !(l > c) }'; then
  warn "docker-compose.yml: cpus=$limit, а ядер на хосте $cores — docker откажется стартовать контейнер, уменьшите limits.cpus"
else
  echo "cpus: лимит ${limit:-—} при $cores ядрах — ок"
fi

echo
echo "Запускать только через make (docker compose -p $NAME): без -p команды бьют мимо контейнера."
echo "Дальше: make up"
