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

clean:
	docker image prune -af --filter "label=com.docker.compose.project=$(NAME)"
	docker volume prune -f --filter "label=com.docker.compose.project=$(NAME)"