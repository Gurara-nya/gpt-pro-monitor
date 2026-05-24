# GPT Pro Monitor

一个本地运行的 ChatGPT / Codex 用量监控面板，专注展示 5 小时窗口和每周窗口的剩余额度，并按时间保留每次同步记录。页面默认每 30 分钟查询一次。

## 功能

- 5 小时窗口与每周窗口的剩余、已用、重置时间
- 同步历史的日 / 周 / 月视图切换，支持上一天 / 周 / 月与下一天 / 周 / 月
- 历史状态点按时间排列，悬浮状态点可查看 5H 与 WEEK 的具体柱状数据
- 下方历史列表默认只显示 3 条，可手动展开
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
~/.codex/skills/codex-usage
```

在设置里的 `Codex Token` 区域可以调整数据库路径、skill 路径、高消耗会话数量，或关闭这个面板。点击页面里的“报告”按钮会生成完整 HTML 报告：

```text
output/codex-usage/latest.html
```

该目录已被 `.gitignore` 排除，不会进入公开仓库。

费用估算使用 OpenAI API Pricing 的标准输入 / 缓存输入 / 输出 token 价格。`state_5.sqlite` 仍只提供 `threads.tokens_used` 总量，面板会额外读取本机 rollout JSONL 里的 `token_count.total_token_usage`，优先按输入、缓存输入和输出拆分计算；拆分缺失时才回退到总 token 区间估算。该估算不是 OpenAI 账单，未计入 Batch、Regional、长上下文或工具费用差异。高消耗会话默认收起。

## 端点探测

只读探测一组 ChatGPT / OpenAI 端点的状态码和 JSON 字段结构：

```powershell
npm run probe:endpoints
```

输出会隐藏 token，只保留状态码、content-type、顶层字段和少量结构摘要。

## 验证

服务启动后运行：

```powershell
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
