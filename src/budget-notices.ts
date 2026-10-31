import { modelUsageLimits } from './config.ts';
import type { BudgetPauseReason, ModelBudgetStatus, MonitoringState, WatchTowerConfig } from './types.ts';

/** Operational reports share the outbox; obsolete undelivered reports are withdrawn. */
export function updateBudgetNotice(state: MonitoringState, config: WatchTowerConfig, budget: ModelBudgetStatus, now: string): void {
  const control = state.control ??= { manuallyPaused: false };
  const previous = control.budgetNotice ??= { fingerprint: null, sequence: 0 };
  const fingerprint = budget.pauseReason ? JSON.stringify({ month: budget.month, reason: budget.pauseReason, limits: modelUsageLimits(config) }) : null;
  if (previous.fingerprint === fingerprint) return;
  state.notifications = state.notifications.filter((notification) => {
    if (notification.kind !== 'budget-status' || notification.status !== 'pending') return true;
    if (!notification.attempts.length) return false;
    notification.withdrawnAt ??= now;
    return true;
  });
  previous.fingerprint = fingerprint;
  if (!budget.pauseReason) return;
  previous.sequence += 1;
  state.notifications.push({
    kind: 'budget-status', origin: 'proactive', id: `budget-status:${previous.sequence}`,
    text: `模型工作已暂停：${pauseLabel(budget.pauseReason)}。\n` +
      `月预算（UTC ${budget.month}）：已用 US$${budget.spentUsd.toFixed(4)} / US$${budget.monthlyBudgetUsd.toFixed(4)}。\n` +
      '未手动暂停时仍会采集候选，并继续处理本人指令。可用 /status 查阅；/resume 不会绕过用量限制。',
    createdAt: now, status: 'pending', sentAt: null, attempts: [],
  });
}

function pauseLabel(reason: BudgetPauseReason): string {
  return {
    'monthly-budget': '月预算已用尽', 'run-budget': '本轮费用达到限额', steps: '本轮模型请求步数达到限额',
    'input-size': '待处理输入超出请求规模限制', 'output-size': '输出规模超出配置限制',
    'unknown-cost': '已有模型调用的费用尚未完整确认', 'provider-limit': '服务方额度不足',
    'provider-unavailable': '暂时无法确认服务方额度',
  }[reason];
}
