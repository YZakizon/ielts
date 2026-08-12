COMPOSE ?= docker compose
COMPOSE_PROFILES ?= dev
comma := ,
ACTIVE_PROFILES := $(subst $(comma), ,$(COMPOSE_PROFILES))
SERVICE ?=
LOG_SERVICES ?= $(if $(filter td340,$(ACTIVE_PROFILES)),ielts postgres,ielts-dev postgres-dev)
SSH_HOST ?= td340
REMOTE_DIR ?= /home/yeffry/ielts

.PHONY: docker-build-run docker-run docker-logs ensure-traefik-network deploy-td340 nginx-install-td340

docker-build-run: ensure-traefik-network
	COMPOSE_PROFILES=$(COMPOSE_PROFILES) $(COMPOSE) up --build -d

docker-run: ensure-traefik-network
	COMPOSE_PROFILES=$(COMPOSE_PROFILES) $(COMPOSE) up -d

docker-logs:
	COMPOSE_PROFILES=$(COMPOSE_PROFILES) $(COMPOSE) logs -f $(if $(SERVICE),$(SERVICE),$(LOG_SERVICES))

ensure-traefik-network:
	docker network inspect traefik-proxy >/dev/null 2>&1 || docker network create traefik-proxy

deploy-td340:
	COMPOSE_PROFILES=td340 SSH_HOST=$(SSH_HOST) REMOTE_DIR=$(REMOTE_DIR) ./infra/td340/deploy.sh

nginx-install-td340:
	SSH_HOST=$(SSH_HOST) ./infra/td340/install-nginx.sh
