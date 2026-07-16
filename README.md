# GPT Pro Monitor

一个本地运行的 ChatGPT / Codex 用量监控面板，按上游返回的真实持续时间展示当前额度窗口，并按时间保留每次同步记录。页面默认每 30 分钟查询一次。

## 功能

- 动态额度窗口的剩余、已用、重置时间（当前有什么窗口就显示什么）
- 同步历史的日 / 周 / 月视图切换，支持上一天 / 周 / 月与下一天 / 周 / 月
- 配额窗口按上游返回的真实持续时间动态识别；历史状态点保留当时存在的全部窗口数据
- 下方历史列表默认只显示 3 条，可手动展开
- Codex Token 会话管理，支持分页搜索所有本机会话，并查看输入 / 缓存输入 / 输出 Token、Fork 净用量与费用估算
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

API 等价成本使用带版本日期的 OpenAI 输入 / 缓存输入 / 输出 Token 价格，也可在设置中按模型和生效日期覆盖。面板流式读取 rollout JSONL 中逐次累计的 `token_count.total_token_usage`，按相邻累计值的正向差值去重，并将消耗归入事件发生时的日期和模型；`state_5.sqlite` 的 `threads.tokens_used` 作为对账总量。GPT-5.6 会应用超过 272K 输入的长上下文倍率。

当所选范围内的未缓存输入、缓存输入、输出均已拆分，并且对应模型、日期和长上下文倍率都有价格时，三项费用可直接相加，面板显示“**确定值**”，此时区间上下界相同。推理输出是输出 Token 的子集，只展示、不重复计费。只有缺失 rollout 拆分、模型价格或其他计价条件时，缺口才显示为“混合估算”“估算区间”或“未定价”；数据审计区会同时给出拆分覆盖率、已定价覆盖率、未拆分 Token 与未定价 Token。所有金额仍是 **API 等价成本**，不是 ChatGPT 套餐账单，也不包含无法识别的缓存写入、工具费或其他特殊计费。

“消耗仪表盘”分为“概览 / 会话”两个标签；会话标签按需加载，支持标题、ID、目录、模型和来源搜索以及服务端分页。概览里的日消耗趋势与月份选择器联动，亮色实线始终表示所选范围的合计，多设备时叠加每台设备的虚线。纵轴可切换总 Token、未缓存输入、缓存输入、输出 Token 和 API 等价成本；合计线、设备线、纵轴刻度、峰值与近 14 天摘要使用同一指标和同一尺度，空缺日期按 0 计。

内置 GPT-5.6 价格目录版本为 `2026-07-14`（输入 / 缓存输入 / 输出，USD / 1M Token）：[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 为 `$5 / $0.5 / $30`，[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) 为 `$2.5 / $0.25 / $15`，[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) 为 `$1 / $0.1 / $6`。

### Token 净用量与数据审计

Fork、新分支和子任务会复制父会话已经累计的 Token 历史。如果直接累加每个线程，会把同一段上下文重复统计。Monitor 会按父线程血缘和累计 Token 状态识别完全一致的共享前缀，只扣除继承历史，保留分叉后新产生的输入、缓存输入与输出。

仪表盘的数据审计区同时展示三组可对账指标：

- **原始 Token**：SQLite 与 telemetry 记录的线程累计总量，尚未扣除继承历史。
- **已扣除共享历史**：父线程与 Fork 完全一致的累计状态前缀。
- **净 Token**：`原始 Token - 已扣除共享历史`，日报、月报、设备占比和 API 等价成本统一按净值计算。

分叉后的新增状态仍归入实际发生日期与对应设备，不会因为属于 Fork 就忽略整条会话。若日量异常高，先检查数据审计区的三项数值，并确认所有远端设备均已升级到 Agent 2.1.1、完成一次完整同步。

Monitor 的默认 Fork 规则兼顾自动去重与人工复核：

- 显式父会话连续匹配至少 2 个累计状态时，自动排除该段共享历史；子会话从父会话中段开始也能识别。
- 只有 1 个共同状态，或父关系只能通过精确前缀推断时，“辅助审批（推荐）”模式会先保留计入并标为待审批。
- 没有共同累计状态、父记录缺失或存在循环关系时不会猜测扣除，并显示为无法自动验证。
- 选择“高置信自动应用”后，精确前缀推断也可按规则自动排除；已经保存的人工决定优先于自动规则。

需要人工处理时，进入“**设置 → Fork 审批**”，先核对父子会话、候选共享 Token、连续状态数、父事件偏移和分支净新增量，再选择：

1. **确认排除**：确认属于继承历史，将候选共享 Token 从统计中扣除。
2. **保留计入**：认为它是独立消耗或证据不足，不做扣除；若此前已扣除，会在确认后加回。
3. **恢复规则**：删除该条人工决定，重新按当前“辅助审批 / 高置信自动应用”规则判断。

每次操作都会重建当前数据用户的用量缓存，并同步更新日报、月报、设备占比和费用。人工审批不会读取提示词、回复或代码正文。

## 多设备采集

中心服务会自动把当前主机登记为内置设备。远端电脑只需要 Node.js 22 或更高版本，不需要克隆仓库、手工创建计划任务或填写 API：

1. 管理员进入“设置 → 远程设备”，填写名称并点击“添加设备”。
2. 选择 Windows PowerShell 或 Linux / macOS，复制生成的一键安装命令。
3. 远程用户在运行 Codex 的同一系统账号下执行命令；Windows 命令必须在 PowerShell 运行。等待设置页显示“接入成功 / 自动运行”。

命令会自动下载采集器、保存该设备的专用令牌、同步历史并配置当前用户的自启动。接入命令包含一次性显示的设备令牌，只应私下交给对应设备使用者，不能粘贴到聊天、工单、日志或仓库。命令遗失时使用设备卡的“重新接入”；这会轮换令牌并立即废止旧令牌。

Monitor 顶栏的“?”会打开远程接入帮助页；也可直接访问 `/help`。帮助页提供新设备接入、Agent 更新、状态检查、立即同步、卸载、特殊 Codex 目录、Linux linger、手动 SQLite 快照、Token 审计口径、隐私边界与排障说明。设备设置面板会自动等待首次同步，并显示采集器版本、系统、自启动状态和最近同步结果。

### 已有设备升级到 Agent 2.1.1

所有已接入的远端设备都需要重新运行设置页生成的一键命令：在设备卡点击“重新接入”，选择远端系统，复制新命令并在原设备的原系统用户下执行。不能只运行 `--once` 完成版本升级。

Agent 2.1.1 会先把采集器原子写入 `~/.gpt-monitor/device-agent.js`，再执行耗时的首次同步，避免同步中断后没有本地程序可供重试。从 2.0 或更早版本升级时会**完整重扫一次** SQLite / rollout 历史，以补齐不可逆父线程哈希和累计 Token 状态；已经完成 2.1 血缘重扫的设备会保留现有游标。重扫批次是幂等的，不会把同一事件重复计量；完成后仍按本地文件偏移增量读取，默认每 15 分钟同步，不会反复全量扫描。

下列维护命令仅在设备卡已经显示“自动运行”后使用。如果 `device-agent.js` 不存在，说明安装尚未完成，请在设备卡点击“继续安装”，不要手工猜路径。

Windows PowerShell：

```powershell
node (Join-Path $HOME '.gpt-monitor\device-agent.js') --status
node (Join-Path $HOME '.gpt-monitor\device-agent.js') --once
node (Join-Path $HOME '.gpt-monitor\device-agent.js') --uninstall
```

Linux / macOS：

```bash
node "$HOME/.gpt-monitor/device-agent.js" --status
node "$HOME/.gpt-monitor/device-agent.js" --once
node "$HOME/.gpt-monitor/device-agent.js" --uninstall
```

同步失败会按 1、5、15 分钟自动重试，连续 45 分钟未成功同步会显示“数据过期”。首次安装或从 2.0 及更早版本升级时扫描全部 SQLite / rollout 历史；已完成 2.1 血缘扫描的设备沿用增量游标。之后默认每 15 分钟同步，每批最多 500 个事件。服务端始终只保存令牌摘要。

“消耗仪表盘”的设备占比与月份选择器联动：每个月分别按总 Token 计算设备占比，同时展示该月输入、缓存输入、输出、API 等价成本及成本占比、拆分覆盖率；切换月份不会混入其他月份或累计数据。

采集数据严格限定为设备 ID、采集器版本、操作系统与同步状态、不可逆线程哈希 / 父线程哈希、事件哈希、时间、模型、Token 拆分、累计 Token 状态与 SQLite 总量快照，不包含标题、目录、来源、提示词、回复、代码、工作路径或 Monitor 登录密码。线程哈希与累计 Token 状态共同生成设备无关的事件 ID，因此复制到多台设备的 rollout 只统计一次；同一线程在另一台设备继续产生的新累计状态仍归属新设备。升级时会先保留当前已有的本机归属；归属表建立后，新事件固定归给中心首次观察到它的设备，之后复制 rollout 不会改写设备占比。采集令牌和游标保存在远端用户目录的 `~/.gpt-monitor/`，不会写入仓库。

中心仍默认只监听 `127.0.0.1`。如通过自有转发服务接入，请把 `GPT_MONITOR_PUBLIC_URL` 设置为远端设备实际可访问的完整 Monitor 根地址，例如 `https://example.com/monitor`；生成命令会保留该子路径且不会重复拼接 `/monitor`。未配置时会沿用当前网页请求实际命中的根路径。本项目不负责部署或维护转发服务。

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
| `GPT_MONITOR_PUBLIC_URL` | 空 | 设备采集器可访问的公网 HTTP/HTTPS 根地址，用于生成接入命令 |

## 说明

这是基于当前 ChatGPT / Codex 网页后端返回结构的本地监控工具。如果 OpenAI 调整接口字段或鉴权策略，可能需要同步更新解析逻辑。
