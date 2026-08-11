COMPOSE ?= docker compose
SERVICE ?= ielts
SSH_HOST ?= td340
REMOTE_DIR ?= /home/yeffry/ielts

.PHONY: docker-build-run docker-run docker-logs deploy-td340 nginx-install-td340

docker-build-run:
	$(COMPOSE) up --build -d

docker-run:
	$(COMPOSE) up -d

docker-logs:
	$(COMPOSE) logs -f $(SERVICE)

deploy-td340:
	SSH_HOST=$(SSH_HOST) REMOTE_DIR=$(REMOTE_DIR) ./infra/td340/deploy.sh

nginx-install-td340:
	SSH_HOST=$(SSH_HOST) ./infra/td340/install-nginx.sh
