#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${WORKBENCH_ADMIN_DATABASE_URL:-}" ]; then
  read -r -s -p '请输入初始化用 PostgreSQL 管理员连接（容器地址使用 host.docker.internal）：' WORKBENCH_ADMIN_DATABASE_URL
  printf '\n'
fi
export WORKBENCH_ADMIN_DATABASE_URL
export WORKBENCH_LLM_API_KEY="${WORKBENCH_LLM_API_KEY:-}"
export LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)"
docker compose --profile setup run --rm --build init-db
unset WORKBENCH_ADMIN_DATABASE_URL WORKBENCH_LLM_API_KEY
printf '初始化完成。运行 docker compose up -d 即可启动工作台；模型密钥可在右上角头像的设置中填写。\n'
