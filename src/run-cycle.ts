import type { CandidateDecision, CandidateStory, CycleResult, DigestEntry, ModelBudgetStatus, MonitoringFault, MonitoringState, RunCycleOptions, SourceEvidence, TelegramSendResult, WatchTowerConfig } from './types.ts';
import { BudgetAdmissionError, createModelBudget } from './budget.ts';
import { modelUsageLimits } from './config.ts';
import { updateBudgetNotice } from './budget-notices.ts';
import { recordCandidateDevelopment, restoreDevelopmentHistory } from './developments.ts';
import { confirmSummaryMembers, deliveryAllowed, deliveryAttempts, ownsDelivery, prepareOvernightSummaries, retryDue } from './delivery.ts';
import { archiveExpiredCandidates, beginInitialBaseline, candidateBatch, completeInitialBaseline, expireStaleNotifications } from './recovery.ts';
import { candidateFingerprint, conciseParaphrase, publicStatePayload, retainedEvidence } from './state-payload.ts';

export async function runCycle(provided: RunCycleOptions): Promise<CycleResult> {
  let persistenceFailed = false;
  const options: RunCycleOptions = { ...provided, state: {
    load: () => provided.state.load(),
    save: async (snapshot) => {
      try { await provided.state.save(snapshot); }
      catch (error) { persistenceFailed = true; throw error; }
    },
  } };
  const config = await options.loadConfig();
  validateConfiguration(config);
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await options.state.load();
  state.notifications ??= [];
  restoreDevelopmentHistory(state);
  const budget = createModelBudget({ state, store: options.state, config, model: options.model, clock: options.clock ?? (() => new Date()) });
  if (options.telegram?.getUpdates) {
    const control = state.control ??= { manuallyPaused: false };
    const updates = await externalOperation(options, state, now, 'telegram-updates', () => options.telegram!.getUpdates!({ offset: control.telegramOffset ?? 0 }));
    for (const update of updates.sort((a, b) => a.updateId - b.updateId)) {
      if (!Number.isSafeInteger(update.updateId) || update.updateId < (control.telegramOffset ?? 0)) continue;
      if (update.updateId > (control.lastHandledUpdateId ?? -1)) {
        if (update.command === 'pause' || update.command === 'resume') {
          control.manuallyPaused = update.command === 'pause';
          if (update.command === 'resume') control.deliveryRetryGeneration = (control.deliveryRetryGeneration ?? 0) + 1;
          const deliveryFault = state.notifications.some((notification) => notification.status === 'pending' && ownsDelivery(notification) && deliveryAttempts(notification, state).some((attempt) => 'permanent' in attempt && attempt.permanent));
          state.notifications.push({
            kind: 'command-reply', origin: 'command-reply', id: `command:${update.updateId}`,
            text: update.command === 'pause'
              ? '已暂停自动巡检和主动发送。仍可使用 /digest、/status 和 /resume。'
              : `已恢复自动巡检和主动发送；模型工作仍受应用预算和服务方额度限制。${deliveryFault ? '将允许修复后的发送故障再次尝试。' : ''}`,
            createdAt: now, status: 'pending', sentAt: null, attempts: [],
          });
        } else if (update.command === 'digest' || update.command === 'status') {
          const text = update.command === 'digest'
            ? state.digest.length ? renderDigest(state.digest) : '摘要暂为空；后续成功巡检会保留相关内容。'
            : renderStatus(state, budget.status(), now);
          for (const [index, part] of telegramParts(text).entries()) {
            state.notifications.push({
              kind: 'command-reply', origin: 'command-reply', id: `command:${update.updateId}:${index}`,
              text: part, createdAt: now, status: 'pending', sentAt: null, attempts: [],
            });
          }
        }
        control.lastHandledUpdateId = update.updateId;
        await options.state.save(state);
      }
      // Only a durable command result may be acknowledged in the next poll.
      control.telegramOffset = update.updateId + 1;
      await options.state.save(state);
    }
  }
  const manuallyPaused = state.control?.manuallyPaused === true;
  const autonomousEnabled = !manuallyPaused && !options.commandsOnly;
  let automaticFailed = false;
  let automaticFailure: unknown;
  let phase: MonitoringFault['code'] = 'candidate-discovery';
  try {
    if (autonomousEnabled) {
      beginInitialBaseline(state, now);
      await options.state.save(state);
    }
    const discovered = !autonomousEnabled ? [] : await externalOperation(options, state, now, 'candidate-discovery', () => options.hn.discover({
      since: new Date(Date.parse(now) - 48 * 60 * 60 * 1000).toISOString(),
      until: now,
      minScore: 20,
    }));
    if (autonomousEnabled) {
      archiveExpiredCandidates(state, now);
      const cursor = state.candidates.findIndex(({ story }) => story.id === state.storyRefreshCursor);
      const ordered = [...state.candidates.slice(cursor + 1), ...state.candidates.slice(0, cursor + 1)];
      const missing = ordered.filter(({ status, archivedAt, hasStoryText, story }) => status === 'pending' && !archivedAt && hasStoryText && !story.text && !discovered.some(({ id }) => id === story.id));
      let unavailable = false;
      for (const candidate of missing.slice(0, 5)) {
        state.storyRefreshCursor = candidate.story.id;
        let story: CandidateStory | null | undefined;
        try {
          story = options.hn.readStory && await externalOperation(options, state, now, 'candidate-discovery', () => options.hn.readStory!({ id: candidate.story.id }));
        } catch (error) {
          if (persistenceFailed) throw error;
          unavailable = true;
          continue;
        }
        if (story?.id === candidate.story.id) discovered.push(story);
        else unavailable = true;
      }
      if (unavailable) (state.control ??= { manuallyPaused: false }).fault = { code: 'candidate-discovery', at: now };
    }
    const knownCandidates = new Map(state.candidates.map((candidate) => [candidate.story.id, candidate]));
    for (const story of discovered) {
      const candidate = knownCandidates.get(story.id);
      const contentFingerprint = candidateFingerprint(story);
      if (!candidate) {
        const added = { story, contentFingerprint, hasStoryText: Boolean(story.text), discoveredAt: now, status: 'pending' as const, processedAt: null, topicIds: [], initialBaseline: Date.parse(story.publishedAt) <= Date.parse(state.initialBaseline!.until) };
        state.candidates.push(added);
        knownCandidates.set(story.id, added);
      } else {
        if ((candidate.contentFingerprint ?? candidateFingerprint(candidate.story)) !== contentFingerprint) {
          candidate.initialBaseline = candidate.initialBaseline === true && candidate.developmentReview?.status !== 'complete';
          candidate.status = 'pending';
          candidate.processedAt = null;
          delete candidate.notificationReview;
          delete candidate.developmentReview;
          if (!candidate.initialBaseline) candidate.contentUpdatedAt = now;
          delete candidate.archivedAt;
        }
        candidate.story = story;
        candidate.contentFingerprint = contentFingerprint;
        candidate.hasStoryText = Boolean(story.text);
      }
    }
    archiveExpiredCandidates(state, now);
    // A model/network failure must not discard candidates already collected.
    await options.state.save(state);
    const allPending = !autonomousEnabled ? [] : state.candidates.filter(({ status }) => status === 'pending');
    const available = allPending.filter(({ hasStoryText, story }) => !hasStoryText || Boolean(story.text));
    const pending = candidateBatch(available, config, options.model);
    if (available.length && !pending.length) state.budget!.pauseReason = 'input-size';
    phase = 'model-processing';
    if (pending.length > 0) {
      const input = { model: config.model, topics: config.topics, candidates: pending.map(({ story }) => story) };
      const result = await budget.execute(input, (execution) => externalOperation(options, state, now, 'model-processing', () => options.model.analyze({ ...input, execution })));
      if (result) {
        validateDecisions(result.decisions, pending.map(({ story }) => story), config);
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
    if (autonomousEnabled && options.sources && options.model.verifyDevelopment) {
      for (const candidate of state.candidates.filter(({ notificationReview, archivedAt }) => !archivedAt && notificationReview?.status === 'pending')) {
        if (['monthly-budget', 'run-budget', 'steps', 'unknown-cost'].includes(budget.status().pauseReason ?? '')) break;
        const review = candidate.notificationReview!;
        if (retainedEvidence(candidate, now)) continue;
        const reviewAt = (options.clock ?? (() => new Date()))();
        if (review.nextSourceAttemptAt && Date.parse(review.nextSourceAttemptAt) > reviewAt.getTime()) continue;
        if (!candidate.story.url) {
          review.status = 'complete';
          addUncertainty(state, candidate.story.id, '未提供可核实的链接来源。');
          continue;
        }
        phase = 'source-reading';
        let source = review.source?.status === 'read' && review.source.text ? review.source : undefined;
        if (!source) {
          try { source = await options.sources.read({ candidateId: candidate.story.id, url: candidate.story.url }); }
          catch { source = { id: `source:${candidate.story.id}`, candidateId: candidate.story.id, originalUrl: candidate.story.url, status: 'unavailable', title: '', text: '', truncated: false, failureCode: 'network' }; }
        }
        review.source = source;
        if (source.status !== 'read' || source.truncated || !source.text.trim() || source.id !== `source:${candidate.story.id}` || source.candidateId !== candidate.story.id || source.originalUrl !== candidate.story.url) {
          if (source.status === 'unavailable' && ['network', 'timeout'].includes(source.failureCode ?? '')) {
            (state.control ??= { manuallyPaused: false }).fault = { code: 'source-reading', at: reviewAt.toISOString() };
            review.sourceFailures = (review.sourceFailures ?? 0) + 1;
            if (review.sourceFailures < 3) {
              review.nextSourceAttemptAt = new Date(reviewAt.getTime() + 15 * 60_000 * 2 ** (review.sourceFailures - 1)).toISOString();
              addUncertainty(state, candidate.story.id, '来源暂时不可用，稍后重试核实。');
              continue;
            }
          }
          clearUncertainty(state, candidate.story.id, '来源暂时不可用，稍后重试核实。');
          review.status = 'complete';
          addUncertainty(state, candidate.story.id, '来源正文未能完整核实，暂不主动通知。');
          continue;
        }
        delete review.nextSourceAttemptAt;
        if (state.control?.fault?.code === 'source-reading') delete state.control.fault;
        clearUncertainty(state, candidate.story.id, '来源暂时不可用，稍后重试核实。');
        // The linked page is the verification evidence. Do not repeat a possibly
        // large HN story body in this second, separately admitted model request.
        const { id, title, url, hnUrl, score, publishedAt } = candidate.story;
        const input = { model: config.model, topics: config.topics, candidate: { id, title, url, hnUrl, score, publishedAt }, proposal: review.proposal, source };
        phase = 'model-processing';
        const result = review.verification ? { verification: review.verification } : await budget.execute(input, (execution) => externalOperation(options, state, now, 'model-processing', () => options.model.verifyDevelopment!({ ...input, execution })));
        if (!result) continue;
        review.verification = result.verification;
        if (!retainedEvidence(candidate, now)) {
          delete review.verification;
          review.status = 'complete';
          addUncertainty(state, candidate.story.id, '关键事实证据不足，暂不主动通知。');
          continue;
        }
      }
    }
    if (autonomousEnabled) {
      phase = 'model-processing';
      for (const candidate of state.candidates.filter(({ status, developmentReview, archivedAt }) => !archivedAt && status === 'processed' && developmentReview?.status === 'pending')) {
        const review = candidate.notificationReview;
        const evidence = retainedEvidence(candidate, now);
        if (review?.status === 'pending' && !evidence) continue;
        if (await recordCandidateDevelopment(state, candidate, now, { config, model: options.model, budget, store: options.state, allowNotification: !candidate.initialBaseline }, evidence)) {
          candidate.developmentReview!.status = 'complete';
          if (review) review.status = 'complete';
        }
      }
    }
  } catch (error) {
    // A failed durable checkpoint forbids starting any batch of external sends.
    if (persistenceFailed) throw error;
    automaticFailed = true;
    automaticFailure = error;
    (state.control ??= { manuallyPaused: false }).fault = { code: phase, at: now };
  }
  if (autonomousEnabled && options.telegram?.getUpdates && budget.usage() === null && ['provider-limit', 'provider-unavailable'].includes(budget.status().pauseReason ?? '')) {
    await budget.refreshAllowance();
  }
  const budgetStatus = budget.status();
  if (autonomousEnabled && !automaticFailed) completeInitialBaseline(state, now);
  if (options.telegram?.getUpdates) updateBudgetNotice(state, config, budgetStatus, now);
  expireStaleNotifications(state, (options.clock ?? (() => new Date()))());
  if (!options.commandsOnly) prepareOvernightSummaries(state, (options.clock ?? (() => new Date()))());
  if (!automaticFailed) state.lastRunAt = now;
  await options.state.save(state);
  if (options.telegram) {
    for (const notification of state.notifications.filter(({ status }) => status === 'pending')) {
      if (options.commandsOnly && notification.kind !== 'command-reply') continue;
      const startedAt = await refreshDeliveryFreshness(options, state);
      if (notification.status !== 'pending') continue;
      if (!ownsDelivery(notification) || !deliveryAllowed(notification, state, startedAt) || !retryDue(notification, state, startedAt)) continue;
      const attemptIndex = notification.attempts.length;
      const progress = { at: startedAt.toISOString(), ...(state.control?.deliveryRetryGeneration ? { retryGeneration: state.control.deliveryRetryGeneration } : {}) };
      notification.attempts.push({ ...progress, status: 'in-flight' });
      // This save includes the attempt as well as the queued text. A runner may
      // exit on either side of Telegram; recovery must see an unconfirmed start.
      await options.state.save(state);
      const attemptedAt = await refreshDeliveryFreshness(options, state);
      if (notification.status !== 'pending') continue;
      if (!deliveryAllowed(notification, state, attemptedAt)) continue;
      let result: TelegramSendResult;
      try { result = await options.telegram.send({ text: notification.text }); }
      catch { result = { status: 'unknown', failureCode: 'network' }; }
      notification.attempts[attemptIndex] = { ...progress, at: attemptedAt.toISOString(), ...result };
      if (result.status === 'sent' && typeof result.messageId === 'string' && result.messageId.trim()) {
        notification.status = 'sent';
        notification.sentAt = attemptedAt.toISOString();
        notification.messageId = result.messageId;
        confirmSummaryMembers(state, notification);
      }
      await options.state.save(state);
    }
  }
  if (automaticFailed) throw automaticFailure;
  return cycleResult(state, budget.usage(), now, budgetStatus);
}

async function refreshDeliveryFreshness(options: RunCycleOptions, state: MonitoringState): Promise<Date> {
  let at = (options.clock ?? (() => new Date()))();
  while (expireStaleNotifications(state, at)) {
    await options.state.save(state);
    at = (options.clock ?? (() => new Date()))();
  }
  return at;
}

async function externalOperation<T>(options: RunCycleOptions, state: MonitoringState, now: string, code: MonitoringFault['code'], operation: () => Promise<T>): Promise<T> {
  try {
    const result = await operation();
    if (state.control?.fault?.code === code) delete state.control.fault;
    return result;
  } catch (error) {
    if (error instanceof BudgetAdmissionError || (error && typeof error === 'object' && 'code' in error && error.code === 'provider-limit')) throw error;
    (state.control ??= { manuallyPaused: false }).fault = { code, at: now };
    await options.state.save(state);
    throw error;
  }
}

function addUncertainty(state: MonitoringState, candidateId: string, note: string): void {
  const candidate = state.candidates.find(({ story }) => story.id === candidateId);
  if (candidate?.digestSummary && !candidate.digestSummary.includes(note)) candidate.digestSummary += `（${note}）`;
  const entry = state.digest.find((entry) => entry.candidateId === candidateId);
  if (entry && !entry.developmentId && !entry.summary.includes(note)) entry.summary += `（${note}）`;
}

function clearUncertainty(state: MonitoringState, candidateId: string, note: string): void {
  const candidate = state.candidates.find(({ story }) => story.id === candidateId);
  if (candidate?.digestSummary) candidate.digestSummary = candidate.digestSummary.replace(`（${note}）`, '');
  const entry = state.digest.find((entry) => entry.candidateId === candidateId && !entry.developmentId);
  if (entry) entry.summary = entry.summary.replace(`（${note}）`, '');
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

function validateDecisions(decisions: CandidateDecision[], pendingStories: CandidateStory[], config: WatchTowerConfig): void {
  const remaining = new Set(pendingStories.map(({ id }) => id));
  const topicIds = new Set(config.topics.map(({ id }) => id));
  if (!Array.isArray(decisions)) throw new Error('Model response must contain candidate decisions');
  for (const decision of decisions) {
    if (!decision || !remaining.delete(decision.candidateId) || !Array.isArray(decision.topicIds) || decision.topicIds.some((id) => !topicIds.has(id)) || new Set(decision.topicIds).size !== decision.topicIds.length) {
      throw new Error('Model response contains an unknown or duplicate candidate/topic');
    }
    const originals = [pendingStories.find(({ id }) => id === decision.candidateId)?.text ?? ''];
    if (decision.topicIds.length > 0 && (!conciseParaphrase(decision.summary, originals) || !/\p{Script=Han}/u.test(decision.summary))) {
      throw new Error('Related candidates require a concise Chinese digest summary in their own words');
    }
    if (decision.topicIds.length > 0 && decision.significance && [decision.significance.change, decision.significance.whyItMatters].some((text) => !conciseParaphrase(text, originals) || !/\p{Script=Han}/u.test(text))) {
      throw new Error('Significance proposals require concise Chinese summaries');
    }
  }
  if (remaining.size > 0) throw new Error('Model response omitted candidate decisions');
}

function cycleResult(state: MonitoringState, usage: CycleResult['usage'], now: string, budget: ModelBudgetStatus): CycleResult {
  const processed = state.candidates.filter(({ status }) => status === 'processed').length;
  const snapshot = publicStatePayload(state);
  return {
    digest: snapshot.digest,
    markdown: renderDigest(snapshot.digest),
    notifications: snapshot.notifications,
    status: {
      manuallyPaused: state.control?.manuallyPaused === true,
      fault: state.control?.fault ?? null,
      candidateCount: state.candidates.length,
      processedCandidateCount: processed,
      pendingCandidateCount: state.candidates.filter(({ status }) => status === 'pending').length,
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

function renderStatus(state: MonitoringState, budget: ModelBudgetStatus, now: string): string {
  const provider = state.budget?.provider;
  const providerStatus = !provider ? '尚未检查；每次模型请求前单独核查'
    : provider.remainingUsd === null ? '未设 key 限额，不代表账户余额无限'
    : `已知剩余 US$${provider.remainingUsd.toFixed(4)}`;
  const pendingAttempts = state.notifications.filter((notification) => notification.status === 'pending' && ownsDelivery(notification))
    .flatMap((notification) => deliveryAttempts(notification, state).slice(-1));
  const permanent = pendingAttempts.filter((attempt) => 'permanent' in attempt && attempt.permanent).length;
  const uncertain = pendingAttempts.filter(({ status }) => ['unknown', 'in-flight'].includes(status)).length;
  const deliveryCodes = [...new Set(pendingAttempts.flatMap((attempt) => 'failureCode' in attempt ? [attempt.failureCode] : []))];
  return `WatchTower 状态（${now}）\n` +
    `自动巡检：${state.control?.manuallyPaused ? '手动暂停' : '运行中'}\n` +
    `模型工作：${budget.pauseReason ? `预算暂停（${budget.pauseReason}）` : '请求前仍需通过用量检查'}\n` +
    `月预算（UTC ${budget.month}）：已用 US$${budget.spentUsd.toFixed(4)} / US$${budget.monthlyBudgetUsd.toFixed(4)}，剩余 US$${budget.remainingUsd.toFixed(4)}\n` +
    `服务方额度：${providerStatus}${provider ? `；本月用量 US$${provider.usageMonthlyUsd.toFixed(4)}（${provider.checkedAt} 检查）` : ''}\n` +
    `待处理候选：${state.candidates.filter(({ status }) => status === 'pending').length}；待核实：${state.candidates.filter(({ notificationReview, archivedAt }) => !archivedAt && notificationReview?.status === 'pending').length}；待归并动态：${state.candidates.filter(({ developmentReview, archivedAt }) => !archivedAt && developmentReview?.status === 'pending').length}；待发送：${state.notifications.filter((notification) => notification.status === 'pending' && ownsDelivery(notification)).length}\n` +
    `初始基线：${state.initialBaseline?.status === 'complete' ? '已完成' : state.initialBaseline ? '构建中' : '尚未巡检'}；历史候选：${state.candidates.filter(({ status, archivedAt }) => status === 'archived' || archivedAt).length}\n` +
    `投递结果不确定：${uncertain}；不可恢复故障：${permanent}${deliveryCodes.length ? `（${deliveryCodes.join('、')}）` : ''}\n` +
    `最近成功周期：${state.lastRunAt ?? '尚无'}\n临时故障：${state.control?.fault ? `${faultLabel(state.control.fault.code)}（${state.control.fault.at}）` : '无'}`;
}

function faultLabel(code: MonitoringFault['code']): string {
  return { 'telegram-updates': 'Telegram 指令读取', 'candidate-discovery': '候选采集', 'model-processing': '模型处理', 'source-reading': '来源读取' }[code];
}

function telegramParts(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
