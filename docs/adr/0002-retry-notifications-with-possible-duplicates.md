# 通知优先送达，允许重试造成偶发重复

WatchTower 对暂时发送失败和发送结果不确定的通知自动重试，接受由此造成的偶发重复，优先降低消息遗漏的可能性。Telegram 的 [sendMessage](https://core.telegram.org/bots/api#sendmessage) 接口没有调用方幂等键；若消息已经送达但确认响应丢失，重试可能再次发送。待发送通知需要持久保存以便重启后继续处理，不能因为一次超时就将其视为已送达。
