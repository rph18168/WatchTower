# 以 SQLite 作为恢复状态的唯一事实来源

摘要、去重记录、待发送通知和运行状态统一保存在 SQLite，通过事务保存关联状态，以替代教程中分散的 JSON 文件并支持崩溃恢复。Markdown 作为可导出的阅读副本，避免数据库与文件成为两套相互矛盾的状态。数据库事务不覆盖 Telegram 等外部系统的执行结果，通知发送仍遵循[自动重试并允许偶发重复的决策](./0002-retry-notifications-with-possible-duplicates.md)。
