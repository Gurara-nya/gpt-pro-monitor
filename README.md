# GPT Pro Monitor

一个本地运行的 ChatGPT / Codex 用量监控面板，按上游返回的真实持续时间展示当前额度窗口，并按时间保留每次同步记录。页面默认每 30 分钟查询一次。

## 功能

- 动态额度窗口的剩余、已用、重置时间（当前有什么窗口就显示什么）
- 同步历史的日 / 周 / 月视图切换，支持上一天 / 周 / 月与下一天 / 周 / 月
- 配额窗口按上游返回的真实持续时间动态识别；历史状态点保留当时存在的全部窗口数据
- 下方历史列表默认只显示 3 条，可手动展开
- Codex Token 会话管理，支持分页搜索所有本机会话，并查看输入 / 缓存输入 / 输出 Token 与费用估算
- 多用户用量数据管理：账号与额度仍共用同一个 ChatGPT/Codex 登录，消耗仪表盘和会话管理按数据用户切换
- 单账号多设备池：本机作为内置设备，其他电脑通过独立采集令牌只同步哈希化用量 telemetry
- 当前订阅套餐类型展示在标题区域
- 默认只监听 `127.0.0.1`，公网模式需要访问密钥

## 快速启动

```powershell
npm install
npm start
```

默认地址：

```text
http://127.0.0.1:8787
```

服务会读取本机 Codex 登录文件：

```text
~/.codex/auth.json
```

并查询：

```text
https://chatgpt.com/backend-api/wham/usage
```

历史数据保存在 `data/checks.json`。`data/` 已被 `.gitignore` 排除，不会进入公开仓库。

## 公网部署

公开端口前务必设置访问密钥。服务在监听非本地地址时，如果没有密钥会拒绝启动。

生成密钥：

```powershell
npm run secret
```

启动公网监听：

```powershell
$env:GPT_MONITOR_HOST = "0.0.0.0"
$env:GPT_MONITOR_ACCESS_TOKEN = "<上一步生成的长密钥>"
npm start
```

浏览器会弹出 Basic Auth 登录框：

```text
用户名：monitor
密码：GPT_MONITOR_ACCESS_TOKEN 的值
```

可选配置：

```powershell
$env:GPT_MONITOR_USERNAME = "your-name"
$env:GPT_MONITOR_PORT = "8787"
$env:GPT_MONITOR_BASE_PATH = "/monitor"
```

建议在公网前再套一层 HTTPS 反向代理，例如 Caddy、Nginx 或 Cloudflare Tunnel。不要把 `~/.codex/auth.json`、`.env`、`data/` 或任何 token 提交到 GitHub。

## 使用 cpolar 穿透

cpolar 客户端运行在同一台电脑上时，服务可以继续只监听本机地址。推荐这样启动监控服务：

```powershell
$env:GPT_MONITOR_ACCESS_TOKEN = "<用 npm run secret 生成的长密钥>"
npm start
```

然后另开一个终端创建 HTTP 隧道：

```powershell
cpolar http 8787
```

如果公网地址挂在子路径下，例如 `https://llgai.cpolar.top/monitor`，启动服务前同时设置：

```powershell
$env:GPT_MONITOR_BASE_PATH = "/monitor"
```

cpolar 输出里的 `Forwarding` 地址就是公网访问地址。用其他电脑或手机访问这个 `https://...cpolar...` 地址时，浏览器会弹出登录框：

```text
用户名：monitor
密码：GPT_MONITOR_ACCESS_TOKEN 的值
```

如果你配置了 cpolar 固定域名或后台隧道，目标仍然指向本机 `8787` 端口即可。

## 安全措施

- 默认只绑定 `127.0.0.1`
- 公网监听必须配置 `GPT_MONITOR_ACCESS_TOKEN` 或 `GPT_MONITOR_PASSWORD`
- 全站 Basic Auth，API 也支持 `Authorization: Bearer <token>`
- 对非 GET 请求做同源校验，降低跨站请求风险
- 内置简单限流，刷新接口限流更严格
- 添加 CSP、`X-Frame-Options`、`nosniff`、`Referrer-Policy` 等安全响应头
- 移除第三方 CDN 脚本，前端静态资源只从本站加载
- 用量接口限定为 `https://chatgpt.com/backend-api/wham/usage`
- 服务不会向页面、日志或导出文件写入 access token / refresh token

## 手动查询

```powershell
npm run codex:usage
```

## Codex Token 面板

首页会额外读取本机 Codex SQLite 状态库，展示累计 Token、本月 Token、费用估算、日消耗、来源、模型和高消耗会话。默认路径：

```text
~/.codex/state_5.sqlite
```

Codex 用量统计脚本已内置在本项目的 `scripts/codex-usage/` 下，不再依赖本机 `~/.codex/skills/codex-usage`。在设置里的“用户数据”区域可以为当前数据用户调整数据库路径、上传 `state_5.sqlite`、设置高消耗会话数量，或关闭这个用户的 Token 面板。点击页面里的“报告”按钮会生成完整 HTML 报告：

```text
output/codex-usage/<用户ID>/latest.html
```

该目录已被 `.gitignore` 排除，不会进入公开仓库。

API 等价成本估算使用带版本日期的 OpenAI 输入 / 缓存输入 / 输出 Token 价格，也可在设置中按模型和生效日期覆盖。面板流式读取 rollout JSONL 中逐次累计的 `token_count.total_token_usage`，按相邻累计值的正向差值去重，并将消耗归入事件发生时的日期和模型；`state_5.sqlite` 的 `threads.tokens_used` 作为对账总量，缺失拆分的部分按模型生成区间估算。GPT-5.6 会应用超过 272K 输入的长上下文倍率。该结果不是 ChatGPT 套餐账单，也无法识别缓存写入、工具费或其他特殊计费。“消耗仪表盘”分为“概览 / 会话”两个标签；会话标签按需加载，支持标题、ID、目录、模型和来源搜索以及服务端分页。

内置 GPT-5.6 价格目录版本为 `2026-07-14`（输入 / 缓存输入 / 输出，USD / 1M Token）：[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 为 `$5 / $0.5 / $30`，[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) 为 `$2.5 / $0.25 / $15`，[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) 为 `$1 / $0.1 / $6`。

## 多设备采集

中心服务会自动把当前主机登记为内置设备。要接入其他电脑，在设置的“远端设备采集”中创建设备并立即保存一次性命令；服务端只保存令牌摘要。远端运行仓库根目录的 `device-agent.js`，首次扫描全部 SQLite / rollout 历史，之后按本地文件偏移增量读取，默认每 15 分钟同步，每批最多 500 个事件。

“消耗仪表盘”的设备占比与月份选择器联动：每个月分别按总 Token 计算设备占比，同时展示该月输入、缓存输入、输出、API 等价成本及成本占比、拆分覆盖率；切换月份不会混入其他月份或累计数据。

采集数据严格限定为设备 ID、不可逆线程哈希、事件哈希、时间、模型、Token 拆分与 SQLite 总量快照，不包含标题、目录、来源、提示词、回复或代码。线程哈希与累计 Token 状态共同生成设备无关的事件 ID，因此复制到多台设备的 rollout 只统计一次；同一线程在另一台设备继续产生的新累计状态仍归属新设备。采集令牌和游标保存在远端用户目录的 `~/.gpt-monitor/`，不会写入仓库。

中心仍默认只监听 `127.0.0.1`。如通过自有转发服务接入，请设置 `GPT_MONITOR_PUBLIC_URL`，生成的接入命令会使用该 HTTP/HTTPS 地址；本项目不负责部署或维护转发服务。

页面上方的账号与动态额度窗口仍来自同一个 ChatGPT/Codex 登录；只有“消耗仪表盘”和“会话管理”会按数据用户切换。默认数据用户是 `Gurara`，旧的全局 Codex SQLite 与 Sub2API 配置会自动迁移到这个用户。其他用户可以在设置中新增，再分别上传 SQLite 和保存 Sub2API API key。

Sub2API 按数据用户配置 API key，默认 Gurara 兼容旧的 `data/sub2api.key`。保存 key 后会写入 `data/users/<用户ID>/sub2api.key`，并调用 `/v1/usage` 合并按天 / 模型统计。如果额外配置 `SUB2API_ADMIN_EMAIL` 和 `SUB2API_ADMIN_PASSWORD`，面板会登录 Sub2API 后台并把 `/admin/usage` 的请求级明细加入会话管理；未配置后台账号时，会退回展示按天 / 模型聚合的 Sub2API 统计行。

消耗仪表盘和会话管理使用本地缓存：进入网页时只读取 `data/users/<用户ID>/codex-usage-cache.json`，不会自动重新统计 SQLite 或重新拉取 Sub2API。后台服务每 6 小时检查并刷新一次过期缓存；点击刷新、上传 SQLite、保存 API key 或生成报告也会重建当前用户缓存。

概览接口 `/api/codex-usage` 不返回完整会话数组；会话明细通过 `/api/codex-usage/sessions` 获取，支持 `userId`、`q`、`month`、`sort`、`page` 和 `pageSize` 参数，其中单页最多 50 条。`/api/export` 仍保留完整同步历史。

## 端点探测

只读探测一组 ChatGPT / OpenAI 端点的状态码和 JSON 字段结构：

```powershell
npm run probe:endpoints
```

输出会隐藏 token，只保留状态码、content-type、顶层字段和少量结构摘要。

## 验证

服务启动后运行：

```powershell
npm test
npm run smoke
```

如果服务启用了访问密钥，运行验证前使用相同环境变量：

```powershell
$env:GPT_MONITOR_ACCESS_TOKEN = "<你的密钥>"
npm run smoke
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_MONITOR_HOST` | `127.0.0.1` | 监听地址；公网可设为 `0.0.0.0` |
| `GPT_MONITOR_PORT` | `8787` | 监听端口 |
| `GPT_MONITOR_ACCESS_TOKEN` | 空 | 公网访问密钥；非本地监听时必填 |
| `GPT_MONITOR_PASSWORD` | 空 | 可替代 `GPT_MONITOR_ACCESS_TOKEN` |
| `GPT_MONITOR_USERNAME` | `monitor` | Basic Auth 用户名 |
| `GPT_MONITOR_RATE_LIMIT_MAX` | `240` | 每分钟普通请求限流 |

## 说明

这是基于当前 ChatGPT / Codex 网页后端返回结构的本地监控工具。如果 OpenAI 调整接口字段或鉴权策略，可能需要同步更新解析逻辑。
