# ClaudeCodeWeb

把 **tclaude / claude code CLI** 接到浏览器里用。不用一直盯着终端，聊天记录、工具调用、权限审批、花费统计都在网页上。

`tc` = `tclaude`（腾讯内部 Claude Code 封装，`@anthropic-ai/claude-code` 内核）；`cc` = 官方 `claude` CLI。两者协议一致，本项目通过 `CCWEB_CLI` 切换。

零第三方依赖，只需要 **Node >= 18**。

## 特性

- **常驻进程 + 双向流式协议**：用 `--input-format stream-json --output-format stream-json --verbose`，一个会话一个进程，连续多轮共用上下文，不用每条消息重启 CLI
- **实时推送**：后端解析 CLI 的 JSON 事件流，通过 SSE 推到页面
- **工具调用可视化**：`tool_use` / `tool_result` 渲染成卡片，输入参数和执行结果都看得到
- **思考过程折叠**：thinking 块默认收起
- **权限审批**：CLI 发来 `control_request(can_use_tool)` 时页面弹出「允许 / 拒绝」，回写 `control_response`
- **中断**：随时 Stop，发 `control_request(interrupt)`
- **会话续聊**：列出 `~/.tclaude/projects/<项目>/*.jsonl` 的历史会话，点一下用 `--resume` 接着聊
- **花费统计**：每轮结束后显示 cost / tokens / 耗时（取自 `result` 事件）

## 快速开始

```bash
cd ClaudeCodeWeb
./scripts/start.sh
# 打开 http://127.0.0.1:18787
```

或者：

```bash
node server.js          # 默认 127.0.0.1:18787
CCWEB_PORT=9000 node server.js
```

启动前确保 CLI 已登录：

```bash
tclaude login        # tclaude：OA 浏览器登录
tclaude daemon status
```

## 调试请务必用最便宜的模型

同一条请求（"只回复两个字：收到"）实测单次花费：

| 模型 | 单次花费 | 输入 token | 备注 |
| --- | --- | --- | --- |
| **`claude-haiku-4-5`** | **$0.005952** | 10 | **最便宜，调试默认** |
| `claude-deepseek-v4.1-flash[1m]` | $0.018553 | 2,011 | |
| `claude-kimi-k3[1m]` | $0.027481 | 77 | |
| `claude-hy3` | $0.086550 | 17,160 | |
| `claude-glm-5.3-flash[1m]` | $0.092185 | 18,302 | |
| `claude-opus-5-5[1m]` | $0.156476 | 4 | |
| `claude-sonnet-5-5[1m]` | $0.233989 | 4 | 最贵 |

`claude-haiku-4-5` 不仅单价最低，输入 token 也最少（不背 18k 的缓存写入），**调试和跑通用例一律用它**。需要更强能力时在页面右上切换模型即可。

页面下拉框会直接列出网关当前可用模型（读自 `~/.tclaude/cache/gateway-models.json`）。

## 配置

复制 `.env.example` 为 `.env` 后按需修改，或直接设环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CCWEB_HOST` | `127.0.0.1` | 监听地址 |
| `CCWEB_PORT` | `18787` | 端口 |
| `CCWEB_TOKEN` | 空 | 设置后所有接口都要带 token（含 SSE 的 `?token=`） |
| `CCWEB_CLI` | `tclaude` | 要接的 CLI，可改 `claude` |
| `CCWEB_MODEL` | `claude-haiku-4-5` | 默认模型（最便宜） |
| `CCWEB_CWD` | 进程 cwd | 默认工作目录 |
| `CCWEB_PERMISSION_MODE` | `acceptEdits` | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `CCWEB_ALLOWED_ROOTS` | 空 | 限制会话只能在这些目录下，`:` 分隔 |
| `CCWEB_READ_ONLY` | `0` | 设为 `1` 禁止新建会话和发消息 |
| `TCLAUDE_HOME` | `~/.tclaude` | tclaude 配置目录 |

`.env` 不会被自动加载，用 `set -a && . ./.env && set +a && node server.js` 手动引入。

## 安全

- 默认只监听 `127.0.0.1`；**要对外暴露必须设 `CCWEB_TOKEN`**
- 会话工作目录会校验存在性，可配 `CCWEB_ALLOWED_ROOTS` 白名单限制在指定目录内
- 静态资源做了目录穿越防护
- 页面所有模型输出先 HTML 转义再渲染，不执行富文本
- **这个服务本质上是让浏览器能驱动一个可执行命令的 AI 助手**，不要开到公网或不受控的网络

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | CLI、模型列表、默认参数 |
| GET | `/api/history?cwd=` | 可续聊的历史会话 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 新建（`cwd` `model` `permissionMode` `resumeFrom`） |
| GET | `/api/sessions/:id` | 会话详情 + 全量事件 |
| GET | `/api/sessions/:id/events` | SSE 事件流 |
| POST | `/api/sessions/:id/messages` | 发消息 |
| POST | `/api/sessions/:id/control` | 权限审批（`requestId` `behavior`） |
| POST | `/api/sessions/:id/interrupt` | 中断当前轮次 |
| POST | `/api/sessions/:id/permission-mode` | 运行时改权限模式 |
| DELETE | `/api/sessions/:id` | 结束会话 |

## 目录结构

```
ClaudeCodeWeb/
├── server.js           # 零依赖 HTTP 服务：静态页 + REST + SSE
├── src/
│   ├── config.js       # 环境变量、网关模型列表、工作目录校验
│   └── session.js      # 常驻 CLI 进程 + stream-json 协议 + 历史会话
├── public/
│   ├── index.html
│   ├── app.js          # SSE 订阅、事件流 -> 渲染块
│   └── styles.css
├── scripts/start.sh    # 自动探测 node 并启动
├── .env.example
└── README.md
```

## 已知行为

- 启动时会有一条 `[claude-code:unrecognized_model]` 的 stderr 提示，是 Claude Code SDK 不认识网关 `[1m]`（1M 上下文）后缀产生的遥测告警，请求本身正常，可忽略
- CLI 进程随会话存在，页面刷新后重新连接会重放该会话已缓存的事件（上限 4000 条）
