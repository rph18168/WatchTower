# 真实部署验收运行手册

本手册提供真实部署验收的执行顺序和完成条件。具体运行、失败、核账和外部等待记录独立保存在[验收档案](acceptance/2026-11-01-spec-1.md)；历史成功与绿色 job 均不能替代本次实际结果。

## 先固定可复查的版本

确认 T01–T09 已整合、完整回归和代码审查通过，记录实际默认分支及最终执行的 checkout SHA、配置文件与 lockfile SHA-256。安装环境和依赖版本见 [README](../README.md#环境与验证)，模型和用量上限从本次配置读取。切换模型不证明旧失败的根因，也不会核清旧未知费用。

已实现的请求参数为严格 JSON Schema、`provider.requireParameters=true`、`store=false`、`allowFinalResponse=false`、传输重试关闭、60 秒请求期限，以及当前 `usage.maxInputBytes`／`maxOutputTokens`／费用／步数限制。摘要、来源核实和身份比较共享预算。实际用量配置是停止阈值，不能承诺最终账单绝不超过阈值。

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

使用[只读验收工具](acceptance-tools.md)的 `snapshot` 下载固定 SHA 的原始 SQLite 字节并执行只读检查；用 `compare` 核对两次固定快照的延续。报告默认只在终端输出摘要，详情及 SQLite 保存在指定证据目录。禁止用 PowerShell 文本重定向接收 SQLite。

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

执行 `npm ci`、`npm run check`，并用 actionlint 检查 workflow。独立验证 workflow 会对代码 push 和 PR 的待检提交自动执行这些检查。主要测试 seam 仍是 `runCycle`，使用真实临时 SQLite 和受控外部适配器／时钟，不需要真实凭据。

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


遇到自然事件尚未创建、查询失败或平台等待时，按[部署诊断流程](agents/deployment.md)保存检查点并退出主动等待。
