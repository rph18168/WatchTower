import { createHash } from 'node:crypto';
import type { DevelopmentNotification, MonitoringState, PendingNotification } from './types.ts';

const shanghaiHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
});

/** The single admission policy for new deliveries and later retry attempts. */
export function deliveryAllowed(notification: PendingNotification, state: MonitoringState, at: Date): boolean {
  if (notification.kind === 'command-reply' && notification.origin === 'command-reply') return true;
  return !state.control?.manuallyPaused && notificationWindowOpen(at);
}

/** Retry scheduling never replaces the shared quiet-hours/pause admission. */
export function retryDue(notification: PendingNotification, state: MonitoringState, at: Date): boolean {
  const previous = notification.attempts.at(-1);
  if (previous) {
    const permanentlyFailed = previous.status === 'failed' && previous.permanent === true;
    if (permanentlyFailed && (previous.retryGeneration ?? 0) >= (state.control?.deliveryRetryGeneration ?? 0)) return false;
    // Start at one minute, doubling to six hours; Telegram may require longer.
    const backoff = Math.min(60_000 * 2 ** Math.min(notification.attempts.length - 1, 9), 6 * 60 * 60 * 1000);
    const retryAfter = previous.status !== 'sent' && previous.status !== 'in-flight' && Number.isSafeInteger(previous.retryAfterSeconds) && previous.retryAfterSeconds! > 0
      ? previous.retryAfterSeconds! * 1000 : 0;
    const delay = Math.max(backoff, retryAfter);
    if (!permanentlyFailed && !(at.getTime() >= Date.parse(previous.at) + delay)) return false;
  }
  return true;
}

function notificationWindowOpen(at: Date): boolean {
  const hour = Number(shanghaiHour.format(at));
  return hour >= 8 && hour < 23;
}

function isDevelopment(notification: PendingNotification): notification is DevelopmentNotification {
  return notification.kind === undefined || notification.kind === 'development';
}

/** Form durable deliveries before the same checkpoint used by every send. */
export function prepareOvernightSummaries(state: MonitoringState, at: Date): void {
  if (state.control?.manuallyPaused || !notificationWindowOpen(at)) return;
  const members = state.notifications.filter((notification): notification is DevelopmentNotification =>
    isDevelopment(notification) && notification.status === 'pending' && !notification.summaryIds?.length && notification.attempts.length === 0 &&
    !notificationWindowOpen(new Date(notification.createdAt)));
  if (!members.length) return;
  const header = '夜间动态汇总\n\n';
  const separator = '\n\n——\n\n';
  const sections = members.flatMap((member) => splitText(member.text, 4096 - header.length).map((text) => ({ member, text })));
  let batch: typeof sections = [];
  let batchLength = header.length;
  const finishBatch = () => {
    if (!batch.length) return;
    const ids = [...new Set(batch.map(({ member }) => member.id))];
    const text = header + batch.map(({ text }) => text).join(separator);
    const id = `overnight:${createHash('sha256').update(JSON.stringify({ ids, text })).digest('hex')}`;
    for (const member of new Set(batch.map(({ member }) => member))) (member.summaryIds ??= []).push(id);
    state.notifications.push({
      id, kind: 'overnight-summary', origin: 'proactive', notificationIds: ids, text,
      createdAt: at.toISOString(), status: 'pending', sentAt: null, attempts: [],
    });
    batch = [];
    batchLength = header.length;
  };
  for (const section of sections) {
    const addedLength = section.text.length + (batch.length ? separator.length : 0);
    if (batchLength + addedLength > 4096) finishBatch();
    batchLength += section.text.length + (batch.length ? separator.length : 0);
    batch.push(section);
  }
  finishBatch();
}

function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + limit, text.length);
    // Preserve a supplementary character when the UTF-16 boundary bisects it.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

/** Summary members remain in the outbox as evidence, never as a second send. */
export function ownsDelivery(notification: PendingNotification): boolean {
  return !isDevelopment(notification) || !notification.summaryIds?.length;
}

export function confirmSummaryMembers(state: MonitoringState, notification: PendingNotification): void {
  if (notification.kind !== 'overnight-summary' || notification.status !== 'sent') return;
  for (const member of state.notifications.filter(isDevelopment)) {
    if (!notification.notificationIds.includes(member.id)) continue;
    if (!member.summaryIds?.every((id) => state.notifications.some((summary) => summary.id === id && summary.status === 'sent'))) continue;
    member.status = 'sent';
    member.sentAt = notification.sentAt;
    member.messageId = notification.messageId;
  }
}
