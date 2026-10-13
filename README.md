# ClaudeCodeWeb

把 **tclaude / claude code CLI** 接到浏览器里用，不用一直盯着终端。

- `tc` = `tclaude`（腾讯内部 Claude Code 封装，`@anthropic-ai/claude-code` 内核）
- `cc` = 官方 `claude` CLI

两者协议一致，用 `CCWEB_CLI` 切换。**零第三方依赖**，只需要 Node >= 18。

核心设计：**一个对话 ≡ 一个同名 tmux 会话 ≡ 一个 tc 进程**。终端里是原生 Claude Code 界面，
Web 上同时显示结构化的消息、工具调用和思考过程，两边实时同步。

---

## 目录

1. [环境要求](#1-环境要求)
2. [安装](#2-安装)
3. [登录](#3-登录)
4. [配置](#4-配置)
5. [启动](#5-启动)
6. [使用](#6-使用)
7. [终端界面：两种模式](#7-终端界面两种模式)
8. [会话管理：三层结构](#8-会话管理三层结构)
9. [模型与成本](#9-模型与成本)
10. [进阶配置](#10-进阶配置)
11. [API](#11-api)
12. [目录结构](#12-目录结构)
13. [安全](#13-安全)
14. [排错](#14-排错)

---

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| Node | >= 18（本项目零第三方依赖，无需 `npm install`） |
| tmux | 强烈建议装（`yum install -y tmux` / `apt install tmux`）。没有也能跑，但会退化成简化模式 |
| CLI | `tclaude` 或 `claude`，且已完成登录 |
| 网络 | 能访问 `mirrors.tencent.com`（安装源） |

---

## 2. 安装

### 2.1 装 CLI

```bash
# 方式 A：一键脚本（推荐）
curl -fsSL https://mirrors.tencent.com/repository/generic/tclaude/tclaude/install.sh | sh
# 装到 ~/.local/bin/tclaude，并自动写入 PATH

# 方式 B：npm
npm install -g @tencent/tclaude --registry https://mirrors.tencent.com/npm

# 验证
tclaude --version
# @tencent/tclaude 0.1.8
# @anthropic-ai/claude-code 2.1.251
```

> `iwiki.woa.com` 是内网地址，多数开发机解析到 `10.x` 后不可达，别指望从 iwiki 拷命令。

### 2.2 装本项目

```bash
git clone git@github.com:StevenHuang233/ClaudeCodeWeb.git
cd ClaudeCodeWeb
# 不需要 npm install
```

---

## 3. 登录

```bash
tclaude login
# 会打印 https://copilot.tencent.com/login?... 用浏览器打开完成 OA 登录
tclaude daemon status     # 应显示 http://127.0.0.1:<port>
```

登录态有效期 **30 天**，轮询窗口 300 秒，超时重跑一次即可。

---

## 4. 配置

复制 `.env.example` 为 `.env` 后按需修改。`.env` 启动时自动加载（只补不覆盖已有环境变量），且已被 `.gitignore` 忽略。

```bash
cp .env.example .env
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CCWEB_HOST` | `127.0.0.1` | 监听地址；设成 `0.0.0.0` 时必须同时设 `CCWEB_TOKEN` |
| `CCWEB_PORT` | `18787` | 端口 |
| `CCWEB_TOKEN` | 空 | 不设则任何人不需鉴权；**对外暴露必设** |
| `CCWEB_CLI` | `tclaude` | 要接的 CLI，可填绝对路径 |
| `CCWEB_MODEL` | `claude-haiku-4-5` | 默认模型（实测最便宜） |
| `CCWEB_CWD` | 进程 cwd | 新建对话的默认工作目录 |
| `CCWEB_PERMISSION_MODE` | `acceptEdits` | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `CCWEB_RUN_DIR` | `~/.cache/ccweb` | 会话的 `*.jsonl` / `*.fifo` / `*.meta.json` 存放目录 |
| `CCWEB_ALLOWED_ROOTS` | 空 | 限制工作目录白名单，`:` 分隔 |
| `CCWEB_MAX_SESSIONS` | `32` | 同时绑定的会话数上限 |
| `CCWEB_READ_ONLY` | `0` | 设 `1` 禁止新建会话和发消息 |
| `CCWEB_NODE` | 空 | 指定 node 路径（start.sh 用） |
| `CLAUDE_CONFIG_DIR` | `~/.tclaude` | Claude Code 配置目录，TUI 模式靠它找会话记录 |

生成令牌：

```bash
python3 -c "import secrets;print(secrets.token_urlsafe(24))"
```

---

## 5. 启动

```bash
./scripts/start.sh          # 自动探测 node
# 或
node server.js
# 或
set -a && . ./.env && set +a && node server.js
```

打开 `http://127.0.0.1:18787`（设了令牌就加 `?token=xxx`，或不带 token 打开后弹窗输入）。

后台常驻：

```bash
setsid nohup node server.js > /tmp/ccweb.log 2>&1 < /dev/null &
```

停止：`pkill -f "node server.js"`（会一并结束它拉起的会话进程）。

---

## 6. 使用

### 三种会话来源

| 来源 | 怎么来的 | Web 能看到什么 |
| --- | --- | --- |
| **托管（默认）** | Web 点「新建对话」，或终端跑 `node scripts/tc-run.js --name x` | 完整结构化：消息、工具卡片、思考、输入 |
| **原生 TUI** | 同上的默认模式，终端是原生界面 | 读 Claude Code 的会话记录文件，同样完整，实时同步 |
| **镜像** | tmux 里别人/你手动起的 `tclaude` | 终端屏幕镜像（去色文本），没有工具详情和花费 |

### 一一对应

Web 建对话 → 后台起同名 tmux 会话 → 顶部显示 `终端: tmux attach -t <名字>`。
在任意终端（含 IDE 集成终端）敲这条命令，看到的就是同一个对话。

反向：终端里跑

```bash
node scripts/tc-run.js --name mytask --cwd /your/project --model claude-haiku-4-5
```

它会自动进 tmux 并把界面贴到当前终端，Web 侧栏随即出现 `mytask`，点一下接入。

### 同步链路

```
Web 输入框 → tmux send-keys 敲进 TUI → TUI 处理 → 写会话记录 → Web tail 到 → 显示
```

反过来，终端里敲的字也会立刻出现在 Web 上。

---

## 7. 终端界面：两种模式

原生 Claude Code 界面只在交互模式出现，而结构化事件流只在 `--print` 模式才有，**两者本来互斥**。
本项目用「读会话记录文件」绕开了这个限制：

| 模式 | 启动 | 终端里 | Web 里 |
| --- | --- | --- | --- |
| **原生 TUI（默认）** | `node scripts/tc-run.js --name x` | 原生 Claude Code 界面（logo、`❯`、spinner） | 完整结构化，实时同步 |
| 结构化 | `node scripts/tc-run.js --name x --structured` | 我们渲染的简化界面：`⏺ 工具名`、`⎿ 结果`、`✢ 思考`、`✓ 完成 · $花费` | 同上，**另有多余的花费/token 统计** |

取舍：原生 TUI 模式没有花费统计（`result` 事件只有结构化模式才有）。调试想盯成本就加 `--structured`。

> 斜杠命令（`/model` 等）只在原生 TUI 模式可用；结构化模式下会被当成普通消息发给模型。

---

## 8. 会话管理：三层结构

```
当前对话（运行中）
   │ 「结束」
   ▼
历史记录（刚关掉的）
   │ 「归档」              ← 只打标记，不动文件
   ▼
归档（折叠收纳）           ← 「移回历史」可退回
   │ 「删除文件」          ← 只有这一层删除才真删文件
   ▼
  没了
```

| 层 | 点击条目 | 条目按钮 |
| --- | --- | --- |
| 当前对话 | 在 Web 打开 | 复制终端命令 / 结束 / 删除（连记录一起删） |
| 历史记录 | 审视（只读渲染，不起进程） | 打开（新终端）/ 归档 |
| 归档（折叠） | 审视 | 打开（新终端）/ 移回历史 / 删除文件 |

归档标记存在 `<runDir>/archived.json`，只是一个 sessionId 列表。

---

## 9. 模型与成本

同一条请求（"只回复两个字：收到"）实测单次花费：

| 模型 | 单次花费 | 输入 token |
| --- | --- | --- |
| **`claude-haiku-4-5`** | **$0.005952** | 10 |
| `claude-deepseek-v4.1-flash[1m]` | $0.018553 | 2,011 |
| `claude-kimi-k3[1m]` | $0.027481 | 77 |
| `claude-hy3` | $0.086550 | 17,160 |
| `claude-glm-5.3-flash[1m]` | $0.092185 | 18,302 |
| `claude-opus-5-5[1m]` | $0.156476 | 4 |
| `claude-sonnet-5-5[1m]` | $0.233989 | 4 |

**调试和跑通用例一律用 `claude-haiku-4-5`**：单价最低，且输入 token 只有 10（其他模型每轮要背 1.7w 缓存写入）。
页面下拉框直接列出网关当前可用模型（读自 `~/.tclaude/cache/gateway-models.json`）。

### 对话进行中切换模型

页面上有**两个**模型下拉框，两者保持同步：

- **输入框右下角**：针对**当前对话**。选了之后会转成 `/model <名字>` 敲进终端，等价于你在终端里敲这条斜杠命令
- **左侧栏「模型」**：**新建对话**时用的默认值（有活动对话时也会一并切换当前对话）

不管改哪个，行为取决于会话模式：

| 模式 | 行为 |
| --- | --- |
| 原生 TUI / 镜像 | **就地生效** —— 发 `/model <name>` 斜杠命令，终端里能看到 `Set model to ...` |
| 结构化 | 不支持就地切换（CLI 的 stream-json 协议没有 `set_model` 指令），会提示**用新模型重开**：新起一个终端会话 `--resume`，上下文保留 |

### Web 上做成了 UI 控件的命令

| 控件 | 位置 | 转成什么命令 | 备注 |
| --- | --- | --- | --- |
| 模型 | 输入框右下 | `/model <名字>` | 另见上一节 |
| 思考强度 | 输入框右下 | `/effort <low\|medium\|high>` | 终端回显 `Set effort level to ...` |
| 压缩上下文 | 输入框上方 | `/compact` | 省 token |
| 清空 | 输入框上方 | `/clear` | 结构化模式下改为开全新对话 |
| 用量 | 输入框上方 | `/usage` | 弹出用量面板 |
| 诊断 | 输入框上方 | `/doctor` | 检查 CLI 环境 |
| 权限模式 | 左侧栏 | 见下 | **不是**斜杠命令，见下 |

**权限模式的特殊之处**：`/permission-mode` 并不是有效的斜杠命令（实测报 `unknown skill`），各模式走不同路径：

| 会话模式 | 切换方式 |
| --- | --- |
| 结构化 | `set_permission_mode` 控制指令，Web 直接生效 ✅ |
| 原生 TUI | 只能 **Shift+Tab** 循环（按键条上已提供该键），实测 `accept edits on` → `plan mode on` ✅ |
| 镜像 | 不支持，请在终端操作 |

### 在 Web 输入框里用斜杠命令

输入框里直接敲 `/model`、`/clear` 这类斜杠命令即可，行为取决于模式：

| 模式 | 行为 |
| --- | --- |
| 原生 TUI / 镜像 | **原样发给 TUI**，由它自己处理。`/model` 会弹出模型选择器，用按键条的 ↑ ↓ 选、Enter 或 `s` 确认 |
| 结构化 | CLI 在 `--print` 模式下不处理斜杠命令，故做等价映射：`/model <name>` → 用新模型 `--resume` 重开；`/clear` → 开全新对话；其它斜杠命令会提示不支持，避免被当成普通消息发给模型 |

> **关于 `s` 键**：`/model` 选择器里 `Enter` = 设为全局默认，`s` = 仅本次会话生效。
> 想避免动到全局默认就用 `s`。按键条上已提供。
> 另外 `/model <具体名字>`（带参数）会直接设置并同时改掉全局默认，这是 Claude Code 自身的行为。

---

## 10. 进阶配置

### 把日志/会话放到共享盘

```bash
export CLAUDE_CONFIG_DIR=/mnt/share/tclaude/config/$(hostname)   # 会话记录、日志、项目记忆
export CCWEB_RUN_DIR=/mnt/share/tclaude/ccweb                    # 本项目的事件流目录
```

`CLAUDE_CONFIG_DIR` 实测有效：设了之后 `init` 事件里 `memory_paths` 会直接指向新目录，登录态也正常携带。

> 每台机器用独立子目录：`daemon-port`、`locks/*` 是单机独占的，共用会抢锁。

### Subagent

在配置目录的 `agents/` 下放 markdown：

```
$CLAUDE_CONFIG_DIR/agents/xxx.md      # 全局（默认 ~/.tclaude/agents/）
<项目>/.claude/agents/xxx.md          # 仅当前项目
```

```markdown
---
name: ceph-helper
description: 负责在共享盘上查找和整理数据集
tools: Bash, Read, Glob, Grep
---

你是共享盘助手。查找数据只走挂载点，禁止用 du -sb 统计目录。
```

放好后跑一次，`init` 事件的 `agents` 列表里会多出 `ceph-helper`。

### 把 tclaude 整个装到共享盘

```bash
SAF=/mnt/share/tclaude
mkdir -p $SAF/bin $SAF/config/$(hostname)
cp ~/.local/bin/tclaude $SAF/bin/tclaude && chmod 755 $SAF/bin/tclaude

# ~/.bashrc
export PATH="$SAF/bin:$PATH"
export CLAUDE_CONFIG_DIR=$SAF/config/$(hostname)
export DISABLE_AUTOUPDATER=1     # 共用二进制时别让它自更新
```

实测可跑。注意：配置目录按机器分开、关自动更新、登录态跟配置目录走（每机各 login 一次）。

---

## 11. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | CLI、模型列表、默认参数 |
| GET | `/api/local-sessions` | 当前对话 / 历史记录 / 归档 / 可接管的 tmux tc |
| POST | `/api/local-sessions` | 新建本地会话（`name` `cwd` `model` `permissionMode` `resumeFrom`） |
| DELETE | `/api/local-sessions/:name` | 结束（归档）；`?purge=1` 彻底删除 |
| GET | `/api/history/preview` | 审视：`?sessionId=&cwd=` 只读返回记录 |
| POST | `/api/history/:id/archive` | 归档 / 取消归档（`{on:true}`） |
| DELETE | `/api/history/:id` | 删除归档（删文件），`?cwd=` |
| GET | `/api/sessions` | 已接入的会话列表 |
| POST | `/api/sessions` | 接入：`{source:{kind:'managed',name}}` / `{kind:'tui'...}` / `{kind:'mirror',tmuxTarget}` |
| GET | `/api/sessions/:id` | 详情 + 全量事件 |
| GET | `/api/sessions/:id/events` | SSE 事件流 |
| POST | `/api/sessions/:id/messages` | 发消息 |
| POST | `/api/sessions/:id/control` | 权限审批 |
| POST | `/api/sessions/:id/interrupt` | 中断 |
| POST | `/api/sessions/:id/keys` | 镜像/TUI 的按键（白名单） |
| DELETE | `/api/sessions/:id` | 断开绑定（不杀进程） |

---

## 12. 目录结构

```
ClaudeCodeWeb/
├── server.js              # 零依赖 HTTP 服务：静态页 + REST + SSE
├── src/
│   ├── config.js          # 环境变量、.env 加载、工作目录校验
│   ├── session.js         # 常驻 CLI 进程（结构化模式）+ 历史会话扫描
│   ├── local.js           # 本机 tc 发现、启动/结束、归档、删除
│   └── localSession.js    # 绑定已运行的 tc（managed / tui / mirror）
├── scripts/
│   ├── start.sh           # 自动探测 node 并启动
│   └── tc-run.js          # 终端里跑 tc 并与 Web 共享（默认原生 TUI）
├── public/                # 前端（无构建步骤）
├── .env.example
└── README.md
```

运行时数据：

```
<CCWEB_RUN_DIR>/           # 默认 ~/.cache/ccweb
├── <name>.jsonl           # 事件流（结构化模式）
├── <name>.fifo            # 输入管道
├── <name>.meta.json       # 元信息（mode / sessionId / startOffset …）
└── archived.json          # 归档标记
```

---

## 13. 安全

- 默认只监听 `127.0.0.1`；**`CCWEB_HOST=0.0.0.0` 但没设 `CCWEB_TOKEN` 时服务会拒绝启动**
- 令牌只保护 `/api/*`；静态资源不含秘密（否则 `?token=` 打开后 CSS/JS 会被 401，页面会变成裸 HTML）
- 工作目录会校验存在性，可配 `CCWEB_ALLOWED_ROOTS` 限制在指定目录内
- 静态资源做了目录穿越防护；页面所有模型输出先 HTML 转义再渲染
- `.env` 已被 `.gitignore` 忽略，**不要把令牌写进任何文档或提交到仓库**
- 这个服务本质上是让浏览器驱动一个**能执行命令的 AI 助手**，别开到公网或不受控的网络

---

## 14. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `tclaude: command not found` | `export PATH="$HOME/.local/bin:$PATH"` |
| 页面没样式、没脚本 | 版本太旧：令牌曾把 `/styles.css` 拦成 401。升级到含 `5ebfad2` 之后的版本，或重启服务 |
| 服务起不来，提示必须设 CCWEB_TOKEN | `CCWEB_HOST=0.0.0.0` 时必须有令牌，见第 4 节 |
| 新建对话带着上次的聊天记录 | 交互式 tc 会续接该目录最近会话（CLI 无 `--new`）。本项目启动后会自动发 `/clear`，若仍出现说明 `/clear` 没送达，重开对话 |
| 一条消息显示两遍 | 已修（`d7ad699`）：tui 模式不再本地补 user 事件 |
| 终端里看不到原生界面 | 用了 `--structured`，或没装 tmux |
| 列表里有「不可接管」的 tc | 它跑在普通终端而非 tmux。没有多路复用器就读不到已在运行进程的输出 |
| Web 上看不到花费 | 原生 TUI 模式下没有 `result` 事件，加 `--structured` |
| `[claude-code:unrecognized_model]` | 网关 `[1m]` 后缀导致的遥测告警，不影响使用 |
| 请求 429 | 上游容量问题，换模型或稍后重试 |
