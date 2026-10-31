import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, createSqliteStateStore, runCycle } from '../src/index.ts';
import type { CandidateStory, DigestModelAdapter, SourceReaderAdapter, WatchTowerConfig } from '../src/index.ts';

const at = new Date('2026-11-01T01:00:00.000Z');
const config: WatchTowerConfig = { model: 'test/model', topics: [{ id: 'science', description: '公共科研资料的新进展' }] };
const usage = { costUsd: 0.001, inputTokens: 120, outputTokens: 80, costComplete: true };
const story = (id: string, publishedAt = '2026-11-01T00:00:00.000Z'): CandidateStory => ({
  id, title: `Public observations ${id}`, url: `https://science.example/${id}`,
  hnUrl: `https://news.ycombinator.com/item?id=${id}`, score: 40, publishedAt,
});

test('48 小时积压按真实 SDK 请求与输出上限跨周期推进，单个超大正文保留且不饿死小项', async () => {
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
      await runCycle({ loadConfig: async () => ({ ...config, usage: { maxInputBytes: 6000, maxOutputTokens: 256 } }), state, hn: { discover: async () => [] }, model: sdk, clock: () => new Date(at.getTime() + (cycle + 1) * 900_000) });
    }
    const durable = await state.load();
    assert.deepEqual(durable.digest.map(({ candidateId }) => candidateId), small.map(({ id }) => id));
    assert.equal(durable.candidates[0]?.story.text, oversized.text);
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

test('预算不足不误标基线完成；跨月恢复只补最近 48 小时，更早原始候选留历史且不伪造摘要', async () => {
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
    assert.deepEqual(durable.candidates[0]?.story, old);
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
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [], lastRunAt: '2026-10-29T00:00:00.000Z' });
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
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [], lastRunAt: '2026-10-29T00:00:00.000Z' });
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
