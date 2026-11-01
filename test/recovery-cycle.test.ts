import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, createSqliteStateStore, runCycle } from '../src/index.ts';
import type { CandidateStory, DigestModelAdapter, SourceReaderAdapter, WatchTowerConfig } from '../src/index.ts';
import { establishMonitoringState } from './support/state.ts';

const at = new Date('2026-11-01T01:00:00.000Z');
const config: WatchTowerConfig = { model: 'test/model', topics: [{ id: 'science', description: '公共科研资料的新进展' }] };
const usage = { costUsd: 0.001, inputTokens: 120, outputTokens: 80, costComplete: true };
const story = (id: string, publishedAt = '2026-11-01T00:00:00.000Z'): CandidateStory => ({
  id, title: `Public observations ${id}`, url: `https://science.example/${id}`,
  hnUrl: `https://news.ycombinator.com/item?id=${id}`, score: 40, publishedAt,
});

test('48 小时积压按真实 SDK 请求与输出上限跨周期推进，单个超大候选可恢复且不饿死小项', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-backlog-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const oversized = { ...story('610'), text: '完整而不能截断的证据。'.repeat(4000) };
  const small = ['611', '612', '613', '614'].map((id) => ({ ...story(id), text: 'Public observations. '.repeat(80) }));
  const requests: { ids: string[]; bytes: number; output: number }[] = [];
  const sdk = createOpenRouterAdapter({ apiKey: 'offline-only', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 100, limit_remaining: 100, usage_monthly: 0 } });
    const body = await input.text();
    const request = JSON.parse(body);
    const candidates: CandidateStory[] | undefined = JSON.parse(request.input).candidates;
    if (candidates) {
      requests.push({ ids: candidates.map(({ id }) => id), bytes: Buffer.byteLength(body), output: request.max_output_tokens });
      assert.equal(candidates[0]?.text, small.find(({ id }) => id === candidates[0]?.id)?.text);
    }
    const data = candidates ? { decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['science'], summary: change(id), significance: null })) } : { relation: 'new', developmentId: null, revisionId: null };
    const response = {
      id: `gen-${requests.length}`, object: 'response', model: 'test/model', created_at: 1793494800, completed_at: 1793494801,
      error: null, incomplete_details: null, instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
      temperature: null, top_p: null, parallel_tool_calls: false, status: 'completed', tool_choice: 'none', tools: [],
      output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.001 },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try {
    const first = await runCycle({ loadConfig: async () => ({ ...config, usage: { maxInputBytes: 6000, maxOutputTokens: 256 } }), state, hn: { discover: async () => [oversized, ...small] }, model: sdk, clock: () => at });
    assert.equal(first.digest.length, 1);
    assert.equal(first.status.pendingCandidateCount, 4);
    assert.equal((await state.load()).initialBaseline?.status, 'building');
    for (let cycle = 0; cycle < 3; cycle++) {
      state.close(); state = createSqliteStateStore(path);
      await runCycle({ loadConfig: async () => ({ ...config, usage: { maxInputBytes: 6000, maxOutputTokens: 256 } }), state,
        hn: { discover: async () => [], readStory: async ({ id }) => [oversized, ...small].find((candidate) => candidate.id === id) ?? null },
        model: sdk, clock: () => new Date(at.getTime() + (cycle + 1) * 900_000) });
    }
    const durable = await state.load();
    assert.deepEqual(durable.digest.map(({ candidateId }) => candidateId), small.map(({ id }) => id));
    assert.equal(durable.candidates[0]?.story.text, undefined);
    assert.equal(durable.candidates[0]?.hasStoryText, true);
    assert.match(durable.candidates[0]?.contentFingerprint ?? '', /^sha256:v1:[0-9a-f]{64}$/);
    assert.equal(durable.candidates[0]?.status, 'pending');
    assert.equal(requests.length, 4);
    assert.equal(requests.every(({ ids, bytes, output }) => ids.length === 1 && bytes <= 6000 && output === 256), true);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});
const change = (id: string) => `科研机构开放第${id}批观测资料。`;
const sources: SourceReaderAdapter = { read: async ({ candidateId, url }) => ({
  id: `source:${candidateId}`, candidateId, originalUrl: url, finalUrl: url, status: 'read',
  title: 'Public archive', text: `Our institute opens observation archive ${candidateId} to the public today.`, truncated: false,
}) };
const model: DigestModelAdapter = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }) => ({
    candidateId: id, topicIds: ['science'], summary: change(id),
    significance: { change: change(id), whyItMatters: '研究者可查阅新的公开观测。' },
  })), usage }),
  verifyDevelopment: async ({ candidate, source }) => ({ verification: {
    supported: true, change: change(candidate.id), whyItMatters: '研究者可查阅新的公开观测。',
    uncertainty: null, sourceRole: 'primary', claims: [{ statement: change(candidate.id), sourceId: source.id, quote: source.text }],
  }, usage }),
};

test('首次基线保存摘要和已核实的已知动态，首次及重启后均不推历史通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-baseline-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  const telegram = { send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: 'baseline' }; } };
  try {
    const first = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story('601')] }, model, sources, telegram, clock: () => at });
    assert.equal(first.digest[0]?.summary, change('601'));
    assert.deepEqual(first.notifications, []);
    assert.deepEqual(sent, []);
    const durable = await state.load();
    assert.equal(durable.initialBaseline?.status, 'complete');
    assert.equal(durable.developments?.[0]?.revisions[0]?.verified, true);
    assert.equal(durable.developments?.[0]?.revisions[0]?.notificationId, undefined);
    state.close();
    state = createSqliteStateStore(path);
    const restarted = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story('601')] }, model: { analyze: async () => { throw new Error('基线已完成'); } }, telegram, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.deepEqual(restarted.digest, first.digest);
    assert.deepEqual(restarted.notifications, []);
    assert.deepEqual(sent, []);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('预算不足不误标基线完成；跨月恢复只补最近 48 小时，更早候选留历史且不伪造摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-recovery-window-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const old = { ...story('620', '2026-10-30T00:00:00.000Z'), text: 'Original evidence retained verbatim.' };
  const recent = story('621', '2026-10-31T23:00:00.000Z');
  const fresh = story('622', '2026-11-02T00:00:00.000Z');
  const sent: string[] = [];
  try {
    const paused = await runCycle({ loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state, hn: { discover: async () => [old, recent] }, model, sources, clock: () => new Date('2026-10-31T23:45:00.000Z') });
    assert.equal(paused.digest.length, 0);
    assert.equal(paused.status.pendingCandidateCount, 2);
    assert.equal((await state.load()).initialBaseline?.status, 'building');
    state.close(); state = createSqliteStateStore(path);
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [fresh] }, model: { ...model, analyze: async (request) => {
      assert.deepEqual(request.candidates.map(({ id }) => id), ['621', '622']);
      return model.analyze(request);
    } }, sources, telegram: { send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: 'recovered' }; } }, clock: () => new Date('2026-11-02T01:00:00.000Z') });
    assert.deepEqual(recovered.digest.map(({ candidateId }) => candidateId), ['621', '622']);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]?.includes(change('622')));
    const durable = await state.load();
    assert.equal(durable.initialBaseline?.status, 'complete');
    assert.equal(durable.candidates[0]?.status, 'archived');
    assert.equal(durable.candidates[0]?.processedAt, null);
    const oldMetadata: CandidateStory = { ...old };
    delete oldMetadata.text;
    assert.deepEqual(durable.candidates[0]?.story, oldMetadata);
    assert.match(durable.candidates[0]?.contentFingerprint ?? '', /^sha256:v1:[0-9a-f]{64}$/);
    assert.equal(recovered.status.pendingCandidateCount, 0);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('恢复重试前移除夜间汇总中过期成员，保留尝试与已确认批次且不拆成逐条重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-freshness-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const older = story('630', '2026-10-31T22:00:00.000Z');
  const recent = story('631', '2026-11-01T22:00:00.000Z');
  const attempts: string[] = [];
  try {
    await establishMonitoringState(state);
    for (const candidate of [older, recent]) {
      await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [candidate] }, model, sources, clock: () => new Date(candidate.publishedAt) });
    }
    const first = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model, telegram: { send: async ({ text }) => { attempts.push(text); return { status: 'unknown', failureCode: 'network' }; } }, clock: () => new Date('2026-11-02T00:00:00.000Z') });
    const originalSummary = first.notifications.find(({ kind }) => kind === 'overnight-summary')!;
    assert.equal(attempts.length, 1);
    assert.ok(attempts[0]?.includes(change('630')) && attempts[0]?.includes(change('631')));
    state.close(); state = createSqliteStateStore(path);
    const delivered: string[] = [];
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model, telegram: { send: async ({ text }) => { delivered.push(text); return { status: 'sent', messageId: 'fresh-summary' }; } }, clock: () => new Date('2026-11-03T00:00:00.000Z') });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /夜间动态汇总/);
    assert.ok(delivered[0]?.includes(change('631')));
    assert.ok(!delivered[0]?.includes(change('630')));
    const expired = recovered.notifications.find(({ id }) => id === originalSummary.id)!;
    assert.equal(expired.status, 'expired');
    assert.deepEqual(expired.attempts, originalSummary.attempts);
    assert.equal(expired.sentAt, null);
    assert.equal(recovered.notifications.find((n) => 'candidateId' in n && n.candidateId === '630')?.status, 'expired');
    assert.equal(recovered.notifications.find((n) => 'candidateId' in n && n.candidateId === '631')?.status, 'sent');
    state.close(); state = createSqliteStateStore(path);
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model, telegram: { send: async () => { throw new Error('已确认的新汇总不能逐条重发'); } }, clock: () => new Date('2026-11-03T00:15:00.000Z') });
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('近期来源暂时超时保留待核实进度，重启后有界重试而不重复付费摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-source-recovery-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let reads = 0;
  let verifications = 0;
  try {
    await establishMonitoringState(state);
    const first = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story('640')] }, model, sources: { read: async ({ candidateId, url }) => { reads++; return { id: `source:${candidateId}`, candidateId, originalUrl: url, status: 'unavailable', title: '', text: '', truncated: false, failureCode: 'timeout' }; } }, clock: () => at });
    assert.equal(first.digest.length, 1);
    assert.equal(first.notifications.length, 0);
    assert.equal((await state.load()).candidates[0]?.notificationReview?.status, 'pending');
    state.close(); state = createSqliteStateStore(path);
    const recoveringModel: DigestModelAdapter = { ...model, analyze: async () => { throw new Error('摘要已保存'); }, verifyDevelopment: async (request) => { verifications++; return model.verifyDevelopment!(request); } };
    const recoveringSources: SourceReaderAdapter = { read: async (request) => { reads++; return sources.read(request); } };
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model: recoveringModel, sources: recoveringSources, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.equal(reads, 1);
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model: recoveringModel, sources: recoveringSources, telegram: { send: async () => ({ status: 'sent', messageId: 'source-recovered' }) }, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.equal(reads, 2);
    assert.equal(verifications, 1);
    assert.equal(recovered.notifications[0]?.status, 'sent');
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('空状态先处理操作命令，首次真正巡检仍以巡检时刻建立基线', async (t) => {
  for (const commands of [['status'], ['pause', 'resume']] as const) {
    await t.test(commands.join('/'), async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-command-before-baseline-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      const delivered: string[] = [];
      try {
        for (const [index, command] of commands.entries()) {
          await runCycle({ loadConfig: async () => config, state, commandsOnly: true, hn: { discover: async () => { throw new Error('操作周期不采集'); } }, model,
            telegram: { getUpdates: async () => [{ updateId: index + 1, command }], send: async ({ text }) => { delivered.push(text); return { status: 'sent', messageId: `command-${index}` }; } }, clock: () => new Date(at.getTime() + index * 900_000) });
        }
        assert.equal((await state.load()).initialBaseline, undefined);
        const commandCount = delivered.length;
        const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story('650', '2026-11-01T01:30:00.000Z')] }, model, sources,
          telegram: { getUpdates: async () => [], send: async ({ text }) => { delivered.push(text); return { status: 'sent', messageId: 'unexpected-history' }; } }, clock: () => new Date('2026-11-01T02:00:00.000Z') });
        assert.equal(delivered.length, commandCount);
        assert.equal(result.digest.length, 1);
        assert.equal((await state.load()).initialBaseline?.until, '2026-11-01T02:00:00.000Z');
      } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
});

test('汇总移除过期成员后的替代消息仍遵守原限流等待，不复制成虚假的发送尝试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-retry-inheritance-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const sent: string[] = [];
  const oldId = 'news:old'; const freshId = 'news:fresh'; const summaryId = 'summary:limited';
  const oldText = '已过期的旧观测资料开放。'; const freshText = '仍有价值的新观测资料开放。';
  const initialAttempt = { at: '2026-11-01T00:59:00.000Z', status: 'failed' as const, failureCode: 'rate-limited' as const, retryAfterSeconds: 3600 };
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], lastRunAt: at.toISOString(), notifications: [
      ...[{ id: oldId, candidateId: 'old', text: oldText, developmentAt: '2026-10-30T01:00:00.000Z' }, { id: freshId, candidateId: 'fresh', text: freshText, developmentAt: '2026-10-31T12:00:00.000Z' }].map((n) => ({ ...n, kind: 'development' as const, change: n.text, whyItMatters: '可供研究者查阅。', topicIds: ['science'], claims: [], sources: [], createdAt: '2026-10-31T23:00:00.000Z', status: 'pending' as const, sentAt: null, attempts: [], summaryIds: [summaryId] })),
      { id: summaryId, kind: 'overnight-summary', origin: 'proactive', notificationIds: [oldId, freshId], sections: [{ notificationId: oldId, text: oldText }, { notificationId: freshId, text: freshText }], text: `夜间动态汇总\n\n${oldText}\n\n——\n\n${freshText}`, createdAt: initialAttempt.at, status: 'pending', sentAt: null, attempts: [initialAttempt] },
    ] });
    const options = { loadConfig: async () => config, state, hn: { discover: async () => [] }, model, telegram: { send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: 'after-original-delay' }; } } };
    const waiting = await runCycle({ ...options, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.deepEqual(sent, []);
    const replacement = waiting.notifications.find((n) => n.kind === 'overnight-summary' && n.status === 'pending')!;
    assert.deepEqual(replacement.attempts, []);
    const recovered = await runCycle({ ...options, clock: () => new Date('2026-11-01T01:59:00.000Z') });
    assert.deepEqual(sent, [`夜间动态汇总\n\n${freshText}`]);
    assert.deepEqual(recovered.notifications.find(({ id }) => id === summaryId)?.attempts, [initialAttempt]);
    assert.equal(recovered.notifications.find(({ id }) => id === freshId)?.status, 'sent');
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('基线因预算中断后候选改写标题，未完成的历史内容仍属基线而不成为新通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-baseline-interrupted-content-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  try {
    await runCycle({ loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state, hn: { discover: async () => [story('660')] }, model, clock: () => at });
    state.close(); state = createSqliteStateStore(path);
    const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [{ ...story('660'), title: 'Reworded archive headline' }] }, model, sources,
      telegram: { send: async () => { throw new Error('未处理的历史基线不能变成新通知'); } }, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.equal(result.notifications.length, 0);
    assert.equal(result.digest[0]?.summary, change('660'));
    assert.equal((await state.load()).initialBaseline?.status, 'complete');
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('远端发送检查点耗时跨过 48 小时后停止旧新闻；命令回复与当前运行报告仍可送达', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-freshness-checkpoint-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let clock = at;
  const delivered: string[] = [];
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], lastRunAt: at.toISOString(), notifications: [
      { id: 'news', kind: 'development', candidateId: 'old', developmentAt: '2026-10-30T01:00:02.000Z', text: '旧新闻', change: '旧动态', whyItMatters: '旧意义', topicIds: ['science'], claims: [], sources: [], createdAt: at.toISOString(), status: 'pending', sentAt: null, attempts: [] },
      { id: 'earlier-news', kind: 'development', candidateId: 'earlier', developmentAt: '2026-10-30T01:00:00.000Z', text: '更早新闻', change: '更早动态', whyItMatters: '旧意义', topicIds: ['science'], claims: [], sources: [], createdAt: at.toISOString(), status: 'pending', sentAt: null, attempts: [] },
      { id: 'reply', kind: 'command-reply', origin: 'command-reply', text: '本人查询回复', createdAt: '2026-10-01T00:00:00.000Z', status: 'pending', sentAt: null, attempts: [] },
      { id: 'report', kind: 'budget-status', origin: 'proactive', text: '当前运行报告', createdAt: '2026-10-01T00:00:00.000Z', status: 'pending', sentAt: null, attempts: [] },
    ] });
    const result = await runCycle({ loadConfig: async () => config, state: { load: () => state.load(), save: async (snapshot) => {
      await state.save(snapshot);
      if (snapshot.notifications.some(({ id, status, attempts }) => id === 'news' && status === 'pending' && attempts.at(-1)?.status === 'in-flight')) {
        // The attempt checkpoint expires the other item; persisting that expiry
        // takes the current delivery past its own limit as well.
        const earlierExpired = snapshot.notifications.some(({ id, status }) => id === 'earlier-news' && status === 'expired');
        clock = new Date(earlierExpired ? '2026-11-01T01:00:03.000Z' : '2026-11-01T01:00:01.000Z');
      }
    } }, hn: { discover: async () => [] }, model,
    telegram: { send: async ({ text }) => { delivered.push(text); return { status: 'sent', messageId: 'current' }; } }, clock: () => clock });
    assert.deepEqual(delivered, ['本人查询回复', '当前运行报告']);
    const old = result.notifications.find(({ id }) => id === 'news')!;
    assert.equal(old.status, 'expired');
    assert.equal(old.sentAt, null);
    assert.equal(old.attempts[0]?.status, 'in-flight');
    assert.equal((await state.load()).notifications[0]?.status, 'expired');
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('暂时来源失败最多尝试三次且间隔递增，不重复摘要或产生无界核实费用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-source-retry-ceiling-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let reads = 0; let analyses = 0; let verifications = 0;
  try {
    await establishMonitoringState(state);
    for (const [index, time] of ['01:00', '01:01', '01:15', '01:44', '01:45', '02:00'].entries()) {
      await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => index ? [] : [story('665')] },
        model: { ...model, analyze: async (request) => { analyses++; return model.analyze(request); }, verifyDevelopment: async (request) => { verifications++; return model.verifyDevelopment!(request); } },
        sources: { read: async ({ candidateId, url }) => { reads++; return { id: `source:${candidateId}`, candidateId, originalUrl: url, status: 'unavailable', title: '', text: '', truncated: false, failureCode: 'network' }; } }, clock: () => new Date(`2026-11-01T${time}:00.000Z`) });
    }
    assert.equal(reads, 3); assert.equal(analyses, 1); assert.equal(verifications, 0);
    const durable = await state.load();
    assert.equal(durable.notifications.length, 0);
    assert.equal(durable.candidates[0]?.notificationReview?.status, 'complete');
    assert.equal(durable.budget?.calls?.length, 1);
    assert.match(durable.digest[0]!.summary, /来源正文未能完整核实/);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('动态恢复按当前修订时间判断；新来源的纯重复不刷新旧通知，实质修订不受旧主帖时间拖累', async (t) => {
  for (const relation of ['duplicate', 'substantive-update'] as const) {
    await t.test(relation, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-revision-freshness-'));
      const path = join(directory, 'state.sqlite');
      let state = createSqliteStateStore(path);
      const original = story('680'); const next = { ...story('681', '2026-11-03T01:00:00.000Z'), url: original.url };
      try {
        await establishMonitoringState(state);
        await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [original] }, model, sources, clock: () => at });
        state.close(); state = createSqliteStateStore(path);
        const delivered: string[] = [];
        const nextChange = relation === 'duplicate' ? change('680') : change('681');
        const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [next] },
          model: { ...model, verifyDevelopment: async ({ source }) => ({ verification: { supported: true, change: nextChange, whyItMatters: '研究者可查阅新的公开观测。', uncertainty: null, sourceRole: 'primary', claims: [{ statement: nextChange, sourceId: source.id, quote: source.text }] }, usage }), resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { developmentId: knownDevelopments[0]!.developmentId, revisionId: knownDevelopments[0]!.revisionId, relation }, usage }) }, sources,
          telegram: { send: async ({ text }) => { delivered.push(text); return { status: 'sent', messageId: 'new-revision' }; } }, clock: () => new Date('2026-11-03T01:15:00.000Z') });
        assert.equal(recovered.notifications[0]?.status, 'expired');
        assert.equal(recovered.notifications[0]?.sentAt, null);
        assert.equal(delivered.length, relation === 'duplicate' ? 0 : 1);
        assert.equal(recovered.digest.length, 1);
        if (relation === 'substantive-update') assert.ok(delivered[0]?.includes(change('681')));
      } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
});

test('过期清理不重发已确认的夜间批次，未确认批次只补仍新鲜的成员', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-confirmed-progress-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const older = ['690', '691', '692'].map((id) => story(id, '2026-10-31T22:00:00.000Z'));
  const recent = story('693', '2026-11-01T22:00:00.000Z');
  const longChange = (id: string) => change(id) + '新观测资料。'.repeat(105);
  const longModel: DigestModelAdapter = { ...model, verifyDevelopment: async ({ candidate, source }) => ({ verification: {
    supported: true, change: longChange(candidate.id), whyItMatters: '研究者可比较。'.repeat(95), uncertainty: null, sourceRole: 'primary',
    claims: [{ statement: longChange(candidate.id), sourceId: source.id, quote: source.text }],
  }, usage }) };
  try {
    await establishMonitoringState(state);
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => older }, model: longModel, sources, clock: () => new Date('2026-10-31T22:00:00.000Z') });
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [recent] }, model: longModel, sources, clock: () => new Date(recent.publishedAt) });
    const sent: string[] = [];
    const first = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
      telegram: { send: async ({ text }) => { sent.push(text); return sent.length === 1 ? { status: 'sent', messageId: 'confirmed-first-batch' } : { status: 'unknown', failureCode: 'network' }; } }, clock: () => new Date('2026-11-02T00:00:00.000Z') });
    assert.equal(sent.length, 2);
    const confirmed = first.notifications.find((n) => n.kind === 'overnight-summary' && n.status === 'sent')!;
    assert.ok(sent[0]?.includes(change('690')) && sent[0]?.includes(change('691')));
    assert.ok(sent[1]?.includes(change('692')) && sent[1]?.includes(change('693')));
    state.close(); state = createSqliteStateStore(path);
    const recoveredSends: string[] = [];
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
      telegram: { send: async ({ text }) => { recoveredSends.push(text); return { status: 'sent', messageId: 'fresh-remainder' }; } }, clock: () => new Date('2026-11-03T00:00:00.000Z') });
    assert.equal(recoveredSends.length, 1);
    assert.ok(recoveredSends[0]?.includes(change('693')) && !recoveredSends[0]?.includes(change('692')));
    assert.deepEqual(recovered.notifications.find(({ id }) => id === confirmed.id), confirmed);
    for (const id of ['690', '691']) assert.equal(recovered.notifications.find((n) => 'candidateId' in n && n.candidateId === id)?.sentAt, '2026-11-02T00:00:00.000Z');
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('替代汇总继承的永久故障继续显示在状态查询，恢复命令仍授予一次新机会', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-status-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const delivered: string[] = [];
  const summaryId = 'summary:permanent';
  try {
    const summary = { id: summaryId, kind: 'overnight-summary' as const, origin: 'proactive' as const, notificationIds: ['old', 'fresh'],
      sections: [{ notificationId: 'old', text: '旧动态' }, { notificationId: 'fresh', text: '新动态' }], text: '夜间动态汇总\n\n旧动态\n\n——\n\n新动态',
      createdAt: at.toISOString(), status: 'pending' as const, sentAt: null, attempts: [{ at: at.toISOString(), status: 'failed' as const, failureCode: 'recipient-unavailable' as const, permanent: true }] };
    await state.save({ schemaVersion: 1, candidates: [], digest: [], lastRunAt: at.toISOString(), notifications: [
      ...['old', 'fresh'].map((id) => ({ id, kind: 'development' as const, candidateId: id, developmentAt: id === 'old' ? '2026-10-29T00:00:00.000Z' : '2026-11-01T00:00:00.000Z', text: id === 'old' ? '旧动态' : '新动态', change: '资料开放。', whyItMatters: '可查阅。', claims: [], sources: [], topicIds: ['science'], summaryIds: [summaryId], createdAt: at.toISOString(), status: 'pending' as const, sentAt: null, attempts: [] })), summary,
    ] });
    const common = { loadConfig: async () => config, state, hn: { discover: async () => [] }, model, clock: () => new Date('2026-11-01T01:15:00.000Z') };
    const send = async ({ text }: { text: string }) => { delivered.push(text); return { status: 'sent' as const, messageId: 'diagnosed' }; };
    await runCycle({ ...common, telegram: { send } });
    assert.equal(delivered.length, 0);
    await runCycle({ ...common, commandsOnly: true, telegram: { send, getUpdates: async () => [{ updateId: 1, command: 'status' }] } });
    assert.match(delivered[0]!, /不可恢复故障：1（recipient-unavailable）/);
    await runCycle({ ...common, telegram: { send, getUpdates: async () => [{ updateId: 2, command: 'resume' }] } });
    assert.equal(delivered.filter((text) => text.startsWith('夜间动态汇总')).length, 1);
    assert.match(delivered.find((text) => text.startsWith('已恢复'))!, /发送故障再次尝试/);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});
