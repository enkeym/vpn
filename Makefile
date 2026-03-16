NAME = vpn-bot

up:
	docker compose -p $(NAME) up -d || true

down:
	docker compose -p $(NAME) down || true

restart:
	docker compose -p $(NAME) restart || true

build:
	docker compose -p $(NAME) build || true

rebuild: down clean build up

logs:
	docker compose -p $(NAME) logs -f

clean:
	docker system prune -af --volumes