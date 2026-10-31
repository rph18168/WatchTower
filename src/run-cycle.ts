import type { CandidateDecision, CycleResult, DigestEntry, ModelBudgetStatus, MonitoringState, RunCycleOptions, WatchTowerConfig } from './types.ts';
import { createModelBudget } from './budget.ts';
import { modelUsageLimits } from './config.ts';

export async function runCycle(options: RunCycleOptions): Promise<CycleResult> {
  const config = await options.loadConfig();
  validateConfiguration(config);
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await options.state.load();
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
  }
  const budgetStatus = budget.status();
  state.lastRunAt = now;
  await options.state.save(state);
  return cycleResult(state, budget.usage(), now, budgetStatus);
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
