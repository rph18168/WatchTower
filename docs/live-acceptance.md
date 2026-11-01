# 真实部署验收运行手册

本手册提供 T10 的执行顺序和证据边界。已完成离线验证及一次真实 commands 连接检查；2026-11-01 首次 live 因模型处理失败而停在未知费用状态，尚未生成真实摘要，不能认定闭环通过。实际证据见文末记录；不得用示例或绿色 job 代替真实结果。

## 先固定可复查的版本

确认 T01–T09 已整合、完整回归和代码审查通过，记录实际默认分支及最终执行的 checkout SHA、配置文件与 lockfile SHA-256。安装环境固定为 Node 24.15.0；依赖版本见 [README](../README.md#环境与验证)。默认模型 `openai/gpt-4.1-mini` 只是配置值；验收还须记录实际收据中的模型。

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

正常的预算状态报告由 Telegram 于 `06:16:12.267Z` 接受，messageId `5`，成功尝试和发送确认已保存。它属于运行状态报告，不是摘要、历史重大新闻或使用者已阅读的证据。当前安全日志只显示模型阶段失败的通用错误，缺少原始 HTTP／SDK 错误类别，尚不能确定传输、provider 或响应格式的具体原因。

本次到此停止，没有再次派发付费 run、重置基线、清空账本或把缺失费用填成零；定时保持关闭。首次真实相关摘要里程碑未达到，真实 `/digest` 摘要闭环、新 runner 的摘要恢复及实际 schedule 运行均待后续完成。有来源的费用核对和最小修复应先于继续模型工作。`/status`／`/pause`／`/resume` 与本人可见／阅读体验等额外真实观察未执行；不据此增加人工逐项验收门槛。
