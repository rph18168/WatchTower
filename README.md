# WatchTower

按可配置的关注主题读取 Hacker News 候选帖子，将相关内容整理成中文摘要并保存到 SQLite。Markdown 是从已保存摘要生成的阅读副本。

当前代码包括候选采集、摘要、来源核实、动态归并、Telegram 本人控制、用量预算、静默时段、投递重试和近期恢复。主要业务均通过完整周期与真实 SQLite 离线验证；[T10 / #11](https://github.com/rph18168/WatchTower/issues/11) 的真实部署验收已通过，版本、收据与恢复证据见[验收运行手册](docs/live-acceptance.md)。

GitHub Actions 的手动真实运行和无人值守定时运行分别由显式开关保护，未配置时均关闭。本仓在 2026-11-01 已完成真实 GLM 摘要与新 runner 的本人 `/digest` 回复；维护者于 `08:09:35.371Z` 开启定时变量，随后自然 [schedule 41313205828](https://github.com/rph18168/WatchTower/actions/runs/41313205828) 的完整周期于 `13:51:12Z` 成功完成。手动、定时开关均保持 true；先前未产生自然事件的原因仍未确定。手动入口还有仅处理本人 Telegram 命令的 `commands` 模式，可在新 runner 中查询持久摘要而不调用模型。约 15 分钟调度采用 best effort；部署、调度限制、状态备份及恢复见[部署说明](docs/deployment.md)。

## 环境与验证

- Node.js 24.15.0 或更高版本；SQLite 使用内置 `node:sqlite`。
- `npm ci`
- `npm test`
- `npm run typecheck`
- `npm run build`

测试通过同一个 `runCycle` 入口使用真实临时 SQLite、可控时钟以及 HN/模型/Telegram/GitHub 外部适配器。协议测试使用真实 Agent SDK 与可控 SSE 响应；公开状态测试检查实际上传的 SQLite 二进制和旧删除页残留。全部测试无需外部网络、API 凭据或付费调用。

依赖已固定并提交 lockfile：`@openrouter/agent 0.11.0`、`@openrouter/sdk 0.13.7`、`zod 4.6.7`、`htmlparser2 10.0.0`、`undici 7.30.1`；开发工具为 TypeScript 7.0.2 与 Node 类型 24.19.2。基础 SDK 同时通过 override 固定，防止 Agent 的版本范围改变已核对的调用行为。

## 关注主题配置

修改根目录的 `watchtower.config.json`。每个主题有唯一 `id` 和描述兴趣的 `description`；支持多个不同领域的主题，不需要通知条件或领域专属字段。默认 AI 主题只是可替换示例。`model` 为 OpenRouter 模型标识，当前按使用者选择设为 `z-ai/glm-5.3-flash`，已有真实 generation 收据、持久摘要及新 runner 的本人 `/digest` 回复确认，见[实际记录](docs/live-acceptance.md)。切换模型不构成先前失败的根因证据，也不会清除历史未知费用保护。

每个完整周期重新读取配置；已保存的运行状态不会覆盖新配置。历史摘要继续保留，新的待处理候选按当前主题判断。

`usage` 配置项目共用月预算、本轮费用阈值、实际模型请求步数、输入字节和输出 token 上限。默认月预算 US$10，UTC 自然月重置。预算暂停仍保留候选；未知费用阻止后续付费工作。字段、暂停原因及账单边界见[模型用量控制](docs/usage-controls.md)。

## 人工执行一次完整周期

在进程环境中提供 `OPENROUTER_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和 `TELEGRAM_USER_ID`，不要写入版本管理中的文件。构建后使用显式的付费操作开关：

```powershell
npm start -- --allow-paid-model
```

可选参数为 `--config <路径>`、`--state <SQLite路径>` 和 `--digest <Markdown路径>`；默认输出位于被 Git 忽略的 `.watchtower/`。`--github-state` 使用 `GITHUB_TOKEN` / `GITHUB_REPOSITORY` 读取和保存同仓快照，可用 `--state-branch <分支>` 改变默认 `watchtower-state`。`--allow-paid-model` 表示人工启用真实模型工作，实际请求仍受应用和 provider 额度约束。也可用 `--commands-only` 仅处理 Telegram 操作，无需模型 key；两个开关均不提供时退出且不发起网络请求。

Telegram 提供本人私聊的 `/digest`、`/status`、`/pause` 和 `/resume`。每个周期优先读取操作，暂停后仍能回复与恢复；夜间查询不受主动通知时段限制。预算不足会排入去重的运行报告；命令处理、身份边界、游标恢复和 24 小时未读更新边界见 [Telegram 控制说明](docs/telegram-controls.md)。

同一动态合并的来源过多时，主动通知保留正文与可容纳的完整原文、HN 讨论链接，并提示通过 `/digest` 查阅完整来源；摘要与持久状态保留全部来源。

应用的业务入口为 `runCycle({ loadConfig, state, hn, model, clock? })`，返回保存后的 `digest`、`markdown`、候选处理数量 `status` 及本轮 `usage`。`StateStore.load()` / `save()` 都是异步契约，`save` 只有在持久化完成后才应成功返回；SQLite 适配器还提供 `close()`。远端快照适配器可在这一存储 seam 延续持久化契约，无需再暴露每个业务步骤。

HN 适配器使用 [Algolia HN 搜索协议](https://hn.algolia.com/api)，固定本轮上界，回看 48 小时、初始至少 20 分，读取所有可用分页并按帖子 ID 合并；如果服务端结果总数超出可用页面，显式失败，不把截断结果当作完整采集。摘要依据 HN 材料，保存原文与 HN 讨论入口；拟议重大动态还须读取经网络地址校验的原文并核对关键事实，证据不足保留为摘要。正文仅用于当轮内存；待处理 HN 正文可由本轮发现结果或[官方 HN item API](https://github.com/HackerNews/API#items)重新取得。

模型适配器使用 [OpenRouter 结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)，传入主题和候选，要求通用中文摘要、本地校验候选/主题 ID 和基本中文内容。单次响应不授予工具权限；`provider.requireParameters=true`，输出 token 使用本轮配置（默认 4096），超时 60 秒，传输重试关闭，`allowFinalResponse=false`、`store=false`。真实 GLM 手动和定时周期均沿用这些参数，实际收据见[验收记录](docs/live-acceptance.md)。

`usage.costUsd` 允许为空；`costComplete` 说明费用是否完整，费用缺失不能解释为免费。SDK 完整响应后读取累计 usage；传输失败时只携带已收到的允许字段回执并标记不完整，不把原始 SDK 错误写入日志。

## 持久状态与恢复

SQLite 事务保存候选元数据与内容指纹、处理进度、主题关联、摘要、已验证的证据 checkpoint、费用和投递确认。公开状态不保存 HN／原文正文或逐字引文；证据以来源定位和 hash 续接，不能从 hash 还原历史正文。模型摘要须简洁且用自己的话表达。首次巡检建立最近 48 小时的初始基线和摘要，不推历史通知；故障或预算恢复按同一窗口继续，并以有界批次跨周期推进。已有摘要、动态去重与发送确认继续有效。没有待处理模型工作时不调用模型。原材料重取、基线续接、来源重试和汇总过期处理见[恢复说明](docs/recovery.md)。

SQLite 使用 DELETE journal、FULL synchronous 和安全清理，保存后重建数据库文件，避免旧正文留在空闲页。本地模式重新打开同一路径可继续运行；GitHub 模式每次从状态分支固定 SHA 恢复，再通过 `expectedHeadOid` 检测过期版本，且每次 `save()` 都等待远端提交。删除 Markdown 后，下次成功周期会从 SQLite 再生成它。本地模式须独占数据库；远端写者还须共享工作流串行约束。

不要将 API key 或本人身份放入配置、SQLite 或日志。公开分支的旧提交不会因新快照精简而消失；本实现不自动重写 Git 历史。真实验收记录须区分 Telegram API 接受、本人可见确认，以及尚未自然发生的主动新闻路径。
