# 模型用量控制

每次运行重新读取 `watchtower.config.json` 的 `usage`；全部关注主题和模型操作共用额度，不按主题拆分。字段可部分省略，默认值如下：

```json
{
  "usage": {
    "monthlyBudgetUsd": 10,
    "runBudgetUsd": 0.25,
    "maxSteps": 6,
    "maxInputBytes": 64000,
    "maxOutputTokens": 4096
  }
}
```

`monthlyBudgetUsd` 和 `runBudgetUsd` 是美元费用停止阈值；`maxSteps` 计入本轮所有实际模型请求，包括摘要、来源核实、重试及 SDK 追加请求。三者可设为零以停止相应付费工作。输入上限按 UTF-8 字节计算，真实请求包括 instructions、结构化输出 schema 和来源内容；输出上限是每次请求的 `max_output_tokens`。输入字节与输出 token 限制必须为正整数，步数必须为非负整数，费用必须为有限非负数。无效配置在采集前拒绝。

费用在响应返回后才能确定。一次已经获准的请求可能超过剩余月额度或本轮阈值；下一次请求会被阻止。这些阈值不是最终账单的精确硬上限，也不包括 GitHub Actions、存储及其他服务费用。SDK 的软停止条件不能替代传输前的检查。当前适配器关闭传输重试和额外收尾响应，仍通过 SDK `beforeRequest` 检查每次实际派发，并用 `PostModelCall` 逐次核算。

## 预算状态与恢复

`runCycle().status.budget` 返回 UTC 月份、配置月预算、当月已知收费、剩余应用额度、本轮收费、请求步数和暂停原因。`runCycle().usage` 汇总本轮所有实际请求；后续请求被预算阻止时，前面已发生的收费仍在汇总中。候选数量和待处理数量由同一 `status` 提供。

- `monthly-budget`：本月应用额度耗尽。
- `run-budget` / `steps`：本轮停止阈值已到达，下次运行重新计本轮阈值。
- `input-size` / `output-size`：请求超过配置规模，候选保持待处理；当前适配器不静默截断来源内容。
- `provider-limit`：普通推理 key 的额度、有效预算或 provider 的 402/429 拒绝阻止请求。
- `provider-unavailable`：自身额度元数据缺失、无效或查询失败，停止付费工作。
- `unknown-cost`：至少一个请求费用不完整，停止后续付费工作。

月窗口对齐 UTC 自然月，即 Asia/Shanghai 每月 1 日 08:00。已结算的上月收费保留记录，但不会扣入新月；调整配置不会删除已经发生的收费。预算暂停期间候选采集和持久保存继续，恢复额度后重新处理待处理候选。其他任务的命令处理也必须使用同一预算入口，手动恢复不能绕过它。

每次获准请求先保存 `in-flight` 费用记录，并等待状态存储确认持久化，才开始模型操作。收费回执同样在下一次请求前保存。记录只保留本地请求 ID、时间、模型、可用的 provider response ID、数值 usage 和完整性；不保存原始错误、请求体、key 标签或请求头。旧版 SQLite 没有 `budget` 字段时会按空账本初始化。

未知费用不当作零：部分已知费用继续计入，缺失部分标为 `unknown`。超时或 runner 中断留下的 `in-flight` 也阻止后续请求。月界和上调预算都不清除这些记录。当前版不自动补查 generation 费用；维护者须先核对 provider 用量证据，再恢复完整记录，不能将缺失费用直接填成零来解锁。

## Provider 额度

运行时使用普通推理 key 只读查询 [`GET /api/v1/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)，读取月用量、key 剩余额度，以及响应中可用的 `budgets` 和 `effective_budget`。多个限制取最小值。查询返回未配置 key cap，并不证明账户资金无限；实际拒绝仍停止模型请求。上调应用配置不会修改 provider 限额。

不持有或调用管理密钥。[`GET /api/v1/credits`](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) 需要管理密钥，因此不属于本程序的额度查询路径。所有自动化前仍需 T10 的真实闭环验收；离线 SSE/SQLite 测试不是付费服务的线上验收。
