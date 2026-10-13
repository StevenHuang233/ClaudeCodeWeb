#!/usr/bin/env bash
# 启动 ClaudeCodeWeb。零依赖，只要有 Node >= 18。
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_BIN="${CCWEB_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="node"
  else
    for c in \
      "$HOME/.local/bin/node" \
      /usr/local/bin/node \
      /usr/bin/node \
      /opt/homebrew/bin/node \
      "$HOME"/.codebuddy-server-cn/bin/*/node \
      "$HOME"/.vscode-server/bin/*/node
    do
      if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
    done
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "找不到 node（需要 >= 18）。请先安装 Node，或设置 CCWEB_NODE=/path/to/node" >&2
  exit 1
fi

echo "使用 node: $NODE_BIN ($("$NODE_BIN" -v))"
exec "$NODE_BIN" server.js
