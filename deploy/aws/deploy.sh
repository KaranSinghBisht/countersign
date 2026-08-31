#!/usr/bin/env bash
# Build the image here, ship it to the instance, start (or restart) the stack.
#
#   deploy/aws/deploy.sh <ssh-host> <public-host> <path-to-app.env> <path-to-postgres-password>
#
# No registry: the image travels as a gzip over ssh. On a t3.micro that is
# faster and simpler than building on the box, and nothing has to be public.
set -euo pipefail

SSH_HOST="${1:?ssh host, e.g. ec2-user@1.2.3.4}"
PUBLIC_HOST="${2:?public hostname, e.g. 1-2-3-4.sslip.io}"
APP_ENV="${3:?path to app.env}"
PG_PASSWORD_FILE="${4:?path to the postgres password file}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/countersign-aws.pem}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

ssh_cmd() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_HOST" "$@"; }
scp_cmd() { scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$@"; }

echo "→ building linux/amd64 image"
docker build --platform linux/amd64 -t countersign:latest "$ROOT"

echo "→ shipping image, compose file, Caddyfile, env"
docker save countersign:latest | gzip | ssh_cmd 'gunzip | docker load'
scp_cmd "$ROOT/deploy/aws/compose.yml" "$ROOT/deploy/aws/Caddyfile" "$SSH_HOST:/opt/countersign/"
scp_cmd "$APP_ENV" "$SSH_HOST:/opt/countersign/app.env"
scp_cmd "$PG_PASSWORD_FILE" "$SSH_HOST:/opt/countersign/postgres_password"
ssh_cmd 'chmod 600 /opt/countersign/app.env /opt/countersign/postgres_password'

echo "→ starting the stack"
ssh_cmd "cd /opt/countersign && PUBLIC_HOST='$PUBLIC_HOST' docker compose up -d --remove-orphans"
ssh_cmd 'cd /opt/countersign && docker compose ps'
echo "→ https://$PUBLIC_HOST/healthz"
