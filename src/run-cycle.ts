import type { CandidateDecision, CycleResult, DevelopmentVerification, DigestEntry, ModelUsage, MonitoringState, RunCycleOptions, SourceEvidence, TelegramSendResult, WatchTowerConfig } from './types.ts';

export async function runCycle(options: RunCycleOptions): Promise<CycleResult> {
  const config = await options.loadConfig();
  validateConfiguration(config);
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await options.state.load();
  state.notifications ??= [];
  const discovered = await options.hn.discover({
    since: new Date(Date.parse(now) - 48 * 60 * 60 * 1000).toISOString(),
    until: now,
    minScore: 20,
  });
  const knownIds = new Set(state.candidates.map(({ story }) => story.id));
  for (const story of discovered) {
    if (!knownIds.has(story.id)) {
      state.candidates.push({ story, discoveredAt: now, status: 'pending', processedAt: null, topicIds: [] });
      knownIds.add(story.id);
    }
  }
  // A model/network failure must not discard candidates already collected.
  await options.state.save(state);
  const pending = state.candidates.filter(({ status }) => status === 'pending');
  let usage: CycleResult['usage'] = null;
  if (pending.length > 0) {
    const result = await options.model.analyze({ model: config.model, topics: config.topics, candidates: pending.map(({ story }) => story) });
    validateDecisions(result.decisions, pending.map(({ story }) => story.id), config);
    usage = result.usage;
    for (const decision of result.decisions) {
      const candidate = pending.find(({ story }) => story.id === decision.candidateId)!;
      candidate.status = 'processed';
      candidate.processedAt = now;
      candidate.topicIds = decision.topicIds;
      if (decision.topicIds.length > 0 && decision.significance) {
        candidate.notificationReview = { proposal: decision.significance, status: 'pending' };
      }
      if (decision.topicIds.length > 0) {
        state.digest.push({
          id: `digest:${candidate.story.id}`,
          candidateId: candidate.story.id,
          title: candidate.story.title,
          summary: decision.summary!,
          topicIds: decision.topicIds,
          sources: [
            ...(candidate.story.url ? [{ kind: 'original' as const, url: candidate.story.url }] : []),
            { kind: 'hn', url: candidate.story.hnUrl },
          ],
          createdAt: now,
        });
      }
    }
  }
  if (options.sources && options.model.verifyDevelopment) {
    for (const candidate of state.candidates.filter(({ notificationReview }) => notificationReview?.status === 'pending')) {
      const review = candidate.notificationReview!;
      if (!candidate.story.url) {
        review.status = 'complete';
        addUncertainty(state, candidate.story.id, '未提供可核实的链接来源。');
        continue;
      }
      const source = await options.sources.read({ candidateId: candidate.story.id, url: candidate.story.url });
      review.source = source;
      if (source.status !== 'read' || source.truncated || !source.text.trim() || source.id !== `source:${candidate.story.id}` || source.candidateId !== candidate.story.id || source.originalUrl !== candidate.story.url) {
        review.status = 'complete';
        addUncertainty(state, candidate.story.id, '来源正文未能完整核实，暂不主动通知。');
        continue;
      }
      const result = await options.model.verifyDevelopment({ model: config.model, topics: config.topics, candidate: candidate.story, proposal: review.proposal, source });
      usage = combineUsage(usage, result.usage);
      review.status = 'complete';
      if (!supportedVerification(result.verification, source)) {
        addUncertainty(state, candidate.story.id, '关键事实证据不足，暂不主动通知。');
        continue;
      }
      const { change, whyItMatters, claims } = result.verification;
      const sources = [{ kind: 'original' as const, url: source.finalUrl ?? source.originalUrl }, { kind: 'hn' as const, url: candidate.story.hnUrl }];
      state.notifications.push({
        id: `notification:${candidate.story.id}`, candidateId: candidate.story.id, topicIds: candidate.topicIds,
        text: `${change}\n\n意义：${whyItMatters}\n\n来源：${sources[0]!.url}\nHN 讨论：${candidate.story.hnUrl}`,
        change, whyItMatters, claims, sources, createdAt: now, status: 'pending', sentAt: null, attempts: [],
      });
    }
  }
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
  return cycleResult(state, usage, now);
}

function addUncertainty(state: MonitoringState, candidateId: string, note: string): void {
  const entry = state.digest.find((entry) => entry.candidateId === candidateId);
  if (entry) entry.summary += `（${note}）`;
}

function supportedVerification(verification: DevelopmentVerification, source: SourceEvidence): boolean {
  return verification?.supported === true && verification.uncertainty === null &&
    ['primary', 'secondary'].includes(verification.sourceRole) &&
    [verification.change, verification.whyItMatters].every((text) => typeof text === 'string' && text.length <= 700 && /\p{Script=Han}/u.test(text)) &&
    Array.isArray(verification.claims) && verification.claims.length > 0 && verification.claims.length <= 12 &&
    verification.claims.some(({ statement }) => statement === verification.change) &&
    verification.claims.every(({ statement, sourceId, quote }) => typeof statement === 'string' && statement.trim() && sourceId === source.id && typeof quote === 'string' && quote.trim().length >= 12 && source.text.includes(quote));
}

function combineUsage(left: ModelUsage | null, right: ModelUsage): ModelUsage {
  if (!left) return right;
  return {
    costUsd: left.costUsd === null || right.costUsd === null ? null : left.costUsd + right.costUsd,
    inputTokens: left.inputTokens === null || right.inputTokens === null ? null : left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens === null || right.outputTokens === null ? null : left.outputTokens + right.outputTokens,
    costComplete: left.costComplete === true && right.costComplete === true,
  };
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

function cycleResult(state: MonitoringState, usage: CycleResult['usage'], now: string): CycleResult {
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
