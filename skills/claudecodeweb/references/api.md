# HTTP API 速查

基址 `$CCWEB_URL`，设了令牌就带 `Authorization: Bearer $CCWEB_TOKEN`
（也支持 `?token=`，EventSource 用得上）。静态资源不鉴权，`/api/*` 才鉴权。

## 服务与配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | CLI、模型列表、默认参数 |
| GET/PUT | `/api/settings` | `<config>/settings.json`（`permissions.allow/deny`、`model`） |
| GET/POST/DELETE | `/api/agents`〔`/:name`〕 | 子 agent（`<config>/agents/*.md`） |
| GET/POST | `/api/models/probe` | 模型权限探测（后台跑，GET 轮询） |

## 本机会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/local-sessions` | `active` / `history` / `archive` / `foreign`（可接管的 tmux tc） |
| POST | `/api/local-sessions` | 新建：`name` `cwd` `model` `permissionMode` `resumeFrom` `structured` |
| DELETE | `/api/local-sessions/:name` | 结束（进历史）；`?purge=1` 彻底删除 |
| GET | `/api/history/preview?sessionId=&cwd=` | 审视（只读返回记录） |
| POST | `/api/history/:id/archive` | 归档 / 取消归档 `{on:true}` |
| DELETE | `/api/history/:id?cwd=` | 删除归档（删文件） |

## 已接入的会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sessions` | 列表 |
| POST | `/api/sessions` | 接入：`{source:{kind:'managed',name}}` / `{kind:'mirror',tmuxTarget}` |
| GET | `/api/sessions/:id` | 详情 + 全量事件 |
| GET | `/api/sessions/:id/events` | SSE 事件流 |
| POST | `/api/sessions/:id/messages` | 发消息 `{text}` |
| POST | `/api/sessions/:id/model` | 切模型（TUI 发 `/model`；结构化需重开） |
| POST | `/api/sessions/:id/plan-mode` | 进入/退出计划模式 `{on}` |
| POST | `/api/sessions/:id/permission-mode` | 改权限模式（结构化走指令，TUI 需 Shift+Tab） |
| POST | `/api/sessions/:id/control` | 权限审批 `{requestId, behavior}` |
| POST | `/api/sessions/:id/interrupt` | 中断 |
| POST | `/api/sessions/:id/keys` | 按键（白名单：`Up / Down / Enter / Escape / Tab / BTab / s / y / n / C-c …`） |
| DELETE | `/api/sessions/:id` | 断开绑定（不杀进程） |

## 事件类型（前端据此渲染）

| type | 含义 |
| --- | --- |
| `user` | 用户消息；`content` 里的 `tool_result` 是工具结果 |
| `assistant` | 助手消息；`content` 含 `text` / `thinking` / `tool_use` |
| `result` | 一轮结束：`total_cost_usd`、`duration_ms`、`usage` |
| `system` + `subtype:'init'` | 会话初始化：`model`、`tools`、`agents`、`slash_commands` |
| `control_request` | 权限确认（`can_use_tool`；`ExitPlanMode` = 计划审批） |
| `ccweb` + `subtype:'terminal'` | 镜像模式的终端文本 |

> 原生 TUI 模式读的是 Claude Code 的会话记录文件，**没有 `result` 事件**，所以看不到花费。
