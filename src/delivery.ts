import { createHash } from 'node:crypto';
import type { DevelopmentNotification, MonitoringState, OvernightSummaryNotification, PendingNotification } from './types.ts';

const shanghaiHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
});
const summaryHeader = '夜间动态汇总\n\n';
const summarySeparator = '\n\n——\n\n';

/** The single admission policy for new deliveries and later retry attempts. */
export function deliveryAllowed(notification: PendingNotification, state: MonitoringState, at: Date): boolean {
  if (notification.kind === 'command-reply' && notification.origin === 'command-reply') return true;
  return !state.control?.manuallyPaused && notificationWindowOpen(at);
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
    isDevelopment(notification) && notification.status === 'pending' && !notification.summaryIds?.length &&
    !notificationWindowOpen(new Date(notification.createdAt)));
  if (!members.length) return;
  const sections = members.flatMap((member) => splitText(member.text, 4096 - summaryHeader.length).map((text) => ({ member, text })));
  queueSummarySections(state, sections, at);
}

/** A replacement keeps pending fragments in a summary and preserves sent ones. */
export function replaceExpiredSummaryMembers(state: MonitoringState, at: Date): void {
  for (const summary of state.notifications.filter((n): n is OvernightSummaryNotification => n.kind === 'overnight-summary' && n.status === 'pending')) {
    if (!summary.notificationIds.some((id) => state.notifications.some((member) => member.id === id && member.status === 'expired'))) continue;
    summary.status = 'expired';
    summary.expiredAt = at.toISOString();
    const members = state.notifications.filter(isDevelopment).filter(({ id }) => summary.notificationIds.includes(id));
    const storedSections = summary.sections ?? summary.text.slice(summaryHeader.length).split(summarySeparator).flatMap((text) => {
      const matches = members.filter((member) => member.text.includes(text));
      return matches.length === 1 ? [{ notificationId: matches[0]!.id, text }] : [];
    });
    const remaining = storedSections.flatMap(({ notificationId, text }) => {
      const member = members.find(({ id, status }) => id === notificationId && status === 'pending');
      return member ? [{ member, text }] : [];
    });
    queueSummarySections(state, remaining, at);
  }
}

function queueSummarySections(state: MonitoringState, sections: { member: DevelopmentNotification; text: string }[], at: Date): void {
  let batch: typeof sections = [];
  let batchLength = summaryHeader.length;
  const finishBatch = () => {
    if (!batch.length) return;
    const ids = [...new Set(batch.map(({ member }) => member.id))];
    const text = summaryHeader + batch.map(({ text }) => text).join(summarySeparator);
    const id = `overnight:${createHash('sha256').update(JSON.stringify({ ids, text })).digest('hex')}`;
    for (const member of new Set(batch.map(({ member }) => member))) {
      if (!(member.summaryIds ??= []).includes(id)) member.summaryIds.push(id);
    }
    if (!state.notifications.some((notification) => notification.id === id)) state.notifications.push({
      id, kind: 'overnight-summary', origin: 'proactive', notificationIds: ids, text,
      sections: batch.map(({ member, text }) => ({ notificationId: member.id, text })),
      createdAt: at.toISOString(), status: 'pending', sentAt: null, attempts: [],
    });
    batch = [];
    batchLength = summaryHeader.length;
  };
  for (const section of sections) {
    const addedLength = section.text.length + (batch.length ? summarySeparator.length : 0);
    if (batchLength + addedLength > 4096) finishBatch();
    batchLength += section.text.length + (batch.length ? summarySeparator.length : 0);
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
    if (member.status !== 'pending') continue;
    if (!notification.notificationIds.includes(member.id)) continue;
    if (!member.summaryIds?.every((id) => state.notifications.some((summary) => summary.id === id && (summary.status === 'sent' || summary.status === 'expired')))) continue;
    member.status = 'sent';
    member.sentAt = notification.sentAt;
    member.messageId = notification.messageId;
  }
}
