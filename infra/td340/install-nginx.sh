#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="${SSH_HOST:-td340}"
CONF_NAME="ielts.appliva.io"
LOCAL_CONF="infra/td340/nginx/${CONF_NAME}"
REMOTE_TMP="/tmp/${CONF_NAME}"
REMOTE_AVAILABLE="/etc/nginx/sites-available/${CONF_NAME}"
REMOTE_ENABLED="/etc/nginx/sites-enabled/${CONF_NAME}"

scp "${LOCAL_CONF}" "${SSH_HOST}:${REMOTE_TMP}"
ssh "${SSH_HOST}" "sudo install -m 0644 '${REMOTE_TMP}' '${REMOTE_AVAILABLE}' && sudo ln -sf '${REMOTE_AVAILABLE}' '${REMOTE_ENABLED}' && sudo nginx -t && sudo systemctl reload nginx"
