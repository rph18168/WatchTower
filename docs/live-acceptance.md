# 真实部署验收运行手册

本手册提供 T10 的执行顺序和证据边界。已完成离线验证、真实 commands 连接检查、旧调用费用核账、GLM 真实摘要持久化，以及本人真实 `/digest` 在新 runner 中的恢复和发送确认。2026-11-01 首次 live 的失败证据保留；schedule 运行仍待完成，尚不能认定全部验收通过。实际证据见文末记录；不得用示例或绿色 job 代替真实结果。

## 先固定可复查的版本

确认 T01–T09 已整合、完整回归和代码审查通过，记录实际默认分支及最终执行的 checkout SHA、配置文件与 lockfile SHA-256。安装环境固定为 Node 24.15.0；依赖版本见 [README](../README.md#环境与验证)。当前模型已按使用者选择改为 `z-ai/glm-5.3-flash`，已取得真实 generation 收据、持久摘要和新 runner 的真实 `/digest` 回复确认，详见文末。首次失败的历史请求目标仍为 `openai/gpt-4.1-mini`；换模型不证明旧失败的根因，旧费用另按有来源的核账记录处理。

已实现的请求参数为严格 JSON Schema、`provider.requireParameters=true`、`store=false`、`allowFinalResponse=false`、传输重试关闭、60 秒请求期限，以及当前 `usage.maxInputBytes`／`maxOutputTokens`／费用／步数限制。摘要、来源核实和身份比较共享预算。默认月预算 US$10、单轮 US$0.25、六步、64,000 输入字节和 4096 输出 token；这些是停止阈值，不能承诺最终账单绝不超过阈值。

核对四项业务 Secret 的名称存在即可，不读取或展示值。保持 `WATCHTOWER_SCHEDULE_ENABLED` 关闭。首次真实验收前还保持 `WATCHTOWER_MANUAL_LIVE_ENABLED` 关闭，先执行：

```powershell
$codeBranch = gh repo view rph18168/WatchTower --json defaultBranchRef --jq '.defaultBranchRef.name'
gh workflow run watchtower.yml --repo rph18168/WatchTower --ref $codeBranch -f mode=offline
```

确认 `offline` job 的测试、类型检查和构建均实际完成。workflow 总体 success 可能只是其他 job 被跳过；不能据此认定真实运行发生。检查 dispatch ref 与最终 checkout SHA，工作流会显式 checkout 默认分支。

## 有界真实闭环

1. 在明确进入真实验收后，只开启手动真实变量，继续关闭定时变量。启动 `mode=live`，检查真实 HN 候选、完成的模型 generation 收据和 SQLite 摘要。初始近 48 小时历史只建基线，不推历史新闻；若一次预算只处理部分基线，后续 `live` 沿用原截止时间继续，不重置基线。
2. 摘要实际保存后，由本人在已配置 bot 的本人私聊中发送 `/digest`，也可随同发送 `/status`。在首轮摘要生成前发送 `/digest` 会读到旧／空摘要，不能证明新摘要已送达。
3. 启动第二个独立 workflow run，选择 `mode=commands`。它从同一状态分支恢复、验证相同本人身份并回复持久摘要，不注入 OpenRouter key，不采集或调用模型，也不投递主动队列。夜间仍允许命令回复。
4. 核对第二轮保留第一轮选定的候选、摘要、模型 call IDs 和费用；`/digest` 正文来自第一轮摘要并保留 HN／原文入口。SQLite 应有对应 `kind=command-reply`、`status=sent`、`sentAt`、Telegram `messageId` 和成功发送尝试。
5. 可选观察：本人可实际发送 `/status`、`/pause`、`/resume`，观察回复和持久控制状态，也可反馈摘要可见内容与阅读体验。四命令行为已有完整周期测试，这些额外真实观察不作为逐条人验门槛；未做就如实记录。恢复不能绕过预算。发送 API 的成功回执只证明 Telegram 接受消息，不证明本人已看见或阅读。[Telegram 更新及发送接口](https://core.telegram.org/bots/api)
6. 基线之后如自然出现通过核实的重大动态，在上海 08:00（含）至 23:00（不含）观察主动通知。若没有符合条件的动态，明确记录该路径未真实发生；不得伪造更新、插入新闻、重置基线或绕开静默时段凑验收。
7. 功能、凭据和真实闭环就绪后，再明确开启定时变量。记录至少一个实际 `schedule` run 的执行与后续状态延续；一次成功不构成永久在线或准点响应承诺。

```powershell
# 下面两项仅在手动真实变量已按上述顺序启用后执行。
gh workflow run watchtower.yml --repo rph18168/WatchTower --ref $codeBranch -f mode=live
# 本人已经实际发送 /digest 后，再执行这一项。
gh workflow run watchtower.yml --repo rph18168/WatchTower --ref $codeBranch -f mode=commands
gh run list --repo rph18168/WatchTower --workflow watchtower.yml --limit 10
gh run view <run-id> --repo rph18168/WatchTower --json databaseId,attempt,event,headBranch,headSha,status,conclusion,jobs,url
```

Telegram 未读更新最多保留 24 小时，停跑过久的命令可能无法补回；本人应重新发送仍需要的操作。不要在生产环境改坏 token 或篡改状态制造故障。通知超时、静默、暂停、预算与恢复的组合使用下面的可控验证；真实未发生的组合须如实留空。[Telegram 更新保留边界](https://core.telegram.org/bots/api#getting-updates)

## 按固定快照留证

每次运行结束记录 `watchtower-state` HEAD；下一轮前再次记录。两个不同的 hosted run、第二轮恢复前的 SHA、前后延续的提交链和保留下来的业务 ID，共同证明新 runner 恢复，不能只比较 job 颜色。状态 ref 查询是只读操作：

```powershell
gh api repos/rph18168/WatchTower/git/ref/heads/watchtower-state --jq '.object.sha'
```

下载快照时固定该 SHA，按原始字节保存，禁止用 PowerShell 文本重定向接收 SQLite。以下 Node 示例只下载公开文件；把 `STATE_COMMIT_SHA` 替换为已记录的完整 SHA：

```powershell
node --input-type=module -e 'import {writeFile} from "node:fs/promises"; const r = await fetch("https://raw.githubusercontent.com/rph18168/WatchTower/STATE_COMMIT_SHA/state.sqlite"); if (!r.ok) throw new Error("Snapshot download failed"); await writeFile("state.sqlite", new Uint8Array(await r.arrayBuffer()));'
node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const d = new DatabaseSync("state.sqlite", {readOnly:true}); try { console.log(d.prepare("PRAGMA quick_check").all()); } finally { d.close(); }'
```

| 目标 | 记录内容 | 通过条件 |
| --- | --- | --- |
| 实际执行 | run URL／ID、attempt、event、checkout SHA、实际执行步骤 | 相应 live 或 commands 步骤完成，非 skipped |
| 真实模型 | `budget.calls[]` 的 call ID、时间、status、实际 model、responseId、输入／输出 token、costUsd、costComplete | 至少一次有效 generation，完整实际费用与 token；未知或拒绝记录不算完成 |
| SQLite | 固定提交 SHA、文件 SHA-256、quick_check、schema、候选／摘要 ID | `quick_check=ok`，包含所选摘要及费用 |
| 新 runner | 不同 run IDs、第二轮加载前 SHA、同一 call／digest／candidate IDs | 第二轮保留第一轮已确认结果，提交链延续 |
| Telegram | command-reply 的 status、sentAt、messageId、最后 attempt | API 明确接受且确认已持久保存；本人可见性另记 |
| 公开边界 | 正文／quote 字段是否为空或缺失、允许的 hash／元数据、原始字节扫描 | 无 HN／来源长正文、逐字长引文、凭据、本人身份或未授权消息 |
| Markdown | 同一固定 SQLite 的摘要生成结果与查询正文 | 内容和来源一致；导出副本不是恢复输入 |

公共报告只输出上述允许字段。不要打印进程环境、原始 Telegram 响应、chat/user ID、key 标签、token 或来源全文。月用量按每条 call 的 UTC `startedAt` 归月累计；普通 key 最近一次额度查询不是本轮费用证据。缺失费用不能按零补齐。

## 可控组合验证

执行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`；修改 workflow 后再用 actionlint 检查。主要测试 seam 仍是 `runCycle`，使用真实临时 SQLite 和受控外部适配器／时钟，不需要真实凭据。

| 契约 | 主要测试文件 |
| --- | --- |
| 不同领域配置、分页、摘要与 Markdown | `test/run-cycle.test.ts`、`test/openrouter-cycle.test.ts` |
| 逐次模型预算、未知费用、UTC 月界 | `test/budget-cycle.test.ts`、`test/development-sdk.test.ts` |
| 核实、事件去重与实质更新 | `test/notification-cycle.test.ts`、`test/development-cycle.test.ts` |
| 静默／晨间汇总、暂停、重试与确认丢失 | `test/notification-window-cycle.test.ts`、`test/notification-retry-cycle.test.ts`、`test/telegram-control-cycle.test.ts` |
| 基线、48 小时、过期成员与跨 runner 冲突 | `test/recovery-cycle.test.ts`、`test/github-state-cycle.test.ts` |
| 全文最小保存、字节扫描、已删除页、指纹、已付费 checkpoint 与有界重取 | `test/public-state-cycle.test.ts` |
| 历史核账审计、跨周期费用保留与公开字段白名单 | `test/reconciliation-cycle.test.ts` |

调度可能延迟、排队任务可能被丢弃，公有仓库 60 天无活动可使 schedule 自动停用。检查最近成功周期、Actions run 和固定状态 SHA；按[部署恢复说明](deployment.md#调度与串行边界)核实后重新启用 workflow。模型预算和其他服务费用独立。[GitHub 调度规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 实际验收记录

### 2026-11-01：连接通过，首次模型工作失败后停止

两轮实际 checkout 均为 `95635e69d4ec8e4b93793714f6f253a22e026221`，Node 24.15.0，使用已固定的 Agent 0.11.0／SDK 0.13.7 及现有配置和预算。配置 Git 文件字节 SHA-256 为 `f2dac12b8c6db1115b096128c0f08cf7fec5b69542a7606ee4bec9494597f699`，lockfile 为 `18006baf1676131f71d26b3119d1725c4b72482a8201ec85ab018a7c88135d98`；这些 hash 不包含 Windows 工作副本的 CRLF 转换。

| 运行 | 实际步骤及结果 | 固定状态快照 |
| --- | --- | --- |
| [commands 41279942944](https://github.com/rph18168/WatchTower/actions/runs/41279942944)，attempt 1，06:13:25–06:13:51 UTC | commands 步骤 success；模型 Secret 检查和 paid-cycle 步骤 skipped。Telegram 轮询与 GitHub 状态创建成功；0 候选／摘要／模型调用／消息，未建立新闻基线。 | `ce3f9c60c16616b9838d5a3451f654939ca6859e`；24,576 字节；SHA-256 `57cdfd6b6f449e83e96048fab32e7e26d3a3039e174984e5df4878a943e5a5ef` |
| [live 41280112629](https://github.com/rph18168/WatchTower/actions/runs/41280112629)，attempt 1，06:15:50–06:16:16 UTC | 完整周期步骤 failure。真实 HN 留存 157 个 pending 候选，0 processed，0 摘要；fault 为 `model-processing`，预算按 `unknown-cost` 停止。 | `a40b4eaec0e30bd7152ae6ad9360a66d9837489a`；118,784 字节；SHA-256 `37c47efa8e5c448894d3bf88a1f716cdc0555c313cba23222f277edfa7e2336d` |

两个固定 SHA 的原始 SQLite 均只读重开，`quick_check=ok`、schema 1；检查未发现非空 HN／来源正文或 quote 字段。第二轮保存的基线截止时间为 `2026-11-01T06:16:01.436Z`，回看始于 `2026-10-30T06:16:01.436Z`，状态仍为 building；最近成功周期仍是第一轮 commands。实际候选示例 ID 为 `50322173`、`50322155`、`50322022`、`50321522`、`50321462`，没有把候选伪称为已生成摘要。

唯一模型账本记录为 `2ccb283d-b872-4b8d-b20f-eb4d68678f06`，开始于 `2026-11-01T06:16:05.854Z`：status `unknown`、costUsd null、costComplete false、输入／输出 token null、无 responseId。请求目标是配置的 `openai/gpt-4.1-mini`，未取得成功 generation 回执，不能确认实际响应模型或实际收费。请求前 06:16:05.726 UTC 的普通 key 元数据显示 remainingUsd 1、usageMonthlyUsd 0；这不能证明后续失败请求免费。

正常的预算状态报告由 Telegram 于 `06:16:12.267Z` 接受，messageId `5`，成功尝试和发送确认已保存。它属于运行状态报告，不是摘要、历史重大新闻或使用者已阅读的证据。该失败 run 的安全日志只显示模型阶段失败的通用错误，缺少原始 HTTP／SDK 错误类别，尚不能确定传输、provider 或响应格式的具体原因。

首次失败后到此停止，没有盲目重跑付费 run、重置基线、清空账本或把缺失费用填成零；定时保持关闭。当时尚未达到首份真实相关摘要里程碑，后续核账及 GLM 运行按下述独立授权推进。真实 `/digest` 摘要闭环、新 runner 的摘要恢复及实际 schedule 运行仍待完成。`/status`／`/pause`／`/resume` 与本人可见／阅读体验等额外真实观察未执行；不据此增加人工逐项验收门槛。

### 2026-11-01：只读账务检查及单次费用归属确认

当前模型 `z-ai/glm-5.3-flash` 的配置已发布于 [7f408d2](https://github.com/rph18168/WatchTower/commit/7f408d26812846f67665847adbc5d71c1e494de3)。安全失败诊断随后在 [a9a0531](https://github.com/rph18168/WatchTower/commit/a9a0531aea05f5991c265a3bef21505a569218d1) 独立合并发布，两轴审查均无 finding，独立离线全测 169/169 通过。这些更改没有补写旧调用的诊断、费用或模型，没有证明首次失败的根因，也没有完成 GLM 的真实摘要验收。

Root 独立执行了唯一一次临时只读查询：[accounting 41283594068](https://github.com/rph18168/WatchTower/actions/runs/41283594068)。实际查询步骤于 `2026-11-01T07:08:53Z` success；输出 `checkedAt=2026-11-01T07:08:53.764Z`、HTTP `200`、`outcome=ok`、`missing=[]`、`invalid=[]`。服务方返回的数值如下，金额单位为 US$：

| 字段 | 实际值 |
| --- | --- |
| `usage`、`usage_daily`、`usage_weekly`、`usage_monthly` | 各 `0.0000159` |
| `byok_usage`、`byok_usage_daily`、`byok_usage_weekly`、`byok_usage_monthly` | 各 `0` |
| `limit` | `1` |
| `limit_remaining` | `0.9999841` |

Root 只读核对了同名 `OPENROUTER_API_KEY` 的 GitHub Secret 元数据：`created_at=updated_at=2026-10-31T17:58:44Z`，早于失败请求，之后未更新；没有读取或打印 Secret 值。使用者在 OpenRouter Activity 中未找到该请求，只作为观察记录。使用者随后明确确认：北京时间 14:16–15:09 此 key 只有该次 WatchTower 请求。结合请求前 `usageMonthlyUsd=0`、同 Secret 未更新及此次 `usage_monthly=0.0000159`，该笔费用可按 provider key 月用量差额归为 US$0.0000159。来源是服务方累计增量与 key 所有人独占使用确认，不是旧 SDK 的 generation 收据，不能补造 token、responseId 或成功摘要，也不证明失败根因。

归属确认当时，旧 call `2ccb283d-b872-4b8d-b20f-eb4d68678f06` 仍为 `unknown`、`costUsd=null`、`costComplete=false`，unknown 保护保持；仍为 0 摘要，schedule 关闭。实际账本恢复与随后 GLM 的运行结果见下一节。核账成功后已移除临时查询 workflow／脚本，保留以下实际证据，不扩展为通用诊断平台。

该次查询入口仅支持 `workflow_dispatch`，没有 schedule、付费模式或任意 URL 输入；使用同一个 `watchtower-state` 串行组和 `contents: read`。只有查询步骤注入普通 `OPENROUTER_API_KEY`，无 Telegram 或状态写入步骤，也无 SDK／模型调用。原生脚本仅对硬编码的 `GET https://openrouter.ai/api/v1/key` 发起一次请求，拒绝重定向，期限 10 秒，不接受参数。

输出 `checkedAt`、固定 outcome／HTTP 状态及数值白名单：`usage`、`usage_daily`、`usage_weekly`、`usage_monthly`、`byok_usage`、`byok_usage_daily`、`byok_usage_weekly`、`byok_usage_monthly`、`limit`、`limit_remaining`。不存在的字段列入 `missing`，无效类型列入 `invalid`；对应值为 null，不能推断为零。BYOK 与其他 usage 分别保留，不自行合并或忽略。不会输出 label、creator、hash、完整 body／headers、key 或原始错误。[OpenRouter 当前 key 元数据接口](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)

查询显示的是查询时刻的服务方累计元数据，不能单独确定此前某次 unknown 调用的费用，也不能证明已修复 live 失败。本次累计用量明确非零，已结合上述独占使用确认完成归属核对，再通过下述独立维护恢复。只读查询脚本没有恢复账本的能力。新调用的安全失败类别如何读取见[失败诊断](usage-controls.md#失败诊断)。原失败请求缺少这些新字段，根因仍未确定。

### 2026-11-01：单笔费用恢复完成

独立合并、审查及授权后，Root 执行了唯一一次[维护 run 41285720256](https://github.com/rph18168/WatchTower/actions/runs/41285720256)，success，实际代码 `ca43971623307c0cff51593498ad32b04de429e6`，`reconciledAt=2026-11-01T07:40:34.326Z`。固定状态 [29818f9](https://github.com/rph18168/WatchTower/commit/29818f92970d2ee44032dc1f9c34e6f006de3b76) 的 SQLite SHA-256 为 `a0df823448956beb95711a43cd04a8c89e385f7cc8dcd1afc18d4533209adec0`，Root 独立下载并只读确认 `quick_check=ok`。

该次临时 `watchtower-reconcile.yml`／`src/maintenance-reconcile.ts` 仅用于本次已确认的旧 call，不接受费用、call ID、仓库、分支或 URL 参数。输入只有独立记录的完整 `watchtower-state` SHA 和对上述已记录独占使用事实的确认，确认默认 false。核账完成后已移除这两个临时入口，历史版本与实际 run 仍可复查。

维护使用同一个 `watchtower-state` 串行组（不取消进行中的任务）与必要的 `contents: write`；安装和构建没有业务 Secret，只有执行步骤注入 `GITHUB_TOKEN`／`OPENROUTER_API_KEY`。它不运行监视周期，不调用模型、HN 或 Telegram，也没有自动重试提交或付费入口。加载与保存均沿用现有 GitHubStateStore、真实 SQLite 和 GitHub expected-head CAS；版本不符或保存冲突不能覆盖较新状态。

本次维护要求执行仍在 2026-11-01 UTC 且晚于上述查询时间。它先核对唯一旧 unknown 项的 ID、原 GPT 模型、开始时间、空费用／token／responseId、原调用前 provider 时间和月用量零，再只读重查硬编码的官方 `/api/v1/key`（拒绝重定向、10 秒期限）。四项 `usage*` 必须均为 `0.0000159`，四项 BYOK usage 必须均为 `0`，`limit=1`、`limit_remaining=0.9999841`；字段缺失、无效、数值变化、目标不符、其他未知项或确认缺失时不写远端。此日期范围不构成长期费用恢复入口。

Root 对 `a40b4ea…` 与 `29818f9…` 的完整逻辑状态逐项比较，确认只改变目标费用为 `status=complete`、`costUsd=0.0000159`、`costComplete=true`，增加有界 `accountingReconciliation` 审计，并将已核清的 unknown-cost 暂停置 null。审计保存方法 `operator-confirmed-exclusive-key-delta`、原 unknown／null 事实、before 0／after 0.0000159、固定来源 run／UTC 时间与维护复核时间；公开投影只保留固定允许字段。原 GPT 模型、开始时间、空 token、无 responseId、157 个候选、0 摘要、基线、控制状态、旧故障、lastRunAt 和发送尝试均保留。维护不计作成功监视周期，也不构成有效 generation 或摘要验收。已移除临时入口及其专用协议测试，永久保留审计类型、公开投影和完整周期回归，确保历史费用和审计仍可读取。

### 2026-11-01：首次 GLM generation 与相关摘要已持久化

获得独立的单次授权后，仅执行了 [live 41286084610](https://github.com/rph18168/WatchTower/actions/runs/41286084610)，attempt 1，`workflow_dispatch`。run 于 `07:46:00Z` 创建，`07:46:50Z` 状态 completed/success；实际完整周期步骤 `07:46:12–07:46:47Z` success，commands 步骤 skipped。checkout 日志 `07:46:06.8038852Z` 确认为 `ca43971623307c0cff51593498ad32b04de429e6`。配置及预算未改，提交中文件字节 SHA-256：配置 `2d8773329378be0e422953919a2a586b6972d01a71fc33826f31d132c69feac5`，lockfile `18006baf1676131f71d26b3119d1725c4b72482a8201ec85ab018a7c88135d98`。

运行前状态为 `29818f92970d2ee44032dc1f9c34e6f006de3b76`；运行后固定为 [bd8f995](https://github.com/rph18168/WatchTower/commit/bd8f995af0dc709920abe88c9232d45de3cafae1)，blob `110f2a4ada62ebc95036088a1d54c901211124a5`，126,976 字节，SHA-256 `1d1b86f889cc96d74c357ce00ad7a53a3e325145f78b224f725677d8073f076f`。原字节下载后只读重开，schema 1、`quick_check=ok`，未发现非空原始正文／quote 字段。

| 本地 call ID／开始 UTC | 实际 generation ID | 实际模型 | costUsd／costComplete | 输入／输出 token |
| --- | --- | --- | --- | --- |
| `d1709554-e285-4ec0-b398-5597b040aa81`／`07:46:17.774Z` | `gen-1793519178-QLF1yiUWFRcHatsUqHWn` | `z-ai/glm-5.3-flash` | `0.00108329`／true | 1005／2785 |
| `bff0c3fd-063b-4d1f-9d79-6a01dd2f7ab8`／`07:46:40.815Z` | `gen-1793519201-veCdUshNGdsFfTsTGirK` | `z-ai/glm-5.3-flash` | `0.000034196`／true | 609／37 |

两笔均为 complete。本轮实际合计 US$0.001117486，输入／输出 1614／2822 token、两步；当月已知费用 US$0.001133386（含旧调用核账 US$0.0000159），pauseReason null、fault null。旧 GPT 记录与审计仍在，token 保持 null、无 responseId；不会将它算成成功 generation。

同一固定快照保存了两份相关摘要：`digest:50322173`（提示注入诉讼文书，来源 [HN 50322173](https://news.ycombinator.com/item?id=50322173)／[原文入口](https://jetstream.security/insights/brazilian-court-sanctions-prompt-injection-filing/)）和 `digest:50321522`（BBRouter 与 MCP 电路助手，来源 [HN 50321522](https://news.ycombinator.com/item?id=50321522)／[原文入口](https://bbrouter.com/bbrouter/ben-eater-sap-1)）。两份均保留“来源正文未能完整核实，暂不主动通知”的说明；这里记录的是模型保存的摘要及来源入口，不宣称已核实来源全文。

快照共有 160 个候选：151 pending、5 processed、4 archived。原基线仍从 `2026-10-30T06:16:01.436Z` 至 `2026-11-01T06:16:01.436Z`、building，没有重置或把历史新闻主动推送。该轮没有新增发送，唯一已有消息仍为预算报告 messageId `5`。首份真实相关摘要里程碑达到后停止启动新 run，直至本人真实发出 `/digest` 并获得下面的独立 commands 授权；schedule 仍关闭，也没有宣称使用者已阅读或主动重大动态路径已真实发生。

### 2026-11-01：本人真实 `/digest` 在第二个新 runner 回复并保存确认

使用者明确报告已真实发送 `/digest` 后，单独授权并仅启动一次 [commands 41286765734](https://github.com/rph18168/WatchTower/actions/runs/41286765734)，attempt 1，`workflow_dispatch`。派发前独立读取的默认分支仍为 `ca43971623307c0cff51593498ad32b04de429e6`，状态 HEAD 为 `bd8f995af0dc709920abe88c9232d45de3cafae1`；当时本地尚未发布的清理提交不参与本次运行。

run 创建于 `07:56:31Z`，`07:56:59Z` 状态 completed/success。checkout 日志 `07:56:38.5945664Z` 确认实际代码仍为 `ca43971623307c0cff51593498ad32b04de429e6`。commands 步骤 `07:56:45–07:56:56Z` success；model Secret 检查与 paid-cycle 步骤均 skipped。执行步显式注入的 Secret 只有 `GITHUB_TOKEN` 和三个 Telegram Secret，没有 `OPENROUTER_API_KEY`；本轮 `usage=null`、`steps=0`、`runSpentUsd=0`，没有模型请求。

固定状态 [b0d7015](https://github.com/rph18168/WatchTower/commit/b0d70156a47a2b91844f8daf3baf61d992f82b1b)，blob `5976c7e1ad71ed8648e219b9cfac09163e7b2225`，126,976 字节，SHA-256 `9ddb4a94fa5cc7b3fcb3e72cfff0ea924e22b3324d56aed26fa04ebd1381e4ca`；只读 `quick_check=ok`、schema 1，无非空原始正文／quote 字段。GitHub compare 确认它位于 `bd8f995…` 之后六个提交，base 和 merge-base 均为 `bd8f995af0dc709920abe88c9232d45de3cafae1`，证明延续同一快照链。

真实 command-reply 于 `2026-11-01T07:56:54.091Z` 被 Telegram 接受，`messageId=7`、`status=sent`；成功 attempt、sentAt 和 messageId 已保存在同一 SQLite。回复正文 SHA-256 为 `b1d85b0c880fdd8faa018132b66aae380390fdc395c1eedbf3bcfbc5fa489a28`，以 `# WatchTower 摘要` 开头；`digest:50322173` 与 `digest:50321522` 的标题、摘要全文、原文及 HN 链接均逐项匹配。未使用合成 update，也未发送额外测试报告。API 成功回执证明 Telegram 接受，不代表本人已读。

前后比较确认三笔原费用及 GPT 审计、两份摘要、原基线和旧预算通知完全相同，160 个候选 ID 全部保留。候选 `50300902` 发布于 `2026-10-30T07:48:40Z`，本轮于 `2026-11-01T07:56:46.097Z` 超过 48 小时窗口后由 pending 转 archived，仅增加归档时间；因此状态为 150 pending、5 processed、5 archived，并未丢失候选或重新采集。本人真实查询、独立新 runner、原摘要恢复和持久发送确认链路已通过；schedule 仍关闭，实际定时运行及未自然发生的主动重大动态路径尚无真实证据。
