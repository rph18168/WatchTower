import type { createModelBudget } from './budget.ts';
import type { DevelopmentComparison, DevelopmentNotification, DevelopmentRecord, DevelopmentResolution, DevelopmentVerification, DigestEntry, DigestModelAdapter, MonitoringState, PendingNotification, SourceEvidence, StateStore, StoredCandidate, WatchTowerConfig } from './types.ts';
import { candidateContentAt } from './recovery.ts';
import { evidenceHash } from './state-payload.ts';

/** Old SQLite payloads retain delivery receipts while gaining separate identity. */
export function restoreDevelopmentHistory(state: MonitoringState): void {
  const developments = state.developments ??= [];
  for (const development of developments) {
    for (const revision of development.revisions) revision.verified ??= revision.claims.length > 0;
  }
  for (const notification of state.notifications.filter(isDevelopment).filter(({ developmentId }) => !developmentId)) {
    const candidate = state.candidates.find(({ story }) => story.id === notification.candidateId);
    const entry = state.digest.find(({ candidateId }) => candidateId === notification.candidateId);
    if (!entry) continue;
    let development = developments.find(({ id }) => id === candidate?.developmentId) ?? developments.find((known) => known.revisions.some(({ change }) => change === notification.change) &&
      known.sources.some(({ kind, url }) => kind === 'original' && notification.sources.some((source) => source.kind === kind && source.url === url)));
    if (!development) {
      development = {
        id: availableId(`development:${notification.candidateId}`, developments), candidateIds: [], topicIds: [], digestId: entry.id,
        sources: [], revisions: [], createdAt: notification.createdAt, updatedAt: notification.createdAt,
      };
      developments.push(development);
    }
    let revision = development.revisions.find(({ change }) => change === notification.change);
    if (!revision) {
      revision = {
        id: `${development.id}:revision:${development.revisions.length + 1}`, candidateIds: [], change: notification.change,
        summary: entry.summary, whyItMatters: notification.whyItMatters, claims: notification.claims, verified: true, createdAt: notification.createdAt, notificationId: notification.id,
      };
      development.revisions.push(revision);
    }
    revision.candidateIds = unique([...revision.candidateIds, notification.candidateId]);
    notification.developmentId = development.id;
    notification.revisionId = revision.id;
    notification.candidateIds ??= [notification.candidateId];
    restoreDigestAssociation(state, development, entry, candidate);
  }
  for (const entry of [...state.digest]) {
    if (entry.developmentId) continue;
    const candidate = state.candidates.find(({ story }) => story.id === entry.candidateId);
    if (!candidate || candidate.status !== 'processed' || candidate.developmentReview || candidate.notificationReview?.status === 'pending') continue;
    const development: DevelopmentRecord = {
      id: availableId(`development:${entry.candidateId}`, developments), candidateIds: [], topicIds: [], digestId: entry.id, sources: [],
      revisions: [{ id: `development:${entry.candidateId}:revision:1`, candidateIds: [entry.candidateId], change: entry.summary, summary: entry.summary, whyItMatters: '', claims: [], verified: false, createdAt: entry.createdAt }],
      createdAt: entry.createdAt, updatedAt: entry.createdAt,
    };
    developments.push(development);
    restoreDigestAssociation(state, development, entry, candidate);
  }
  for (const candidate of state.candidates.filter(({ status, notificationReview, developmentReview }) => status === 'processed' && notificationReview?.status === 'pending' && !developmentReview)) {
    candidate.digestSummary ??= state.digest.find(({ candidateId }) => candidateId === candidate.story.id)?.summary;
    candidate.developmentReview = { status: 'pending', comparedRevisionIds: [] };
  }
  // Repair legacy standalone payloads without resetting failure history or
  // changing the text already captured by durable overnight deliveries.
  for (const notification of state.notifications.filter(isDevelopment)) {
    if (notification.status !== 'pending' || notification.summaryIds?.length || notification.text.length <= 4096) continue;
    notification.text = notificationText(notification);
  }
}

function restoreDigestAssociation(state: MonitoringState, development: DevelopmentRecord, entry: DigestEntry, candidate: StoredCandidate | undefined): void {
  development.candidateIds = unique([...development.candidateIds, entry.candidateId]);
  development.topicIds = unique([...development.topicIds, ...entry.topicIds]);
  development.sources = mergeSources(development.sources, entry.sources);
  const target = state.digest.find(({ id }) => id === development.digestId)!;
  target.developmentId = development.id;
  target.candidateIds = development.candidateIds;
  target.topicIds = development.topicIds;
  target.sources = development.sources;
  if (target.id !== entry.id) state.digest = state.digest.filter(({ id }) => id !== entry.id);
  if (candidate) {
    candidate.developmentId = development.id;
    candidate.digestSummary ??= entry.summary;
    candidate.developmentReview ??= { status: 'complete', comparedRevisionIds: [] };
  }
}

/** Story, Development and delivery identities deliberately have separate records. */
export async function recordCandidateDevelopment(state: MonitoringState, candidate: StoredCandidate, now: string, context: {
  config: WatchTowerConfig; model: DigestModelAdapter; budget: ReturnType<typeof createModelBudget>; store: StateStore; allowNotification?: boolean;
}, evidence?: { verification: DevelopmentVerification; source: SourceEvidence }): Promise<boolean> {
  const developments = state.developments ??= [];
  const verification = evidence?.verification;
  const summary = candidate.digestSummary ?? state.digest.find(({ candidateId }) => candidateId === candidate.story.id)?.summary;
  if (!summary) return false;
  const change = verification?.change ?? summary;
  const sources: DigestEntry['sources'] = [
    ...(candidate.story.url ? [{ kind: 'original' as const, url: evidence?.source.finalUrl ?? candidate.story.url }] : []),
    { kind: 'hn', url: candidate.story.hnUrl },
  ];
  const cached = candidate.developmentReview?.match;
  let resolution = cached?.relation === 'duplicate' ? cached : undefined;
  let known = developments.find(({ id }) => id === resolution?.developmentId) ?? developments.find((development) => development.sources.some(({ kind, url }) => kind === 'original' && sources.some((source) => source.kind === kind && source.url === url)) &&
    development.revisions.some((revision) => sameKnownVersion(revision, change, verification)));
  if (!known && developments.length > 0 && context.model.resolveDevelopment) {
    const comparison = candidate.developmentReview ??= { status: 'pending', comparedRevisionIds: [] };
    const history: DevelopmentComparison[] = developments.flatMap((development) => development.revisions.map((revision) => ({
      developmentId: development.id, revisionId: revision.id, change: revision.change, summary: revision.summary ?? revision.change, verified: revision.verified,
      sourceUrls: development.sources.filter(({ kind }) => kind === 'original').slice(0, 4).map(({ url }) => url),
    })));
    for (let offset = 0; offset < history.length;) {
      const pending = history.slice(offset).filter(({ revisionId }) => !comparison.comparedRevisionIds.includes(revisionId));
      if (!pending.length) break;
      let size = Math.min(8, pending.length);
      let result: { resolution: DevelopmentResolution } | null;
      do {
        const batch = pending.slice(0, size);
        const { id, title, url, hnUrl } = candidate.story;
        const input = { model: context.config.model, candidate: { id, title, url, hnUrl }, summary, verifiedChange: verification?.change ?? null, knownDevelopments: batch };
        result = await context.budget.execute(input, (execution) => context.model.resolveDevelopment!({ ...input, execution }));
        if (result) {
          validateResolution(result.resolution, batch);
          comparison.comparedRevisionIds.push(...batch.map(({ revisionId }) => revisionId));
          if (result.resolution.relation !== 'new') comparison.match = result.resolution;
          await context.store.save(state);
        } else if (context.budget.status().pauseReason !== 'input-size' || size === 1) return false;
        else size = Math.max(1, Math.floor(size / 2));
      } while (!result);
      if (comparison.match?.relation === 'duplicate') break;
      offset += size;
    }
    resolution = comparison.match;
    known = developments.find(({ id }) => id === resolution?.developmentId);
  }
  const draft = state.digest.find((entry) => entry.candidateId === candidate.story.id && !entry.developmentId);
  const development: DevelopmentRecord = known ?? {
    id: availableId(`development:${candidate.story.id}`, developments), candidateIds: [], topicIds: [], sources: [], digestId: draft?.id ?? availableId(`digest:${candidate.story.id}`, state.digest),
    revisions: [], createdAt: now, updatedAt: now,
  };
  if (!known) {
    developments.push(development);
    if (!draft) state.digest.push({ id: development.digestId, candidateId: candidate.story.id, title: candidate.story.title, summary, topicIds: [], sources: [], createdAt: now });
  }
  candidate.developmentId = development.id;
  development.candidateIds = unique([...development.candidateIds, candidate.story.id]);
  development.topicIds = unique([...development.topicIds, ...candidate.topicIds]);
  development.sources = mergeSources(development.sources, sources);
  development.updatedAt = now;

  const digest = state.digest.find(({ id }) => id === development.digestId)!;
  if (resolution?.relation === 'substantive-update') {
    digest.title = candidate.story.title;
    digest.summary = summary;
  }
  digest.developmentId = development.id;
  digest.candidateIds = development.candidateIds;
  digest.topicIds = development.topicIds;
  digest.sources = development.sources;
  if (draft && draft.id !== digest.id) state.digest = state.digest.filter((entry) => entry.id !== draft.id);

  const existing = resolution?.relation === 'duplicate'
    ? development.revisions.find(({ id }) => id === resolution.revisionId)
    : resolution?.relation === 'substantive-update' ? undefined
    : development.revisions.find((revision) => sameKnownVersion(revision, change, verification));
  if (existing) {
    existing.candidateIds = unique([...existing.candidateIds, candidate.story.id]);
    const notification = state.notifications.filter(isDevelopment).find(({ id }) => id === existing.notificationId);
    if (notification) {
      notification.candidateIds = existing.candidateIds;
      notification.topicIds = development.topicIds;
      notification.sources = mergeSources(notification.sources, sources);
      if (notification.status === 'pending') notification.text = notificationText(notification);
    }
    return true;
  }
  const revisionId = `${development.id}:revision:${development.revisions.length + 1}`;
  const revision: DevelopmentRecord['revisions'][number] = {
    id: revisionId, candidateIds: [candidate.story.id], change, summary, whyItMatters: verification?.whyItMatters ?? '',
    claims: verification?.claims ?? [], verified: Boolean(verification), createdAt: now,
  };
  development.revisions.push(revision);
  if (!verification || context.allowNotification === false) return true;
  const id = availableId(`notification:${candidate.story.id}`, state.notifications);
  revision.notificationId = id;
  const notification: DevelopmentNotification = {
    kind: 'development', origin: 'proactive',
    id, candidateId: candidate.story.id, candidateIds: [candidate.story.id], developmentId: development.id, revisionId, developmentAt: candidateContentAt(candidate),
    topicIds: development.topicIds, text: '', change: verification.change, whyItMatters: verification.whyItMatters,
    claims: verification.claims, sources, createdAt: now, status: 'pending', sentAt: null, attempts: [],
  };
  notification.text = notificationText(notification);
  state.notifications.push(notification);
  return true;
}

function sameKnownVersion(revision: DevelopmentRecord['revisions'][number], change: string, verification: DevelopmentVerification | undefined): boolean {
  return revision.change === change && (!verification || verification.claims.every((claim) => revision.claims.some((known) => known.statement === claim.statement && evidenceHash(known) === evidenceHash(claim))));
}

function validateResolution(resolution: DevelopmentResolution, batch: DevelopmentComparison[]): void {
  if (resolution?.relation === 'new' && resolution.developmentId === null && resolution.revisionId === null) return;
  if (['duplicate', 'substantive-update'].includes(resolution?.relation) && batch.some(({ developmentId, revisionId }) => developmentId === resolution.developmentId && revisionId === resolution.revisionId)) return;
  throw new Error('Model response contains an unknown Development identity');
}

function notificationText(notification: DevelopmentNotification): string {
  const header = `${notification.change}\n\n意义：${notification.whyItMatters}\n\n`;
  const sources = notification.sources.map(({ kind, url }) => ({ kind, text: `${kind === 'original' ? '来源' : 'HN 讨论'}：${url}` }));
  const complete = header + sources.map(({ text }) => text).join('\n');
  if (complete.length <= 4096) return complete;

  // Keep claims intact and choose only whole links. The Digest and state keep
  // every source; reserving an HN link keeps the discussion traceable too.
  const footer = '\n\n完整来源见 /digest。';
  const selected = new Set<typeof sources[number]>();
  let length = header.length + footer.length;
  const include = (source: typeof sources[number]) => {
    const addedLength = source.text.length + (selected.size ? 1 : 0);
    if (length + addedLength > 4096) return;
    selected.add(source);
    length += addedLength;
  };
  const discussion = sources.find(({ kind }) => kind === 'hn');
  if (discussion) include(discussion);
  for (const source of sources) if (!selected.has(source)) include(source);
  return header + sources.filter((source) => selected.has(source)).map(({ text }) => text).join('\n') + footer;
}

function isDevelopment(notification: PendingNotification): notification is DevelopmentNotification {
  return notification.kind === undefined || notification.kind === 'development';
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function availableId(base: string, records: { id: string }[]): string {
  if (!records.some(({ id }) => id === base)) return base;
  let index = 2;
  while (records.some(({ id }) => id === `${base}:${index}`)) index++;
  return `${base}:${index}`;
}

function mergeSources(left: DigestEntry['sources'], right: DigestEntry['sources']): DigestEntry['sources'] {
  const result = [...left];
  for (const source of right) if (!result.some(({ kind, url }) => kind === source.kind && url === source.url)) result.push(source);
  return result;
}
