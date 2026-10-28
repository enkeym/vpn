#!/usr/bin/env bash
# make restore FILE=vpn-backup-….tgz — распаковка в рабочую папку.
# Контейнер должен быть остановлен: иначе SQLite перезапишется под живой
# записью. Существующие данные не затираются без FORCE=1.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${NAME:-vpn-bot}"
FILE="${FILE:-}"

[ -n "$FILE" ] || { echo "укажите архив: make restore FILE=vpn-backup-….tgz" >&2; exit 1; }
[ -f "$FILE" ] || { echo "нет файла: $FILE" >&2; exit 1; }

# Проверяем содержимое до распаковки: чужой архив не должен писать вне рабочей папки.
# Symlink/hardlink-запись (`configs/x -> /etc`, затем `configs/x/…`) обошла бы
# проверку путей, поэтому разрешены только файлы и каталоги, а имена — из allow-list.
if tar -tvzf "$FILE" | grep -qv '^[-d]'; then
  echo "архив содержит не только файлы и каталоги (ссылки, устройства) — отказ" >&2
  exit 1
fi
LIST="$(tar -tzf "$FILE")"
if echo "$LIST" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "архив содержит небезопасные пути — отказ" >&2
  exit 1
fi
if echo "$LIST" | grep -Evq '^(\.env|configs/?|configs/.+|data/?|data/vpn\.db)$'; then
  echo "архив содержит посторонние пути — отказ" >&2
  exit 1
fi
echo "$LIST" | grep -Fqx 'data/vpn.db' || { echo "в архиве нет data/vpn.db" >&2; exit 1; }
echo "$LIST" | grep -Fqx '.env' || { echo "в архиве нет .env" >&2; exit 1; }

if [ -n "$(docker compose -p "$NAME" ps -q 2>/dev/null || true)" ]; then
  echo "контейнер запущен — сначала make down" >&2
  exit 1
fi

if [ "${FORCE:-}" != "1" ] && { [ -f data/vpn.db ] || [ -f .env ] || [ -n "$(ls -A configs 2>/dev/null)" ]; }; then
  echo "в рабочей папке уже есть .env, configs/ или data/vpn.db." >&2
  echo "Перезаписать: make restore FILE=$FILE FORCE=1" >&2
  exit 1
fi

mkdir -p data configs
# Хвосты старой базы: -wal от другой версии поверх восстановленной vpn.db
# испортили бы её при открытии.
rm -f data/vpn.db-wal data/vpn.db-shm

umask 077
tar -xzf "$FILE" --no-same-owner

echo "Восстановлено из $FILE. Дальше: make bootstrap, make up"
