---
paths:
  - "Makefile"
  - "docker-compose.yml"
  - ".github/workflows/**"
---

## Контракты
- Job `deploy` в `.github/workflows/ci.yml` (push в `dev`, после `check`) заходит
  по ssh ключом с `command=/usr/local/bin/deploy-dispatch` — скрипт живёт на VPS,
  не в репозитории. Он делает `git fetch && git reset --hard origin/dev` в
  `/root/vpn` и запускает `make build && make up`. Переименовал таргет, сменил
  ветку деплоя или `-p vpn-bot` — правь диспетчер и `if:` у job вместе.
- `make build` и `make up` обязаны завершаться сами: `logs -f` (как в `rebuild`)
  или подтверждение подвесят job до таймаута.
- `configs/`, `data/`, `.env` вне git: `reset --hard` их не трогает, пока они в
  `.gitignore`. Убрал оттуда — деплой затрёт ключи Reality и `awg0.conf`, и все
  выданные конфиги отвалятся.
- `make bootstrap` (`scripts/bootstrap-host.sh`) читает первый `cpus:` из `docker-compose.yml`
  (это `limits`) и сверяет с `nproc`; переставишь `reservations` выше `limits` — проверка
  начнёт сравнивать не то. Порты фаервола (443/tcp, 443/udp, `AWG_PUBLIC_PORT`/udp) должны
  совпадать с тем, что слушают nginx и `awg0`.
- Правки руками на сервере диспетчер не затирает, а падает на `git status --porcelain`.
- `make backup` кладёт `vpn-backup-*.tgz` в корень (или `OUT=`): маска в `.gitignore`
  обязательна, иначе untracked-архив остановит деплой. Копия БД идёт через
  `scripts/db-backup.cjs` внутри контейнера — файл копируется в образ в `Dockerfile`.
