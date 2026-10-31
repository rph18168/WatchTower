import { modelUsageLimits } from './config.ts';
import { replaceExpiredSummaryMembers } from './delivery.ts';
import type { DigestModelAdapter, MonitoringState, StoredCandidate, WatchTowerConfig } from './types.ts';

const windowMs = 48 * 60 * 60 * 1000;

/** Keep whole evidence, skip unfit items, and leave the remainder resumable. */
export function candidateBatch(pending: StoredCandidate[], config: WatchTowerConfig, model: DigestModelAdapter): StoredCandidate[] {
  const limits = modelUsageLimits(config);
  const maxCandidates = Math.max(1, Math.floor(limits.maxOutputTokens / 768));
  const batch: StoredCandidate[] = [];
  for (const candidate of pending) {
    const input = { model: config.model, topics: config.topics, candidates: [...batch, candidate].map(({ story }) => story) };
    const bytes = model.analyzeRequestBytes?.(input, limits.maxOutputTokens) ?? Buffer.byteLength(JSON.stringify(input), 'utf8');
    if (bytes <= limits.maxInputBytes) batch.push(candidate);
    if (batch.length >= maxCandidates) break;
  }
  return batch;
}

export function candidateContentAt(candidate: StoredCandidate): string {
  return candidate.contentUpdatedAt ?? candidate.story.publishedAt;
}

/** Archiving preserves raw candidates and any completed digest/verification. */
export function archiveExpiredCandidates(state: MonitoringState, now: string): void {
  const cutoff = Date.parse(now) - windowMs;
  for (const candidate of state.candidates) {
    if (Date.parse(candidateContentAt(candidate)) >= cutoff) continue;
    if (candidate.status !== 'pending' && candidate.notificationReview?.status !== 'pending' && candidate.developmentReview?.status !== 'pending') continue;
    candidate.archivedAt ??= now;
    if (candidate.status === 'pending') candidate.status = 'archived';
  }
}

/** Operational reports and requested replies do not carry news freshness. */
export function expireStaleNotifications(state: MonitoringState, at: Date): boolean {
  const pending = state.notifications.filter(({ status }) => status === 'pending');
  const count = state.notifications.length;
  const cutoff = at.getTime() - windowMs;
  for (const notification of state.notifications) {
    if (notification.status !== 'pending' || (notification.kind !== undefined && notification.kind !== 'development')) continue;
    const contentAt = notification.developmentAt ?? state.candidates.find(({ story }) => story.id === notification.candidateId)?.story.publishedAt ?? notification.createdAt;
    if (Date.parse(contentAt) >= cutoff) continue;
    notification.status = 'expired';
    notification.expiredAt = at.toISOString();
  }
  replaceExpiredSummaryMembers(state, at);
  return count !== state.notifications.length || pending.some(({ status }) => status !== 'pending');
}

/** Persist the installation cutoff before discovery or model work can fail. */
export function beginInitialBaseline(state: MonitoringState, now: string): void {
  if (state.initialBaseline) return;
  const until = state.lastRunAt ?? now;
  state.initialBaseline = {
    since: new Date(Date.parse(until) - windowMs).toISOString(), until,
    status: state.lastRunAt ? 'complete' : 'building', completedAt: state.lastRunAt,
  };
}

export function completeInitialBaseline(state: MonitoringState, now: string): void {
  const baseline = state.initialBaseline!;
  if (baseline.status === 'complete') return;
  const unfinished = state.candidates.some((candidate) => candidate.initialBaseline && !candidate.archivedAt && (
    candidate.status === 'pending' || candidate.notificationReview?.status === 'pending' || candidate.developmentReview?.status === 'pending'
  ));
  if (!unfinished) {
    baseline.status = 'complete';
    baseline.completedAt = now;
  }
}
