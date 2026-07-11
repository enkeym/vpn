NAME = vpn-new-bot

up:
	docker compose -p $(NAME) up -d || true

down:
	docker compose -p $(NAME) down || true

restart:
	docker compose -p $(NAME) restart || true

build:
	docker compose -p $(NAME) build || true

rebuild: down clean build up logs

logs:
	docker compose -p $(NAME) logs -f

clean:
	docker image prune -af --filter "label=com.docker.compose.project=$(NAME)"
	docker volume prune -f --filter "label=com.docker.compose.project=$(NAME)"