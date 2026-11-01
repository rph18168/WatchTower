import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createGitHubSnapshotAdapter, createGitHubStateStore, createHackerNewsAdapter, runCycle } from '../src/index.ts';
import type { CandidateStory, DigestModelAdapter, MonitoringState, SourceEvidence, WatchTowerConfig } from '../src/index.ts';
import { githubProtocol } from './support/github.ts';
import { establishMonitoringState } from './support/state.ts';

const now = new Date('2026-11-01T01:00:00.000Z');
const config: WatchTowerConfig = {
  model: 'test/model', topics: [{ id: 'public-service', description: '面向居民的公共服务变化' }],
};
const usage = { costUsd: 0.001, inputTokens: 100, outputTokens: 50, costComplete: true };
const change = '公共自行车服务改为全年运营。';
const whyItMatters = '居民冬季也可使用这一出行服务。';
const hnBody = 'HN_TRANSIENT_BODY_SENTINEL_8f434 ' + 'An extended first person account of the new service. '.repeat(70);
const articleBody = 'SOURCE_TRANSIENT_BODY_SENTINEL_9c176 ' + 'The public bicycle service will now operate throughout every season of the year. '.repeat(70);
const story: CandidateStory = {
  id: '1001', title: 'Bicycle service becomes year round', url: 'https://city.example/bicycles',
  hnUrl: 'https://news.ycombinator.com/item?id=1001', score: 40, publishedAt: '2026-11-01T00:00:00.000Z', text: hnBody,
};
const sourceFor = (candidate: CandidateStory, text = articleBody): SourceEvidence => ({
  id: `source:${candidate.id}`, candidateId: candidate.id, originalUrl: candidate.url!, finalUrl: candidate.url,
  status: 'read', title: 'Public bicycle service', text, truncated: false,
});
const model: DigestModelAdapter = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }) => ({
    candidateId: id, topicIds: ['public-service'], summary: change, significance: { change, whyItMatters },
  })), usage }),
  verifyDevelopment: async ({ source }) => ({ verification: {
    supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary',
    claims: [{ statement: change, sourceId: source.id, quote: source.text }],
  }, usage }),
};

/** Observe the real GitHub transport's outgoing binary payloads, before commit. */
function publicRemote() {
  const protocol = githubProtocol();
  const snapshots: Buffer[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith('/git/blobs')) snapshots.push(Buffer.from(body.content, 'base64'));
    if (url.pathname === '/graphql') {
      for (const addition of body.variables.input.fileChanges.additions) {
        if (addition.path === 'state.sqlite') snapshots.push(Buffer.from(addition.contents, 'base64'));
      }
    }
    return protocol.fetch(input, init);
  };
  return {
    snapshots,
    github: createGitHubSnapshotAdapter({ repository: 'owner/WatchTower', token: 'test-github-token', fetch: fetcher }),
  };
}

test('完整周期的每个公开 SQLite 检查点只保留摘要和证据 hash，不发布 HN／来源长正文或逐字引文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-payload-'));
  const path = join(directory, 'state.sqlite');
  const remote = publicRemote();
  const state = createGitHubStateStore({ path, github: remote.github });
  try {
    await establishMonitoringState(state);
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] }, model,
      sources: { read: async () => sourceFor(story) },
      telegram: { send: async () => ({ status: 'sent', messageId: 'accepted-1001' }) }, clock: () => now,
    });
    assert.equal(result.digest[0]?.summary, change);
    assert.equal(result.notifications[0]?.messageId, 'accepted-1001');
    assert.equal(result.usage?.costUsd, 0.002);
    assert.equal(JSON.stringify(result).includes('SOURCE_TRANSIENT_BODY_SENTINEL_9c176'), false, 'the returned operator result uses the same public evidence projection');
    assert.ok(remote.snapshots.length > 4, 'includes discovery, budget reservations, evidence and delivery checkpoints');
    for (const bytes of [...remote.snapshots, await readFile(path)]) {
      assert.equal(bytes.includes(Buffer.from('HN_TRANSIENT_BODY_SENTINEL_8f434')), false, 'HN body is transient');
      assert.equal(bytes.includes(Buffer.from('SOURCE_TRANSIENT_BODY_SENTINEL_9c176')), false, 'source body and long quote are transient');
    }
    const durable = await state.load();
    assert.equal(durable.candidates[0]?.story.text, undefined);
    assert.match(durable.candidates[0]?.contentFingerprint ?? '', /^sha256:v1:[0-9a-f]{64}$/);
    assert.equal(durable.budget?.calls?.length, 2);
    assert.equal(durable.notifications[0]?.attempts[0]?.status, 'sent');
    assert.ok(durable.developments?.[0]?.revisions[0]?.claims.every(({ quote }) => !quote));
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('新 runner 用持久内容指纹区分未变正文、分数上涨和真实正文更新', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-fingerprint-'));
  const remote = publicRemote();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github: remote.github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github: remote.github });
  const third = createGitHubStateStore({ path: join(directory, 'third.sqlite'), github: remote.github });
  const ordinary: DigestModelAdapter = {
    getAllowance: model.getAllowance,
    analyze: async ({ candidates }) => {
      assert.equal(candidates[0]?.text, hnBody, 'the complete original HN material reaches the model in memory');
      return { decisions: [{ candidateId: story.id, topicIds: ['public-service'], summary: change }], usage };
    },
  };
  try {
    const initial = await runCycle({ loadConfig: async () => config, state: first, hn: { discover: async () => [story] }, model: ordinary, clock: () => now });
    first.close();
    const unchanged = await runCycle({
      loadConfig: async () => config, state: second, hn: { discover: async () => [{ ...story, score: 500 }] },
      model: { getAllowance: model.getAllowance, analyze: async () => { throw new Error('unchanged content must not spend again'); } }, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(unchanged.usage, null);
    assert.equal(unchanged.status.pendingCandidateCount, 0);
    assert.deepEqual(unchanged.digest, initial.digest);
    second.close();
    const updated = { ...story, text: hnBody + ' The service now opens fifty additional stations.' };
    const updatedSummary = '公共自行车新增五十个站点。';
    const changed = await runCycle({
      loadConfig: async () => config, state: third, hn: { discover: async () => [updated] },
      model: {
        getAllowance: model.getAllowance,
        analyze: async ({ candidates }) => {
          assert.equal(candidates[0]?.text, updated.text);
          return { decisions: [{ candidateId: story.id, topicIds: ['public-service'], summary: updatedSummary }], usage };
        },
        resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'substantive-update' }, usage }),
      }, clock: () => new Date('2026-11-01T01:30:00.000Z'),
    });
    assert.equal(changed.digest[0]?.summary, updatedSummary);
    assert.equal(changed.status.candidateCount, 1);
    assert.equal(changed.status.budget.spentUsd, 0.003);
  } finally { first.close(); second.close(); third.close(); await rm(directory, { recursive: true, force: true }); }
});

test('预算暂停后的文本型 HN 候选不在本轮发现结果中时按 ID 重取全文，不能降为元数据输入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-refetch-'));
  const remote = publicRemote();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github: remote.github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github: remote.github });
  let discovered = false;
  const textOnly = { ...story };
  delete textOnly.url;
  const hn = createHackerNewsAdapter({ fetch: async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'hn.algolia.com') {
      const hits = discovered ? [] : [{ objectID: story.id, title: story.title, url: null, story_text: hnBody, points: 40, created_at_i: Date.parse(story.publishedAt) / 1000 }];
      discovered = true;
      return Response.json({ hits, nbPages: hits.length ? 1 : 0, nbHits: hits.length });
    }
    assert.equal(url.href, `https://hacker-news.firebaseio.com/v0/item/${story.id}.json`);
    return Response.json({ id: Number(story.id), type: 'story', title: story.title, text: hnBody, score: 40, time: Date.parse(story.publishedAt) / 1000 });
  } });
  try {
    const paused = await runCycle({ loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state: first, hn, model, clock: () => now });
    assert.equal(paused.usage, null);
    assert.equal(paused.status.pendingCandidateCount, 1);
    assert.equal((await first.load()).candidates[0]?.story.text, undefined);
    first.close();
    const recovered = await runCycle({
      loadConfig: async () => config, state: second, hn,
      model: { getAllowance: model.getAllowance, analyze: async ({ candidates }) => {
        assert.deepEqual(candidates, [textOnly]);
        return { decisions: [{ candidateId: story.id, topicIds: ['public-service'], summary: change }], usage };
      } }, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(recovered.status.pendingCandidateCount, 0);
    assert.equal(recovered.digest[0]?.summary, change);
    assert.equal(recovered.usage?.costUsd, 0.001);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('来源核实后预算暂停，新 runner 仅继续剩余身份比较并保留已付费证据、历史与费用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-checkpoint-'));
  const remote = publicRemote();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github: remote.github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github: remote.github });
  const history = Array.from({ length: 10 }, (_, index) => ({
    ...story, id: `${1100 + index}`, title: `Public service ${index + 1}`, text: undefined,
    url: `https://services.example/${index + 1}`, hnUrl: `https://news.ycombinator.com/item?id=${1100 + index}`,
  }));
  const compared: string[] = [];
  const compare: NonNullable<DigestModelAdapter['resolveDevelopment']> = async ({ knownDevelopments, verifiedChange }) => {
    assert.equal(verifiedChange, change, 'paid source verification remains valid after reopening');
    compared.push(...knownDevelopments.map(({ revisionId }) => revisionId));
    const duplicate = knownDevelopments.find(({ summary }) => summary === change);
    return { resolution: duplicate ? { developmentId: duplicate.developmentId, revisionId: duplicate.revisionId, relation: 'duplicate' }
      : { developmentId: null, revisionId: null, relation: 'new' }, usage };
  };
  try {
    await establishMonitoringState(first);
    const initial = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 100, maxOutputTokens: 20_000 } }), state: first, hn: { discover: async () => history },
      model: { getAllowance: model.getAllowance, analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }, index) => ({
        candidateId: id, topicIds: ['public-service'], summary: index === 9 ? change : `第${index + 1}项公共服务已上线。`,
      })), usage }), resolveDevelopment: async () => ({ resolution: { developmentId: null, revisionId: null, relation: 'new' }, usage }) }, clock: () => now,
    });
    assert.equal(initial.digest.length, 10);
    const paused = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 3 } }), state: first, hn: { discover: async () => [story] },
      model: { ...model, resolveDevelopment: compare }, sources: { read: async () => sourceFor(story) }, clock: () => now,
    });
    assert.equal(paused.usage?.costUsd, 0.003);
    assert.equal(paused.status.budget.pauseReason, 'steps');
    assert.equal((await first.load()).candidates.find(({ story: candidate }) => candidate.id === story.id)?.developmentReview?.comparedRevisionIds.length, 8);
    first.close();
    const recovered = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 1 } }), state: second, hn: { discover: async () => [] },
      model: { getAllowance: model.getAllowance, analyze: async () => { throw new Error('digest already paid'); },
        verifyDevelopment: async () => { throw new Error('source verification already paid'); }, resolveDevelopment: compare },
      sources: { read: async () => { throw new Error('a validated evidence checkpoint needs no new body'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(recovered.usage?.costUsd, 0.001);
    assert.equal(recovered.digest.length, 10);
    assert.equal(recovered.notifications.length, 0, 'known ordinary history is not new news');
    assert.equal(compared.length, 10);
    assert.equal(new Set(compared).size, 10, 'completed comparisons survive reopening');
    const durable = await second.load();
    assert.equal(durable.budget?.calls?.length, 15);
    assert.ok(durable.budget?.calls?.every(({ status }) => status === 'complete'));
    assert.equal(durable.candidates.find(({ story: candidate }) => candidate.id === story.id)?.developmentReview?.status, 'complete');
    for (const bytes of remote.snapshots) assert.equal(bytes.includes(Buffer.from('SOURCE_TRANSIENT_BODY_SENTINEL_9c176')), false);
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('模型返回长正文充当摘要时不存档该返回，仍保留真实费用和待处理候选', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-model-output-'));
  const remote = publicRemote();
  const state = createGitHubStateStore({ path: join(directory, 'state.sqlite'), github: remote.github });
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] }, clock: () => now,
      model: { getAllowance: model.getAllowance, analyze: async () => ({
        decisions: [{ candidateId: story.id, topicIds: ['public-service'], summary: '中文摘要：' + hnBody }], usage,
      }) },
    }), /concise Chinese digest summary/);
    const durable = await state.load();
    assert.equal(durable.digest.length, 0);
    assert.equal(durable.candidates[0]?.status, 'pending');
    assert.equal(durable.budget?.calls?.[0]?.costUsd, 0.001);
    for (const bytes of remote.snapshots) assert.equal(bytes.includes(Buffer.from('HN_TRANSIENT_BODY_SENTINEL_8f434')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('模型把来源长段落装进有据变化时不把它变成公开摘要或通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-copied-claim-'));
  const remote = publicRemote();
  const state = createGitHubStateStore({ path: join(directory, 'state.sqlite'), github: remote.github });
  const copiedChange = '新变化：' + articleBody.slice(0, 240);
  try {
    await establishMonitoringState(state);
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] }, sources: { read: async () => sourceFor(story) },
      model: { ...model, verifyDevelopment: async ({ source }) => ({ verification: {
        supported: true, change: copiedChange, whyItMatters, uncertainty: null, sourceRole: 'primary',
        claims: [{ statement: copiedChange, sourceId: source.id, quote: source.text }],
      }, usage }) }, clock: () => now,
    });
    assert.equal(result.notifications.length, 0);
    assert.match(result.digest[0]?.summary ?? '', /证据不足/);
    const durable = await state.load();
    assert.equal(durable.candidates[0]?.notificationReview?.verification, undefined);
    assert.equal(durable.candidates[0]?.notificationReview?.checkpoint, undefined);
    assert.equal(durable.budget?.calls?.length, 2);
    for (const bytes of remote.snapshots) assert.equal(bytes.includes(Buffer.from('SOURCE_TRANSIENT_BODY_SENTINEL_9c176')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('旧 SQLite 的正文、长引文及已删除页残留在下一次公开快照前清除，付费核实和发送确认仍可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-legacy-pages-'));
  const seedPath = join(directory, 'legacy.sqlite');
  const path = join(directory, 'runner.sqlite');
  const remote = publicRemote();
  const legacy: MonitoringState = {
    schemaVersion: 1, lastRunAt: now.toISOString(),
    candidates: [{ story, discoveredAt: now.toISOString(), status: 'processed', processedAt: now.toISOString(), topicIds: ['public-service'], digestSummary: change,
      initialBaseline: true, developmentReview: { status: 'pending', comparedRevisionIds: [] },
      notificationReview: { status: 'pending', proposal: { change, whyItMatters }, source: sourceFor(story), verification: {
        supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: change, sourceId: `source:${story.id}`, quote: articleBody }],
      } } }],
    digest: [{ id: `digest:${story.id}`, candidateId: story.id, title: story.title, summary: change, topicIds: ['public-service'],
      sources: [{ kind: 'original', url: story.url! }, { kind: 'hn', url: story.hnUrl }], createdAt: now.toISOString() }],
    notifications: [{ kind: 'command-reply', origin: 'command-reply', id: 'command:old', text: '已保存的本人查询回复。', createdAt: now.toISOString(), status: 'sent',
      sentAt: now.toISOString(), messageId: 'accepted-before-migration', attempts: [{ at: now.toISOString(), status: 'sent', messageId: 'accepted-before-migration' }] }],
    budget: { pauseReason: null, calls: [{ id: 'paid-before-migration', startedAt: now.toISOString(), status: 'complete', model: config.model, responseId: 'receipt-before-migration', ...usage }] },
    initialBaseline: { since: '2026-10-30T01:00:00.000Z', until: now.toISOString(), status: 'building', completedAt: null },
    control: { manuallyPaused: false, telegramOffset: 8, lastHandledUpdateId: 7 },
  };
  legacy.notifications.push({ kind: 'development', origin: 'proactive', id: 'historic-news', candidateId: 'historic',
    text: '旧动态已确认。', change: '旧动态已确认。', whyItMatters: '保留已确认的历史。', topicIds: ['public-service'],
    claims: [{ statement: '旧模型返回：' + articleBody, sourceId: 'source:historic', quote: articleBody }], sources: [],
    createdAt: now.toISOString(), status: 'sent', sentAt: now.toISOString(), messageId: 'historic-accepted', attempts: [] });
  const database = new DatabaseSync(seedPath);
  try {
    database.exec('PRAGMA secure_delete=OFF; CREATE TABLE candidates(id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE digest_entries(id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE runtime_state(id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE discarded(payload TEXT);');
    database.prepare('INSERT INTO candidates VALUES (?, ?)').run(story.id, JSON.stringify(legacy.candidates[0]));
    database.prepare('INSERT INTO digest_entries VALUES (?, ?)').run(legacy.digest[0]!.id, JSON.stringify(legacy.digest[0]));
    const { candidates, digest, ...runtime } = legacy;
    database.prepare('INSERT INTO runtime_state VALUES (1, ?)').run(JSON.stringify(runtime));
    database.prepare('INSERT INTO discarded VALUES (?)').run('DELETED_PAGE_SENTINEL_7136 '.repeat(2000));
    database.exec('DELETE FROM discarded; DROP TABLE discarded;');
  } finally { database.close(); }
  const oldBytes = await readFile(seedPath);
  assert.ok(oldBytes.includes(Buffer.from('DELETED_PAGE_SENTINEL_7136')), 'the fixture contains real SQLite free-page residue');
  await remote.github.commitSnapshot({ expectedVersion: null, database: oldBytes });
  const firstNewSnapshot = remote.snapshots.length;
  const state = createGitHubStateStore({ path, github: remote.github });
  try {
    await runCycle({ commandsOnly: true, loadConfig: async () => config, state, hn: { discover: async () => { throw new Error('commands only'); } },
      model: { analyze: async () => { throw new Error('no new paid work'); } }, clock: () => now });
    for (const bytes of [...remote.snapshots.slice(firstNewSnapshot), await readFile(path)]) {
      for (const sentinel of ['DELETED_PAGE_SENTINEL_7136', 'HN_TRANSIENT_BODY_SENTINEL_8f434', 'SOURCE_TRANSIENT_BODY_SENTINEL_9c176']) {
        assert.equal(bytes.includes(Buffer.from(sentinel)), false);
      }
    }
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('digest already paid'); } }, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.equal(recovered.usage, null);
    const durable = await state.load();
    assert.equal(durable.candidates[0]?.notificationReview?.checkpoint?.validationVersion, 1);
    assert.equal(durable.developments?.[0]?.revisions[0]?.verified, true);
    assert.equal(durable.budget?.calls?.[0]?.responseId, 'receipt-before-migration');
    assert.equal(durable.notifications[0]?.messageId, 'accepted-before-migration');
    assert.equal(durable.notifications[0]?.status, 'sent');
    assert.equal(durable.control?.telegramOffset, 8);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('正文重取每轮有界且轮转，大候选不会让后面的可容纳候选永久饿死', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-refetch-bound-'));
  const remote = publicRemote();
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    ...story, id: `${1200 + index}`, hnUrl: `https://news.ycombinator.com/item?id=${1200 + index}`,
    text: index < 5 ? 'An oversized body that cannot fit a request. '.repeat(300) : 'The service is available throughout the year.',
  }));
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github: remote.github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github: remote.github });
  const third = createGitHubStateStore({ path: join(directory, 'third.sqlite'), github: remote.github });
  let reads = 0;
  const hn = { discover: async () => [], readStory: async ({ id }: { id: string }) => { reads++; return candidates.find((candidate) => candidate.id === id) ?? null; } };
  const ordinary: DigestModelAdapter = { getAllowance: model.getAllowance, analyze: async ({ candidates: admitted }) => {
    assert.deepEqual(admitted, [candidates[5]]);
    return { decisions: [{ candidateId: candidates[5]!.id, topicIds: ['public-service'], summary: change }], usage };
  } };
  try {
    await runCycle({ loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state: first, hn: { discover: async () => candidates }, model: ordinary, clock: () => now });
    first.close();
    const waiting = await runCycle({ loadConfig: async () => ({ ...config, usage: { maxInputBytes: 5000 } }), state: second, hn, model: ordinary, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.ok(reads <= 5, 'point fetches cannot exhaust a short runner with a whole backlog');
    assert.equal(waiting.usage, null);
    second.close();
    reads = 0;
    const progressed = await runCycle({ loadConfig: async () => ({ ...config, usage: { maxInputBytes: 5000 } }), state: third, hn, model: ordinary, clock: () => new Date('2026-11-01T01:30:00.000Z') });
    assert.ok(reads <= 5);
    assert.equal(progressed.digest[0]?.candidateId, candidates[5]!.id);
    assert.equal(progressed.status.pendingCandidateCount, 5);
  } finally { first.close(); second.close(); third.close(); await rm(directory, { recursive: true, force: true }); }
});

test('旧正文暂时重取失败不丢弃本轮新发现候选，也不向模型传入缺失正文的旧帖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-public-refetch-failure-'));
  const remote = publicRemote();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github: remote.github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github: remote.github });
  const fresh = { ...story, id: '1301', hnUrl: 'https://news.ycombinator.com/item?id=1301', text: undefined };
  try {
    await runCycle({ loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state: first, hn: { discover: async () => [story] }, model, clock: () => now });
    first.close();
    const result = await runCycle({
      loadConfig: async () => config, state: second,
      hn: { discover: async () => [fresh], readStory: async () => { throw new Error('temporary HN transport failure'); } },
      model: { getAllowance: model.getAllowance, analyze: async ({ candidates }) => {
        assert.deepEqual(candidates, [fresh]);
        return { decisions: [{ candidateId: fresh.id, topicIds: ['public-service'], summary: change }], usage };
      } }, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(result.status.candidateCount, 2);
    assert.equal(result.status.pendingCandidateCount, 1);
    assert.equal(result.status.fault?.code, 'candidate-discovery');
    assert.equal(result.digest[0]?.candidateId, fresh.id);
    assert.equal((await second.load()).candidates[0]?.status, 'pending');
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});
