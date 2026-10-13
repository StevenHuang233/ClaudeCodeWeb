# tclaude 速查

TClaude = 腾讯内部 Claude Code 封装（`@anthropic-ai/claude-code` 内核），走 OA 登录。

## 安装

```bash
curl -fsSL https://mirrors.tencent.com/repository/generic/tclaude/tclaude/install.sh | sh
# 或 npm install -g @tencent/tclaude --registry https://mirrors.tencent.com/npm
tclaude --version      # 0.1.8 / claude-code 2.1.251
```

> `iwiki.woa.com` 多数机器解析到 `10.x` 后不可达，别指望从 iwiki 拷命令。

## 登录

```bash
tclaude login          # 浏览器打开 copilot.tencent.com 完成 OA 登录，有效期 30 天
tclaude daemon status  # 后台网关守护进程
```

## 目录结构

配置目录是 `~/.tclaude`（**不是** `~/.claude`），可用 `CLAUDE_CONFIG_DIR` 改到别处（比如共享盘）：

```
~/.tclaude/
├── settings.json            # 默认模型、permissions.allow/deny
├── cache/gateway-models.json
├── agents/*.md              # 子 agent
├── projects/<slug>/*.jsonl  # 会话记录（Web 的 TUI 模式读这个）
└── runtime/                 # Claude Code 内核
```

项目 slug = 工作目录把非字母数字换成 `-`（`/data/workspace` → `-data-workspace`）。

## 子 agent

`<config>/agents/*.md`：

```markdown
---
name: ceph-helper
description: 负责在共享盘上查找和整理数据集
tools: Bash, Read, Glob, Grep
---

正文就是它的 system prompt。
```

`description` 决定主 agent 何时委派；`tools` 不写就继承全部（建议最小权限）。

## 模型与成本（实测单次）

| 模型 | 花费 |
| --- | --- |
| `claude-haiku-4-5` | **$0.006** ← 调试默认 |
| `claude-deepseek-v4.1-flash[1m]` | $0.019 |
| `claude-opus-5-5[1m]` | $0.156 |
| `claude-sonnet-5-5[1m]` | $0.234 |

部分模型账号无权限（`403 Model is blocked`），需找管理员开通。

## 常用命令

```bash
tclaude -p "问题"                      # 非交互式
tclaude -p --model claude-haiku-4-5 "…"
tclaude -c                             # 继续上次会话
tclaude -r                             # 选择历史会话恢复
tclaude update / tclaude update --claude
```

`--output-format stream-json` 必须配 `-p` 和 `--verbose`；交互式模式下没有事件流。

## 注意事项

- 交互式 `tclaude` 会**自动续接该目录最近一次会话**（CLI 无 `--new`），要么手动 `/clear`，要么用 ClaudeCodeWeb（它会自动处理）
- 共享盘上 `dop-fuse` 的目录大小会虚高，别用 `du -sb` 比对，用 `find -type f -printf "%s\n"`
- 每台机器的 `CLAUDE_CONFIG_DIR` 要分开（`daemon-port`、`locks` 是单机独占的）
