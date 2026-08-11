#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-td340}"
REMOTE_DIR="${REMOTE_DIR:-/home/yeffry/ielts}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.td340.yml}"

rsync -az --delete \
  --exclude ".env" \
  --exclude ".git/" \
  --exclude ".agents/" \
  --exclude ".codex/" \
  --exclude "node_modules/" \
  --exclude "npm-debug.log" \
  ./ "${SSH_HOST}:${REMOTE_DIR}/"

if [ -f .env ] && ! ssh "${SSH_HOST}" "test -f '${REMOTE_DIR}/.env'"; then
  scp .env "${SSH_HOST}:${REMOTE_DIR}/.env"
fi

ssh "${SSH_HOST}" "cd '${REMOTE_DIR}' && test -f .env && docker compose -f '${COMPOSE_FILE}' up --build -d"
