#!/usr/bin/env bash
# ClaudeCodeWeb 命令行入口。
# 用法见 SKILL.md。环境变量：CCWEB_URL / CCWEB_TOKEN / CCWEB_DIR
set -uo pipefail

URL="${CCWEB_URL:-http://127.0.0.1:18787}"
TOKEN="${CCWEB_TOKEN:-}"

# 找到项目目录
DIR="${CCWEB_DIR:-}"
if [ -z "$DIR" ]; then
  for c in "$HOME/ClaudeCodeWeb" "/data/workspace/ClaudeCodeWeb" "$(pwd)"; do
    if [ -f "$c/server.js" ]; then DIR="$c"; break; fi
  done
fi

api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -m 60 -X "$method" "$URL$path")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  if [ -n "$data" ]; then
    args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  curl "${args[@]}"
}

jq_() { python3 -c "$1"; }

case "${1:-status}" in
  status)
    api GET /api/health 2>/dev/null || { echo "服务未启动：$URL"; exit 1; }
    echo
    ;;
  start)
    if [ -z "$DIR" ]; then echo "找不到 ClaudeCodeWeb 目录，请设置 CCWEB_DIR" >&2; exit 1; fi
    (cd "$DIR" && setsid nohup node server.js > /tmp/ccweb.log 2>&1 < /dev/null &)
    sleep 3
    api GET /api/health || { echo "启动失败，看 /tmp/ccweb.log" >&2; exit 1; }
    echo
    echo "地址: $URL"
    ;;
  sessions)
    api GET /api/sessions | jq_ '
import sys,json
d=json.load(sys.stdin)
for s in d.get("items",[]):
    print(s["id"], "|", s.get("kind") or "spawn", "|", s.get("title"), "|", s.get("status"))
'
    ;;
  locals)
    api GET /api/local-sessions | jq_ '
import sys,json
d=json.load(sys.stdin)
for a in d.get("active",[]):
    print("当前:", a["name"], "|", a.get("model") or "", "|", a.get("attachCmd") or "")
for h in d.get("history",[]):
    print("历史:", str(h["sessionId"])[:8], "|", h.get("cwd") or "")
for h in d.get("archive",[]):
    print("归档:", str(h["sessionId"])[:8], "|", h.get("cwd") or "")
'
    ;;
  new)
    name="${2:?需要会话名}"
    cwd="${3:-$PWD}"
    model="${4:-claude-haiku-4-5}"
    api POST /api/local-sessions "$(printf '{"name":"%s","cwd":"%s","model":"%s","permissionMode":"acceptEdits"}' "$name" "$cwd" "$model")" | jq_ '
import sys,json
d=json.load(sys.stdin)
print("已创建:", d.get("name"))
'
    echo "终端: tmux attach -t $name"
    ;;
  bind)
    name="${2:?需要会话名}"
    api POST /api/sessions "$(printf '{"source":{"kind":"managed","name":"%s"}}' "$name")" | jq_ '
import sys,json
d=json.load(sys.stdin)
s=d["session"]
print(s["id"])
'
    echo "终端: tmux attach -t $name"
    ;;
  send)
    sid="${2:?需要 session id}"; text="${3:?需要消息内容}"
    api POST "/api/sessions/$sid/messages" "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$text")"
    echo
    ;;
  events)
    sid="${2:?需要 session id}"
    api GET "/api/sessions/$sid" | jq_ '
import sys,json
d=json.load(sys.stdin)
for e in d.get("events",[])[-40:]:
    t=e.get("type")
    if t=="user":
        c=e["message"]["content"]
        print("USER:", (c if isinstance(c,str) else "".join(x.get("text","") for x in c if x.get("type")=="text"))[:300])
    elif t=="assistant":
        print("ASST:", "".join(x.get("text","") for x in (e.get("message",{}).get("content") or []) if x.get("type")=="text")[:300])
    elif t=="result":
        print("RESULT: cost=", e.get("total_cost_usd"), "turns=", e.get("num_turns"))
'
    ;;
  ask)
    name="${2:?需要会话名}"; text="${3:?需要消息内容}"
    cwd="${4:-$PWD}"
    model="${5:-claude-haiku-4-5}"
    api POST /api/local-sessions "$(printf '{"name":"%s","cwd":"%s","model":"%s","permissionMode":"acceptEdits"}' "$name" "$cwd" "$model")" > /dev/null
    sleep 6
    sid="$(api POST /api/sessions "$(printf '{"source":{"kind":"managed","name":"%s"}}' "$name")" | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["id"])')"
    api POST "/api/sessions/$sid/messages" "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$text")" > /dev/null
    echo "session=$sid  终端: tmux attach -t $name"
    for i in $(seq 1 60); do
      out="$(api GET "/api/sessions/$sid" | python3 -c '
import sys,json
d=json.load(sys.stdin)
res=[e for e in d["events"] if e.get("type")=="result"]
asst=[e for e in d["events"] if e.get("type")=="assistant"]
txt="".join(x.get("text","") for e in asst for x in (e.get("message",{}).get("content") or []) if x.get("type")=="text")
print(("DONE " if res else "WAIT "), (round(res[-1]["total_cost_usd"],5) if res else ""), txt)
')"
      case "$out" in DONE*) echo "$out"; break;; esac
      sleep 3
    done
    ;;
  stop)
    name="${2:?需要会话名}"
    api DELETE "/api/local-sessions/$name"
    echo
    ;;
  *)
    echo "用法: $0 {status|start|sessions|locals|new|bind|send|events|ask|stop} ..."
    exit 1
    ;;
esac
