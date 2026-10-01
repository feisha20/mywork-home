#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then bash scripts/setup.sh; fi
docker compose up -d --build workbench
printf '工作台地址：http://127.0.0.1:8787\n'
