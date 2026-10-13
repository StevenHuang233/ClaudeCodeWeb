---
name: claudecodeweb
description: 把 tclaude / claude code CLI 接到本地 Web 上用，也可以在命令行里管理会话（新建、发消息、取结果、绑定终端、恢复历史）。当需要「不想一直盯着终端操作 Claude Code」「同时看多个会话」「把会话接到浏览器里」时使用。
---

# ClaudeCodeWeb

把 **tclaude / claude code CLI** 接到浏览器里用。一个对话 ≡ 一个同名 tmux 会话 ≡ 一个 tc 进程，
终端和 Web 实时同步。

- `tc` = `tclaude`（腾讯内部 Claude Code 封装）；`cc` = 官方 `claude` CLI
- 零第三方依赖，只需 Node >= 18，建议装 tmux

## 何时使用

- 用户想**在浏览器里**跟 Claude Code 对话，而不是守在终端前
- 想同时看/管多个会话，或把会话切到另一个终端（`tmux attach`）
- 想从命令行脚本化地跑 Claude Code（发一条消息、等结果、拿花费）
- 想恢复某个历史会话继续聊

## 环境

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CCWEB_URL` | `http://127.0.0.1:18787` | 服务地址 |
| `CCWEB_TOKEN` | 空 | 服务设了令牌就要填 |
| `CCWEB_DIR` | 自动探测 | ClaudeCodeWeb 项目目录 |

脚本会自动在常见位置找项目目录（`$CCWEB_DIR`、`~/ClaudeCodeWeb`、`/data/workspace/ClaudeCodeWeb`）。

## 命令行用法

```bash
scripts/ccweb.sh status                        # 服务是否活着
scripts/ccweb.sh start                         # 启动服务（后台）
scripts/ccweb.sh sessions                      # 已接入的会话
scripts/ccweb.sh locals                        # 本机的对话（当前/历史/归档）
scripts/ccweb.sh new mytask ./                 # 新建对话（起 tmux）
scripts/ccweb.sh bind mytask                   # 接入某个对话，返回 session id 和 tmux attach 命令
scripts/ccweb.sh ask mytask "帮我看下这个 bug"   # 新建 + 发送 + 等结果（一条龙）
scripts/ccweb.sh send <sessionId> "继续"        # 给已有会话发消息
scripts/ccweb.sh events <sessionId>            # 查看事件流
scripts/ccweb.sh stop mytask                   # 结束对话（进历史记录）
```

`ask` 会打印助手的回复文本和本次花费，适合脚本化调用。

## 在浏览器里用

打开 `$CCWEB_URL`，侧栏：

- **当前对话（终端 ⇄ Web）**：点条目在 Web 打开；「复制终端命令」拿到 `tmux attach -t <名字>`
- **历史记录**：点条目 = 审视（只读）；「打开（新终端）」= `--resume` 继续聊；「归档」= 收进折叠区
- **归档**：折叠区，这里「删除文件」才真的删
- **子 agent / 权限设置 / 模型权限**：三个配置入口
- 输入框右下角可切**模型**和**思考强度**；上方有 `/compact`、`/clear`、`/usage`、`计划模式` 等按钮

## 终端里启动（反向同步）

```bash
cd ClaudeCodeWeb
node scripts/tc-run.js --name mytask --cwd /your/project --model claude-haiku-4-5
```

默认跑**原生 Claude Code 界面**并自动进 tmux；Web 侧栏随即出现 `mytask`。
加 `--structured` 换成简化界面，好处是 Web 端能看到**花费和 token**（原生 TUI 模式没有）。

## 两个经常踩的坑

1. **交互式 tc 会续接该目录最近一次会话**（CLI 里没有 `--new`）。本项目新建时会自动发 `/clear`，
   并记录读取基线，所以 Web 上看到的是干净的。
2. **不在 tmux 里的 tc 无法接管**。没有多路复用器就读不到已在运行进程的终端输出。
   要么用 `scripts/tc-run.js` 启动，要么先放进 tmux。

## 模型

调试默认用最便宜的 `claude-haiku-4-5`（实测单次约 $0.006）。
`claude-sonnet-5-5[1m]` 约 $0.234，差 40 倍。

有些模型账号没权限（`403 Model is blocked`），用「模型权限」探测一次就清楚哪些能用。

## 参考

- `references/api.md`：HTTP API 速查
- `references/tclaude.md`：tclaude 本身的安装/登录/配置
- 项目 README：安装与完整配置说明
