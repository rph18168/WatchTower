import type { CandidateDecision, CycleResult, DevelopmentVerification, DigestEntry, ModelBudgetStatus, MonitoringState, RunCycleOptions, SourceEvidence, TelegramSendResult, WatchTowerConfig } from './types.ts';
import { createModelBudget } from './budget.ts';
import { modelUsageLimits } from './config.ts';
import { recordCandidateDevelopment, restoreDevelopmentHistory } from './developments.ts';

export async function runCycle(options: RunCycleOptions): Promise<CycleResult> {
  const config = await options.loadConfig();
  validateConfiguration(config);
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await options.state.load();
  state.notifications ??= [];
  restoreDevelopmentHistory(state);
  const discovered = await options.hn.discover({
    since: new Date(Date.parse(now) - 48 * 60 * 60 * 1000).toISOString(),
    until: now,
    minScore: 20,
  });
  const knownCandidates = new Map(state.candidates.map((candidate) => [candidate.story.id, candidate]));
  for (const story of discovered) {
    const candidate = knownCandidates.get(story.id);
    if (!candidate) {
      const added = { story, discoveredAt: now, status: 'pending' as const, processedAt: null, topicIds: [] };
      state.candidates.push(added);
      knownCandidates.set(story.id, added);
    } else {
      if (candidate.story.title !== story.title || candidate.story.url !== story.url || candidate.story.text !== story.text) {
        candidate.status = 'pending';
        candidate.processedAt = null;
        delete candidate.notificationReview;
        delete candidate.developmentReview;
      }
      candidate.story = story;
    }
  }
  // A model/network failure must not discard candidates already collected.
  await options.state.save(state);
  const pending = state.candidates.filter(({ status }) => status === 'pending');
  const budget = createModelBudget({ state, store: options.state, config, model: options.model, clock: options.clock ?? (() => new Date()) });
  if (pending.length > 0) {
    const input = { model: config.model, topics: config.topics, candidates: pending.map(({ story }) => story) };
    const result = await budget.execute(input, (execution) => options.model.analyze({ ...input, execution }));
    if (result) {
      validateDecisions(result.decisions, pending.map(({ story }) => story.id), config);
      for (const decision of result.decisions) {
        const candidate = pending.find(({ story }) => story.id === decision.candidateId)!;
        candidate.status = 'processed';
        candidate.processedAt = now;
        candidate.topicIds = decision.topicIds;
        candidate.digestSummary = decision.summary ?? undefined;
        if (decision.topicIds.length > 0) candidate.developmentReview = { status: 'pending', comparedRevisionIds: [] };
        if (decision.topicIds.length > 0 && decision.significance) {
          candidate.notificationReview = { proposal: decision.significance, status: 'pending' };
        }
        if (decision.topicIds.length > 0) {
          const entry = {
            id: `digest:${candidate.story.id}`,
            candidateId: candidate.story.id,
            title: candidate.story.title,
            summary: decision.summary!,
            topicIds: decision.topicIds,
            sources: [
              ...(candidate.story.url ? [{ kind: 'original' as const, url: candidate.story.url }] : []),
              { kind: 'hn' as const, url: candidate.story.hnUrl },
            ],
            createdAt: now,
          };
          const existing = state.digest.findIndex(({ id }) => id === entry.id);
          if (existing === -1) state.digest.push(entry);
          else if (!state.digest[existing]!.developmentId) state.digest[existing] = entry;
        }
      }
    }
  }
  if (options.sources && options.model.verifyDevelopment) {
    for (const candidate of state.candidates.filter(({ notificationReview }) => notificationReview?.status === 'pending')) {
      if (['monthly-budget', 'run-budget', 'steps', 'unknown-cost'].includes(budget.status().pauseReason ?? '')) break;
      const review = candidate.notificationReview!;
      if (!candidate.story.url) {
        review.status = 'complete';
        addUncertainty(state, candidate.story.id, '未提供可核实的链接来源。');
        continue;
      }
      const source = review.verification && review.source ? review.source : await options.sources.read({ candidateId: candidate.story.id, url: candidate.story.url });
      review.source = source;
      if (source.status !== 'read' || source.truncated || !source.text.trim() || source.id !== `source:${candidate.story.id}` || source.candidateId !== candidate.story.id || source.originalUrl !== candidate.story.url) {
        review.status = 'complete';
        addUncertainty(state, candidate.story.id, '来源正文未能完整核实，暂不主动通知。');
        continue;
      }
      // The linked page is the verification evidence. Do not repeat a possibly
      // large HN story body in this second, separately admitted model request.
      const { id, title, url, hnUrl, score, publishedAt } = candidate.story;
      const input = { model: config.model, topics: config.topics, candidate: { id, title, url, hnUrl, score, publishedAt }, proposal: review.proposal, source };
      const result = review.verification ? { verification: review.verification } : await budget.execute(input, (execution) => options.model.verifyDevelopment!({ ...input, execution }));
      if (!result) continue;
      review.verification = result.verification;
      if (!supportedVerification(result.verification, source)) {
        review.status = 'complete';
        addUncertainty(state, candidate.story.id, '关键事实证据不足，暂不主动通知。');
        continue;
      }
    }
  }
  for (const candidate of state.candidates.filter(({ status, developmentReview }) => status === 'processed' && developmentReview?.status === 'pending')) {
    const review = candidate.notificationReview;
    const evidence = review?.source && review.verification && supportedVerification(review.verification, review.source)
      ? { verification: review.verification, source: review.source } : undefined;
    if (review?.status === 'pending' && !evidence) continue;
    if (await recordCandidateDevelopment(state, candidate, now, { config, model: options.model, budget, store: options.state }, evidence)) {
      candidate.developmentReview!.status = 'complete';
      if (review) review.status = 'complete';
    }
  }
  const budgetStatus = budget.status();
  state.lastRunAt = now;
  await options.state.save(state);
  if (options.telegram) {
    for (const notification of state.notifications.filter(({ status }) => status === 'pending')) {
      let result: TelegramSendResult;
      try { result = await options.telegram.send({ text: notification.text }); }
      catch { result = { status: 'unknown', failureCode: 'network' }; }
      notification.attempts.push({ at: now, ...result });
      if (result.status === 'sent' && typeof result.messageId === 'string' && result.messageId.trim()) {
        notification.status = 'sent';
        notification.sentAt = now;
        notification.messageId = result.messageId;
      }
      await options.state.save(state);
    }
  }
  return cycleResult(state, budget.usage(), now, budgetStatus);
}

function addUncertainty(state: MonitoringState, candidateId: string, note: string): void {
  const candidate = state.candidates.find(({ story }) => story.id === candidateId);
  if (candidate?.digestSummary) candidate.digestSummary += `（${note}）`;
  const entry = state.digest.find((entry) => entry.candidateId === candidateId);
  if (entry && !entry.developmentId) entry.summary += `（${note}）`;
}

function supportedVerification(verification: DevelopmentVerification, source: SourceEvidence): boolean {
  return verification?.supported === true && verification.uncertainty === null &&
    ['primary', 'secondary'].includes(verification.sourceRole) &&
    [verification.change, verification.whyItMatters].every((text) => typeof text === 'string' && text.length <= 700 && /\p{Script=Han}/u.test(text)) &&
    Array.isArray(verification.claims) && verification.claims.length > 0 && verification.claims.length <= 12 &&
    verification.claims.some(({ statement }) => statement === verification.change) &&
    verification.claims.every(({ statement, sourceId, quote }) => typeof statement === 'string' && statement.trim() && sourceId === source.id && typeof quote === 'string' && quote.trim().length >= 12 && source.text.includes(quote));
}

function validateConfiguration(config: WatchTowerConfig): void {
  if (!config || !Array.isArray(config.topics) || config.topics.length === 0 || typeof config.model !== 'string' || !config.model.trim()) {
    throw new Error('Configuration requires a model and at least one Watch Topic');
  }
  const ids = new Set<string>();
  for (const topic of config.topics) {
    if (!topic || typeof topic.id !== 'string' || !topic.id.trim() || typeof topic.description !== 'string' || !topic.description.trim() || ids.has(topic.id)) {
      throw new Error('Watch Topics require unique IDs and nonempty descriptions');
    }
    ids.add(topic.id);
  }
  modelUsageLimits(config);
}

function validateDecisions(decisions: CandidateDecision[], pendingIds: string[], config: WatchTowerConfig): void {
  const remaining = new Set(pendingIds);
  const topicIds = new Set(config.topics.map(({ id }) => id));
  if (!Array.isArray(decisions)) throw new Error('Model response must contain candidate decisions');
  for (const decision of decisions) {
    if (!decision || !remaining.delete(decision.candidateId) || !Array.isArray(decision.topicIds) || decision.topicIds.some((id) => !topicIds.has(id)) || new Set(decision.topicIds).size !== decision.topicIds.length) {
      throw new Error('Model response contains an unknown or duplicate candidate/topic');
    }
    if (decision.topicIds.length > 0 && (typeof decision.summary !== 'string' || !decision.summary.trim() || !/\p{Script=Han}/u.test(decision.summary))) {
      throw new Error('Related candidates require a Chinese digest summary');
    }
  }
  if (remaining.size > 0) throw new Error('Model response omitted candidate decisions');
}

function cycleResult(state: MonitoringState, usage: CycleResult['usage'], now: string, budget: ModelBudgetStatus): CycleResult {
  const processed = state.candidates.filter(({ status }) => status === 'processed').length;
  return {
    digest: state.digest,
    markdown: renderDigest(state.digest),
    notifications: state.notifications,
    status: {
      candidateCount: state.candidates.length,
      processedCandidateCount: processed,
      pendingCandidateCount: state.candidates.length - processed,
      lastRunAt: now,
      budget,
    },
    usage,
  };
}

function renderDigest(digest: DigestEntry[]): string {
  let markdown = '# WatchTower 摘要\n';
  for (const entry of digest) {
    markdown += `\n## ${entry.title}\n\n${entry.summary}\n\n- 关注主题：${entry.topicIds.join('、')}\n- 记录时间：${entry.createdAt}\n`;
    for (const source of entry.sources) {
      markdown += `- [${source.kind === 'hn' ? 'HN 讨论' : '原文'}](${source.url})\n`;
    }
  }
  return markdown;
}
