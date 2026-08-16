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

# Домен, под TLS которого маскируется прокси (faketls) — переопределяется:
# make mtproto-up MTPROTO_DOMAIN=example.com
MTPROTO_DOMAIN ?= www.cloudflare.com

# Генерирует MTPROTO_SECRET, только если его ещё нет в .env (повторный запуск
# существующий секрет не трогает — иначе пересоздание меняло бы ссылку у уже
# выданных клиентов), включает MTPROTO_ENABLED и поднимает mtg. vpn-bot
# пересоздаётся, чтобы подхватить новый .env — docker compose up без
# --force-recreate не гарантированно перечитывает env_file на лету.
mtp-up:
	@if ! grep -qE '^MTPROTO_SECRET=.+' .env 2>/dev/null; then \
		echo "MTPROTO_SECRET не задан — генерирую (домен маскировки: $(MTPROTO_DOMAIN))"; \
		SECRET=$$(docker run --rm nineseconds/mtg:2 generate-secret --hex $(MTPROTO_DOMAIN)); \
		if [ -z "$$SECRET" ]; then \
			echo "Не удалось сгенерировать секрет — проверь, что образ nineseconds/mtg:2 доступен"; \
			exit 1; \
		fi; \
		if grep -qE '^MTPROTO_SECRET=' .env 2>/dev/null; then \
			sed -i "s|^MTPROTO_SECRET=.*|MTPROTO_SECRET=$$SECRET|" .env; \
		else \
			printf '\nMTPROTO_SECRET=%s\n' "$$SECRET" >> .env; \
		fi; \
		echo "Секрет записан в .env"; \
	else \
		echo "MTPROTO_SECRET уже задан — использую существующий"; \
	fi
	@if grep -qE '^MTPROTO_ENABLED=' .env 2>/dev/null; then \
		sed -i 's|^MTPROTO_ENABLED=.*|MTPROTO_ENABLED=true|' .env; \
	else \
		printf '\nMTPROTO_ENABLED=true\n' >> .env; \
	fi
	docker compose -p $(NAME) --profile mtproto up -d
	docker compose -p $(NAME) up -d --force-recreate vpn-bot
	@echo "Готово. Логи прокси: make mtproto-logs"

mtp-down:
	docker compose -p $(NAME) --profile mtproto stop mtg

mtp-logs:
	docker compose -p $(NAME) --profile mtproto logs -f mtg