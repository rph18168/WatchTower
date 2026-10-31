# WatchTower

WatchTower 面向个人，监视 Hacker News 中与使用者配置的关注主题相关的信息。

## Language

**关注主题（Watch Topic）**：
使用者希望持续了解的内容描述，用于界定监视智能体判断帖子相关性的范围。
_Avoid_: 关键词（关键词可以描述主题，但不等同于主题本身）

**监视智能体（Monitoring Agent）**：
按关注主题发现并筛选相关 Hacker News 帖子的个人信息助手。

**候选帖子（Candidate Story）**：
已发现、尚待监视智能体判断是否相关的 Hacker News 帖子。

**初始基线（Initial Baseline）**：
监视智能体首次启用时已有的历史帖子及动态集合，用于区分存量与后续发现。

**历史候选（Archived Candidate）**：
已退出当前处理窗口、仅保留备查的候选帖子。

**动态（Development）**：
从一个或多个相关 Hacker News 帖子识别出的一件事件或实质变化。
_Avoid_: 帖子（多个帖子可能指向同一动态）

**重大动态（Significant Development）**：
有来源依据、具有显著价值，值得主动通知使用者的动态。

**摘要（Digest）**：
监视智能体对相关 Hacker News 帖子的简要记录，供使用者查阅。
_Avoid_: 日报（摘要本身不限定每日生成）

**通知（Notification）**：
监视智能体将重大动态主动送达给使用者的消息。

**个人接收方（Personal Recipient）**：
使用者本人用于接收监视智能体通知的私聊身份。

**待发送通知（Pending Notification）**：
已决定送达个人接收方、尚未确认送达的重大动态消息。
