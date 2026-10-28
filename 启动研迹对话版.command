#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if curl -fsS http://127.0.0.1:4320/api/settings >/dev/null 2>&1; then
  open http://127.0.0.1:4320/
  exit 0
fi
if [ ! -x .venv/bin/python ]; then
  if command -v uv >/dev/null 2>&1; then
    uv sync --frozen
  else
    echo '请先安装 Python 3.12+，创建 .venv 并用 requirements.txt 安装依赖。'
    read
    exit 1
  fi
fi
if [ ! -d node_modules ]; then npm ci; fi
if [ ! -f dist/index.html ]; then npm run build; fi
# 等服务真正就绪再开页面，避免浏览器先显示连接失败。
( for i in {1..60}; do
    if curl -fsS http://127.0.0.1:4320/api/settings >/dev/null 2>&1; then
      open http://127.0.0.1:4320/
      exit 0
    fi
    sleep 1
  done
) &
PYTHONPATH=backend .venv/bin/python -m yanji
