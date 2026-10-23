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
- Правки руками на сервере диспетчер не затирает, а падает на `git status --porcelain`.
