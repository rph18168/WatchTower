# 只读部署验收工具

使用 Node 环境和已登录的 `gh` CLI。入口为 `npm run acceptance -- <命令>`，参数查询用 `npm run acceptance -- --help`。工具只向 GitHub 发起 GET，并读取固定的 GitHub Status 官方 API；不会派发／重跑任务、调用模型或 Telegram、写远端状态、读取 Actions Secret 值或核账。

每次检查选择一个新的 `--out <证据目录>`，推荐位于忽略的 `.scratch/acceptance/` 下。终端只输出带检查时间、结果和报告路径的一行 JSON；允许字段详情保存在 `<命令>.json`。`snapshot`／`compare` 还会保存原始 SQLite 字节，文件名为固定提交 SHA。原始快照属于本地调查材料，发现公开边界问题时保护这些文件；JSON 报告不会打印原材料、通知正文、个人身份值或原始异常／job 日志。

## 命令

以下示例中的仓库、日期、run、attempt 和 SHA 均应取自本次实际观察；`<…>` 是待替换的参数。

```powershell
# 启用时间之后的自然事件：完整分页成功后，才判断存在或缺失。
npm run acceptance -- schedule --repo <owner/repo> --workflow watchtower.yml --since <启用UTC时间> --out <证据目录>

# 固定 attempt 的实际步骤，并从 checkout 日志提取 SHA；head_sha 单独记录。
npm run acceptance -- run --repo <owner/repo> --run <run-id> --attempt <attempt> --event schedule --mode live --expect-checkout <代码SHA> --out <证据目录>
# 手动命令恢复验收使用 --event workflow_dispatch --mode commands。

# 固定 SHA 下载，核对 Git blob hash／大小，SQLite 只读 quick_check 和 schema。
npm run acceptance -- snapshot --repo <owner/repo> --commit <状态SHA> --out <证据目录>

# 下载两个固定版本，比较真实提交链及逻辑状态，不依赖文件名推断来源。
npm run acceptance -- compare --repo <owner/repo> --before <前状态SHA> --after <后状态SHA> --out <证据目录>

# 官方汇总和最近事故：记录请求／接收时间及 HTTP Date／Age。
npm run acceptance -- platform --since <观察窗口起始UTC时间> --out <证据目录>
```

日期使用带时区的 ISO 8601，代码／状态 SHA 使用完整 40 位小写十六进制。`run` 区分真实失败、尚未完成／跳过以及 checkout 未证实；commands 模式还要求付费周期及模型 Secret 检查被跳过。`gh` 若将日志标为 `UNKNOWN STEP`，工具只接受 checkout 实际时间窗内的唯一 git log／SHA 对，并在报告标记 `checkoutUsesTimeWindow`；API 时间精度仅到秒，窗口覆盖结束时刻所在的整秒。自然事件存在只完成发现阶段，不能代替完整周期或快照验收。

## 报告判断

| 退出码 | 意义 | 后续动作 |
| --- | --- | --- |
| 0 | 当前命令的证据检查通过 | 按验收手册完成其余证据；并非完整部署自动结项 |
| 1 | 查询成功但无自然事件，或 run 尚未实际执行／被跳过 | 检查控制与队列，再按外部等待流程保存检查点 |
| 2 | 查询失败、响应格式／分页不完整，或本地报告保存失败 | 结果未知；不能解释成“没有事件” |
| 3 | 参数错误 | 查询 `--help` 并修正输入 |
| 4 | 真实失败、checkout 未证实、快照损坏／边界问题、费用未知、延续变化或 HTTP 新鲜度未证实 | 阅读报告定位差异；保持预算与状态保护 |

`snapshot` 报告包含完整性 hash、候选计数／摘要 ID、模型回执白名单、UTC 月份分组费用、通知发送确认和正文 hash。费用分别给出已知金额与完整性；不完整回执中的已知金额仍计入 `knownCostUsd`，完整总费用保持 `costUsd=null`，token 缺失也不按零补齐。历史核账以审计 hash 保留，不能替代有效 generation 的回执。结构化敏感字段和原材料路径检查、原始字节的字段标记扫描只是可审查线索，不是所有可能隐私泄露的完整证明。

`compare` 保守要求旧候选 ID、旧摘要、旧费用、已发送通知和尝试历史延续，初始基线窗口不变；新调用必须有完整费用、模型、generation 与 token。它不固定调用数、主题、模型或日期。摘要因合法更新而改变、修复旧账或故障恢复也可能返回 4；应核对实际变化而非清空差异求绿。报告列出新增已发送通知，须结合基线和实际来源检查是否属于合法新动态，不能仅以退出码认定无重复回复或无历史洪泛。前快照已有故障或暂停时也要求人工解释。

`platform` 在 URL 附带本次检查时间并请求 `no-cache`，记录 HTTP 时间；以本机时钟为参考，Date 距接收时间不超过五分钟、最多领先一分钟，Age（存在时）不超过五分钟才接受新鲜度。缺失／无效 Date、无效 Age 或过旧缓存返回 4。历史列表保留观察窗口内新建、更新、解决，以及仍未解决的事故，包含启用前开始但窗口内才解决的情况。报告只覆盖接口返回的近期事故窗口，正常公开状态不能排除未公开的单个 workflow 调度问题。

网络操作有期限和响应大小上限；GitHub 列表最多读取十页，超过范围返回查询失败。脚本仅在内存中处理 `gh run view --log` 的输出以提取 checkout 证据，不将原始日志加入报告；[gh 自身会缓存日志归档](https://github.com/cli/cli/blob/trunk/pkg/cmd/run/view/view.go)。数据库下载上限与应用快照边界一致；出现查询失败时先查看权限、网络及工具版本，原始错误不自动导出。

## 自动验证

`validation.yml` 使用事件默认 checkout，自动验证代码 push 和 PR 的待检提交，排除 `watchtower-state`，并使用与巡检不同的并发组。它复用 `npm run check`，另以官方固定版本／SHA-256 下载 actionlint，检查全部 workflow；不注入业务 Secrets。GitHub 事件过滤与默认 checkout 的行为依据 [workflow 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)；固定工具来自 [actionlint 官方发布](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)。

工具的回归测试集中在 `test/acceptance-command.test.ts`，通过公开 `acceptanceCommand(argv, dependencies)` 命令入口、受控 GitHub／HTTP 边界与真实临时 SQLite 检验结果和落盘报告；业务测试仍集中在既有完整周期入口。运行周期及配置行为不因这些只读工具改变。
