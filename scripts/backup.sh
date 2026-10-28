#!/usr/bin/env bash
# make backup [OUT=каталог] — vpn-backup-<дата>.tgz с БД, configs/ и .env.
# БД копируется внутри работающего контейнера (без make down).
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${NAME:-vpn-bot}"
OUT="${OUT:-.}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT/vpn-backup-$STAMP.tgz"

[ -f .env ] || { echo "нет .env — нечего сохранять" >&2; exit 1; }
[ -d configs ] || { echo "нет configs/ — нечего сохранять" >&2; exit 1; }

docker compose -p "$NAME" exec -T vpn-bot node scripts/db-backup.cjs
# Каталог data/backup создан контейнером (root), с хоста файл может не удалиться,
# поэтому чистим через exec — и при падении tar тоже.
trap 'docker compose -p "$NAME" exec -T vpn-bot rm -f data/backup/vpn.db' EXIT

mkdir -p "$OUT"
# Права до tar: в архиве лежат ключи Reality/AWG и токен бота.
umask 077
tar -czf "$ARCHIVE" \
  --transform 's,^data/backup/,data/,' \
  .env configs data/backup/vpn.db

echo "Готово: $ARCHIVE"
echo "Архив содержит секреты (.env, ключи) — храните вне сервера и не коммитьте."
