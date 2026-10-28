NAME = vpn-bot

up:
	docker compose -p $(NAME) up -d

down:
	docker compose -p $(NAME) down

restart:
	docker compose -p $(NAME) restart

build:
	docker compose -p $(NAME) build

# down должен реально завершиться и отпустить порты, прежде чем up попробует
# их занять снова — || true в шагах выше маскировал такие сбои, и rebuild
# ехал дальше на build/up с портом, который ещё не освободился.
rebuild: down clean build up logs

logs:
	docker compose -p $(NAME) logs -f

# Копия БД делается внутри работающего контейнера, поэтому backup требует up.
backup:
	NAME="$(NAME)" OUT="$(OUT)" bash scripts/backup.sh

# Контейнер должен быть остановлен (make down); FORCE=1 — поверх существующих данных.
restore:
	NAME="$(NAME)" FILE="$(FILE)" FORCE="$(FORCE)" bash scripts/restore.sh

# Один раз на новом хосте: sysctl, фаервол, проверка cpus (нужен root).
bootstrap:
	NAME="$(NAME)" bash scripts/bootstrap-host.sh

clean:
	docker image prune -af --filter "label=com.docker.compose.project=$(NAME)"
	docker volume prune -f --filter "label=com.docker.compose.project=$(NAME)"