# WatchTower

按可配置的关注主题读取 Hacker News 候选帖子，将相关内容整理成中文摘要并保存到 SQLite。Markdown 是从已保存摘要生成的阅读副本。

当前实现覆盖规格 #1 的 [T01 / #2](https://github.com/rph18168/WatchTower/issues/2)、[T02 / #3](https://github.com/rph18168/WatchTower/issues/3) 和 [T03 / #4](https://github.com/rph18168/WatchTower/issues/4) 的离线摘要、用量控制与持久化。GitHub Actions 的手动真实运行和无人值守定时运行分别由显式开关保护，默认均关闭；完成全功能与最终验收前不启用付费自动运行。部署、调度限制、状态备份及恢复见 [部署说明](docs/deployment.md)。

## 环境与验证

- Node.js 24.15.0 或更高版本；SQLite 使用内置 `node:sqlite`。
- `npm ci`
- `npm test`
- `npm run typecheck`
- `npm run build`

测试通过同一个 `runCycle` 入口使用真实临时 SQLite、可控时钟以及 HN/模型适配器。OpenRouter 协议测试使用真实 Agent SDK 与可控 SSE 响应，不需要网络、API 凭据或付费调用。

依赖已固定并提交 lockfile：`@openrouter/agent 0.11.0`、`@openrouter/sdk 0.13.7`、`zod 4.6.7`；开发工具为 TypeScript 7.0.2 与 Node 类型 24.19.2。基础 SDK 同时通过 override 固定，防止 Agent 的版本范围改变已核对的调用行为。

## 关注主题配置

修改根目录的 `watchtower.config.json`。每个主题有唯一 `id` 和描述兴趣的 `description`；支持多个不同领域的主题，不需要通知条件或领域专属字段。默认 AI 主题只是可替换示例。`model` 为 OpenRouter 模型标识，默认 `openai/gpt-4.1-mini` 也是尚未线上验收的示例。

每个完整周期重新读取配置；已保存的运行状态不会覆盖新配置。历史摘要继续保留，新的待处理候选按当前主题判断。

`usage` 配置项目共用月预算、本轮费用阈值、实际模型请求步数、输入字节和输出 token 上限。默认月预算 US$10，UTC 自然月重置。预算暂停仍保留候选；未知费用阻止后续付费工作。字段、暂停原因及账单边界见[模型用量控制](docs/usage-controls.md)。

## 人工执行一次完整周期

在进程环境中提供 `OPENROUTER_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和 `TELEGRAM_USER_ID`，不要写入版本管理中的文件。构建后使用显式的付费操作开关：

```powershell
npm start -- --allow-paid-model
```

可选参数为 `--config <路径>`、`--state <SQLite路径>` 和 `--digest <Markdown路径>`；默认输出位于被 Git 忽略的 `.watchtower/`。`--github-state` 使用 `GITHUB_TOKEN` / `GITHUB_REPOSITORY` 读取和保存同仓快照，可用 `--state-branch <分支>` 改变默认 `watchtower-state`。`--allow-paid-model` 表示人工启用真实模型工作，实际请求仍受应用和 provider 额度约束。也可用 `--commands-only` 仅处理 Telegram 操作，无需模型 key；两个开关均不提供时退出且不发起网络请求。

Telegram 提供本人私聊的 `/digest`、`/status`、`/pause` 和 `/resume`。每个周期优先读取操作，暂停后仍能回复与恢复；夜间查询不受主动通知时段限制。预算不足会排入去重的运行报告；命令处理、身份边界、游标恢复和 24 小时未读更新边界见 [Telegram 控制说明](docs/telegram-controls.md)。

应用的业务入口为 `runCycle({ loadConfig, state, hn, model, clock? })`，返回保存后的 `digest`、`markdown`、候选处理数量 `status` 及本轮 `usage`。`StateStore.load()` / `save()` 都是异步契约，`save` 只有在持久化完成后才应成功返回；SQLite 适配器还提供 `close()`。远端快照适配器可在这一存储 seam 延续持久化契约，无需再暴露每个业务步骤。

HN 适配器使用 [Algolia HN 搜索协议](https://hn.algolia.com/api)，固定本轮上界，回看 48 小时、初始至少 20 分，读取所有可用分页并按帖子 ID 合并；如果服务端结果总数超出可用页面，显式失败，不把截断结果当作完整采集。摘要保存原文链接（存在有效 HTTP(S) URL 时）与 HN 讨论入口。T01 的摘要依据 HN 标题与帖子正文，不声称已核实链接原文。

模型适配器使用 [OpenRouter 结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)，传入主题和候选，要求通用中文摘要、本地校验候选/主题 ID 和基本中文内容。单次响应不授予工具权限；`provider.requireParameters=true`，输出 token 使用本轮配置（默认 4096），超时 60 秒，传输重试关闭，`allowFinalResponse=false`、`store=false`。这些参数未经过真实付费模型验收。

`usage.costUsd` 允许为空；`costComplete` 说明费用是否完整，费用缺失不能解释为免费。SDK 完整响应后读取累计 usage；传输失败时只携带已收到的允许字段回执并标记不完整，不把原始 SDK 错误写入日志。

## 持久状态与恢复

SQLite 事务保存候选及其待处理/已处理进度、主题关联、摘要与最近成功运行时间。先保存采集结果，再请求模型；模型失败或摘要校验失败后，下一周期可以重新处理已持久保存的候选。已处理帖子重复出现时不会重复生成摘要；没有待处理候选时不调用模型。

SQLite 使用 DELETE journal 和 FULL synchronous，保存完成后是包含已提交事务的单个数据库文件。本地模式重新打开同一路径可继续运行；GitHub 模式每次从状态分支固定 SHA 恢复，再通过 `expectedHeadOid` 检测过期版本，且每次 `save()` 都等待远端提交。删除 Markdown 后，下次成功周期会从 SQLite 再生成它。本地模式须独占数据库；远端写者还须共享工作流串行约束。

不要将 API key 或其他凭据放入配置、SQLite 或日志。部署到公有仓库前，还需完成后续任务中对公有状态、调度与运行恢复的验收。
