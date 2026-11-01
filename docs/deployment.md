# 公有 GitHub Actions 部署与恢复

工作流为 `.github/workflows/watchtower.yml`，读取默认分支代码及 `watchtower.config.json`。定时和手动 `live` 执行同一个 `npm start -- --allow-paid-model --github-state` 完整周期；手动 `commands` 执行现有的 `--commands-only --github-state`，只处理本人命令和相应回复。两者使用同一状态分支、身份校验和串行组。不依赖常开主机、runner 缓存、artifact 或旧工作目录恢复状态。

代码与离线测试不能替代规格 #1 / T10 的真实 HN → OpenRouter → SQLite → Telegram 闭环和新 runner 恢复。按[真实验收运行手册](live-acceptance.md)记录实际运行；本文本身不表示已完成线上验收或启用付费运行。

## 默认关闭与启用顺序

1. 仓库必须已有正常代码分支，且此工作流位于实际默认分支；不要假定分支名为 `main`。GitHub 不允许在空仓库创建状态 ref。
2. 修改默认分支上的关注主题及用量配置。准备 Actions Secrets：`OPENROUTER_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_USER_ID`。本人 chat/user 身份也属于秘密，不放在公有配置或数据库中。`GITHUB_TOKEN` 由 Actions 提供；真实运行 job 请求本仓 `contents: write`，不需要长期 PAT 或第二个仓库。仓库或组织策略仍可能拒绝写入。
3. 保持 repository variables `WATCHTOWER_MANUAL_LIVE_ENABLED` 和 `WATCHTOWER_SCHEDULE_ENABLED` 未设置或设为 `false`。在 Actions 中手动选择 `mode=offline`，只运行完整周期的离线测试、类型检查及构建，不传入业务 Secrets。
4. **仅在全功能准备好、代码审查通过且明确进行 T10 验收时**，将 `WATCHTOWER_MANUAL_LIVE_ENABLED` 设为 `true`，手动选择 `mode=live`。首次运行建立基线，不推历史新闻。摘要生成后，本人实际发送 `/digest`，再启动不同的 `mode=commands` run，从远端快照恢复并回复刚保存的摘要，无需新模型调用。手动真实入口都受同一开关保护；仅配置 key 不会开启它。
5. 验收后如需无人值守运行，再单独将 `WATCHTOWER_SCHEDULE_ENABLED` 设为 `true`。手动开关不会开启定时任务。停用付费自动运行时将定时变量改为 `false`；如需连手动真实运行也禁用，再关闭手动变量。

未设置开关时真实 job 被跳过。工作流中的 cron 声明并不代表当前已开启真实运行。上述开关不是预算控制的替代品；真实任务仍须遵循应用预算和服务方限额。

| 入口 | 允许的工作 | 所需业务 Secrets |
| --- | --- | --- |
| 手动 `offline` | 测试、类型检查、构建 | 无 |
| 手动 `live`／定时 | 完整周期，包括受预算约束的模型工作 | 四项业务 Secrets |
| 手动 `commands` | 本人四命令、持久保存和命令回复 | 三项 Telegram Secrets；不注入模型 key |

Secrets 仅在检查与执行步骤注入；`npm ci`、构建及离线步骤没有业务 Secrets。所有真实保存使用 Actions 自带的 `GITHUB_TOKEN`，只在相应步骤可用。缺失检查仅输出变量名称，不打印值；名称存在不证明凭据有效、账户有余额或身份配置正确。

## SQLite 快照契约

默认状态分支为同仓 `watchtower-state`，其中 `state.sqlite` 是恢复的唯一事实来源。首次成功保存会创建只包含 SQLite 的根提交及状态 ref；已有状态分支却缺失快照时直接失败，不能以清空状态替代修复。

每次 `StateStore.load()` 先读取精确状态 ref 的 commit SHA，再固定该 SHA 下载原始 SQLite 字节。旧的本地工作副本和 journal 不参与恢复。已有快照必须通过 SQLite `quick_check`、包含已提交的运行状态且符合受支持 schema；损坏快照、权限或网络错误均不会退回初始基线。

每次 `StateStore.save()` 先把公开运营投影提交为本地 SQLite 事务，安全清理并重建文件，再等待远端快照提交成功。SQLite 使用 DELETE journal 和 FULL synchronous，上传的是包含已提交事务的完整数据库，而非 WAL 的一部分。数据库不是进程结束时才统一上传；业务的“保存后再发送”和“发送确认再保存”检查点都等待远端持久化。

更新使用 GitHub GraphQL `createCommitOnBranch`，通过 `expectedHeadOid` 原子检查已加载的分支版本。旧 runner 不能覆盖新 HEAD，也不会合并两个 SQLite 文件。首次初始化遇到另一个写者也不强制覆盖。提交响应不确定时只重新读取并核对完整字节；只有确证远端已有相同快照才确认成功，否则结束本周期。保存失败后，本地未提交副本不再用于保存；下一次完整周期重新读取远端最新状态，不将旧数据库换一个新 SHA 重传。

当前应用限制快照不超过 16 MiB，超限会显式失败，需在继续运行前处理存储维护。Markdown 是周期结果生成的阅读导出，CLI 写入 `.watchtower/digest.md`，不作为恢复输入；runner 消失后可从 SQLite 再生成。

独立进程如需使用相同存储，必须遵守相同串行约束。CLI 的远端模式还要求 `GITHUB_TOKEN`、`GITHUB_REPOSITORY=owner/repo`；可用 `--state-branch <分支>` 指定维护时的专用状态分支。`--state <路径>` 只是本轮临时 SQLite 工作副本位置，不能让远端模式改用陈旧的本地事实来源。

## 调度与串行边界

cron 为 UTC `7,22,37,52 * * * *`，以约 15 分钟为目标，单个 job 最多 10 分钟。所有状态写入入口使用同一个固定 `concurrency.group: watchtower-state`，且 `cancel-in-progress: false`，避免新任务中断正在保存或发送的运行。新增恢复 workflow 时也必须使用此 group，不能按事件名、ref 或 workflow 名拆分。GitHub 默认并发组只保留一个 pending，新 pending 可能替换旧 pending，因此不承诺每个 tick 都实际运行。

工作流只监听 `schedule` / `workflow_dispatch`，不监听 push，因此状态提交不会递归启动巡检。后续 CI 如监听 push，也应排除状态分支；不要仅依赖 `GITHUB_TOKEN` 触发限制。

GitHub 的 schedule 可能延迟或丢弃排队任务，公开仓库长时间无活动（当前文档为 60 天）会自动停用定时工作流。检查 Actions 页面最近成功时间及快照中最近成功周期时间；不要把代码部署成功或状态分支提交视作永久在线证明。被停用时，先确认所需凭据、预算和恢复范围，再通过 Actions 页面或 `gh workflow enable watchtower.yml --repo rph18168/WatchTower` 重新启用。该命令恢复 workflow 可用性，真实运行仍受两个显式变量控制。

## 公开状态、备份与故障恢复

状态分支及完整 Git 历史公开，候选元数据、简洁摘要、来源定位／hash、验证与归并进度、费用和投递状态可被任何人读取。HN／来源正文和逐字引文不保存在公开快照中，候选指纹与已验证 checkpoint 维持恢复；详见[正文恢复边界](recovery.md#正文与证据的恢复边界)。凭据、本人操作身份和未授权消息内容不得进入 SQLite 或日志。删除新快照中的字段不会删除历史提交里的内容。

快照保存会持续增加 Git 历史；多检查点保存可能在一个周期产生多个提交。适配器只下载最新文件，不需要 clone 整个历史，但这不会消除仓库历史增长。本实现不自动 force push、压缩或重写历史；需要维护时先停止写者并保存可验证备份。

保存失败或版本冲突后，下一次成功周期从最新已提交快照恢复；不要手动合并二进制 SQLite，也不要上传失败 runner 的数据库覆盖新状态。权限失败时检查 Actions 写权限及分支规则；快照缺失或损坏时关闭两个真实运行开关，等待正在执行的任务结束，然后备份当前 HEAD 和一个已知有效的完整快照。备份下载固定 commit SHA，并以原始字节保存，避免文本编码转换；离线打开并执行 SQLite 完整性检查后再使用。

需要恢复旧快照时，在停写期间以当前状态 HEAD 为前置版本追加恢复提交，并先核对恢复点后的模型用量及已发送消息。旧快照可能缺失费用或发送确认；恢复并不能撤销外部调用，也可能导致已约定的重发。保留原 HEAD 便于追查，再以一次手动真实周期验证恢复；不要直接 reset/force 覆盖远端历史。

模型月预算与 GitHub Actions、仓库存储或其他服务收费分别管理。公有仓库的标准托管 runner 当前可免费使用，较大 runner 等仍有独立计费规则；不要把 US$10 模型默认预算当成项目全部费用上限。[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

协议依据：[GitHub GraphQL 提交与 expectedHeadOid](https://docs.github.com/en/graphql/reference/commits#createcommitonbranchinput)、[二进制 FileAddition](https://docs.github.com/en/graphql/reference/git#fileaddition)、[Git References](https://docs.github.com/en/rest/git/refs)、[Contents raw 读取](https://docs.github.com/en/rest/repos/contents#get-repository-content)、[调度限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[并发约束](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)、[重新启用 workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows#enabling-a-workflow)。
