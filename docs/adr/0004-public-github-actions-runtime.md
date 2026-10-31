# 在现有公有仓库中运行并保存状态

WatchTower 在现有公有仓库中使用 GitHub Actions 定时短任务运行，实际配置保存在该仓库，SQLite 快照保存在同仓专用状态分支；凭据通过 Actions Secrets 提供。这个选择将代码、配置、执行和状态集中到 GitHub，省去常开主机、私有运行仓库与跨仓写入凭据，代价是状态公开且快照提交会增加 Git 历史。Telegram 指令在下一次成功运行时处理，定时任务采用串行执行，并遵守 GitHub 的[调度边界](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)，不能承诺准时运行或即时响应。
