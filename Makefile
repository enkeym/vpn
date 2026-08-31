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

# Прокси для Telegram (SOCKS5) живёт внутри Xray, отдельного контейнера у него
# больше нет. Включение — XRAY_SOCKS_ENABLED=true в .env; логин и пароль Xray
# генерирует сам в configs/xray-socks.json. vpn-bot пересоздаётся, чтобы
# подхватить новый .env — docker compose up без --force-recreate не
# гарантированно перечитывает env_file на лету.
tg-proxy-up:
	@if grep -qE '^XRAY_SOCKS_ENABLED=' .env 2>/dev/null; then \
		sed -i 's|^XRAY_SOCKS_ENABLED=.*|XRAY_SOCKS_ENABLED=true|' .env; \
	else \
		printf '\nXRAY_SOCKS_ENABLED=true\n' >> .env; \
	fi
	docker compose -p $(NAME) up -d --force-recreate vpn-bot
	@echo "Готово. Ссылку возьмите в боте: карточка конфига → «Прокси для Telegram»"

tg-proxy-down:
	@if grep -qE '^XRAY_SOCKS_ENABLED=' .env 2>/dev/null; then \
		sed -i 's|^XRAY_SOCKS_ENABLED=.*|XRAY_SOCKS_ENABLED=false|' .env; \
	fi
	docker compose -p $(NAME) up -d --force-recreate vpn-bot