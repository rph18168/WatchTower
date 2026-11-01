import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTelegramSender, runCycle } from '../src/index.ts';
import { createEstablishedStateStore as createSqliteStateStore } from './support/state.ts';
import type { CandidateStory, DevelopmentNotification, DigestModelAdapter, PendingNotification, SourceEvidence } from '../src/index.ts';

const now = new Date('2026-11-01T01:00:00.000Z');
const config = {
  model: 'test/model',
  topics: [
    { id: 'mobility', description: '改善城市公共出行的服务变化' },
    { id: 'public-service', description: '面向居民的公共服务改善' },
  ],
};
const usage = { costUsd: 0.001, inputTokens: 100, outputTokens: 50, costComplete: true };
const change = '公共自行车服务扩展为全年运营。';
const whyItMatters = '居民冬季也可使用公共自行车。';
const quote = 'Our public bicycle service will operate throughout the year starting today.';
const first: CandidateStory = {
  id: '501', title: 'Bicycle service becomes year round', url: 'https://city.example/bicycles',
  hnUrl: 'https://news.ycombinator.com/item?id=501', score: 30, publishedAt: '2026-11-01T00:00:00.000Z',
};
const duplicate: CandidateStory = { ...first, id: '502', title: 'Winter bicycle service', hnUrl: 'https://news.ycombinator.com/item?id=502' };
const sourceFor = (story: CandidateStory, text = quote): SourceEvidence => ({
  id: `source:${story.id}`, candidateId: story.id, originalUrl: story.url!, finalUrl: story.url,
  status: 'read', title: 'Bicycle service', text, truncated: false,
});
const model: DigestModelAdapter = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({
    decisions: candidates.map(({ id }) => ({
      candidateId: id, topicIds: id === '501' ? ['mobility'] : ['public-service'],
      summary: '公共自行车服务现扩展为全年运营，冬季居民也可使用。', significance: { change, whyItMatters },
    })), usage,
  }),
  verifyDevelopment: async ({ source }) => ({
    verification: { supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: change, sourceId: source.id, quote: source.text }] }, usage,
  }),
};
const developmentNotifications = ({ notifications }: { notifications: PendingNotification[] }) =>
  notifications.filter((notification): notification is DevelopmentNotification => notification.kind === undefined || notification.kind === 'development');

test('同一动态跨帖子与关注主题合并来源、摘要和通知，SQLite 重开后重复讨论不再通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const sent: string[] = [];
  const telegram = { send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: `${sent.length}` }; } };
  try {
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [first, duplicate] }, model,
      sources: { read: async ({ candidateId }) => sourceFor(candidateId === first.id ? first : duplicate) }, telegram, clock: () => now,
    });
    assert.equal(sent.length, 1);
    assert.equal(result.digest.length, 1);
    assert.deepEqual(result.digest[0]?.topicIds, ['mobility', 'public-service']);
    assert.deepEqual(result.digest[0]?.sources, [
      { kind: 'original', url: first.url }, { kind: 'hn', url: first.hnUrl }, { kind: 'hn', url: duplicate.hnUrl },
    ]);
    assert.match(sent[0]!, /item\?id=501/);
    assert.match(sent[0]!, /item\?id=502/);
    state.close();
    state = await createSqliteStateStore(path);
    const third = { ...duplicate, id: '503', hnUrl: 'https://news.ycombinator.com/item?id=503' };
    const repeated = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [third] }, model,
      sources: { read: async () => sourceFor(third) }, telegram, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(sent.length, 1);
    assert.equal(repeated.notifications.length, 1);
    assert.equal(repeated.digest.length, 1);
    assert.ok(repeated.digest[0]?.sources.some(({ url }) => url === third.hnUrl));
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('同一动态的不同链接和不同表述经比较后仍合并，不因换帖重新通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-links-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model, sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    state.close();
    state = await createSqliteStateStore(path);
    const discussion = { ...duplicate, url: 'https://transport.example/year-round-bikes' };
    const compared = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [discussion] },
      model: { ...model, verifyDevelopment: async ({ source }) => ({
        verification: { supported: true, change: '公共自行车全年开放，冬季继续提供服务。', whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: '公共自行车全年开放，冬季继续提供服务。', sourceId: source.id, quote: source.text }] }, usage,
      }), resolveDevelopment: async ({ knownDevelopments }) => ({
        resolution: { ...knownDevelopments[0]!, relation: 'duplicate' as const }, usage,
      }) },
      sources: { read: async () => sourceFor(discussion, 'The city has confirmed that bicycles remain available during every season of the year.') }, telegram, clock: () => now,
    });
    assert.equal(sends, 1);
    assert.equal(compared.notifications.length, 1);
    assert.equal(compared.digest.length, 1);
    assert.ok(compared.digest[0]?.sources.some(({ url }) => url === discussion.url));
    assert.equal(compared.usage?.costUsd, 0.003);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('合并来源过长的日间通知保留完整摘要，未知发送跨 SQLite 重启后以完整可追溯链接重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-long-links-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const stories = [first, duplicate].map((story, index) => ({
    ...story, url: `https://${index ? 'b' : 'a'}.example/${'x'.repeat(1980)}`,
  }));
  const received: string[] = [];
  const telegram = createTelegramSender({
    botToken: 'test-only', personalChatId: '123',
    fetch: async (_input, init) => {
      const { text } = JSON.parse(String(init?.body));
      received.push(text);
      if (received.length === 1) throw new Error('Controlled uncertain delivery');
      return Response.json({ ok: true, result: { message_id: 321, chat: { id: 123, type: 'private' } } });
    },
  });
  const mergedModel: DigestModelAdapter = {
    ...model,
    resolveDevelopment: async ({ knownDevelopments }) => ({
      resolution: { ...knownDevelopments[0]!, relation: 'duplicate' }, usage,
    }),
  };
  const expectedSources = stories.flatMap(({ url, hnUrl }) => [{ kind: 'original', url }, { kind: 'hn', url: hnUrl }]);
  try {
    const pending = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => stories }, model: mergedModel,
      sources: { read: async ({ candidateId }) => sourceFor(stories.find(({ id }) => id === candidateId)!) },
      telegram, clock: () => now,
    });
    assert.equal(received.length, 1, 'Telegram must receive a bounded notification rather than reject it locally');
    assert.ok(received[0]!.length <= 4096);
    assert.ok(received[0]!.includes(change));
    assert.ok(received[0]!.includes(whyItMatters));
    assert.ok(received[0]!.includes(stories[0]!.url));
    assert.ok(received[0]!.includes(stories[0]!.hnUrl));
    assert.match(received[0]!, /完整来源见 \/digest/);
    for (const [url] of received[0]!.matchAll(/https?:\/\/\S+/gu)) {
      assert.ok(expectedSources.some((source) => source.url === url), 'Every displayed URL must be complete');
    }
    assert.deepEqual(pending.digest[0]?.sources, expectedSources);
    assert.deepEqual(developmentNotifications(pending)[0]?.sources, expectedSources);
    assert.equal(pending.notifications[0]?.status, 'pending');
    assert.equal(pending.notifications[0]?.attempts[0]?.status, 'unknown');

    state.close();
    state = await createSqliteStateStore(path);
    const another = { ...duplicate, id: '503', url: `https://c.example/${'x'.repeat(1980)}`, hnUrl: 'https://news.ycombinator.com/item?id=503' };
    const allSources = [...expectedSources, { kind: 'original', url: another.url }, { kind: 'hn', url: another.hnUrl }];
    const growing = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [another] }, model: mergedModel,
      sources: { read: async () => sourceFor(another) }, telegram, clock: () => new Date('2026-11-01T01:00:30.000Z'),
    });
    assert.equal(received.length, 1, 'Merging more sources must preserve the existing retry backoff');
    assert.equal(growing.notifications[0]?.status, 'pending');
    assert.deepEqual(growing.digest[0]?.sources, allSources);
    assert.deepEqual(developmentNotifications(growing)[0]?.sources, allSources);

    state.close();
    state = await createSqliteStateStore(path);
    const recovered = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('摘要和已核实通知已持久保存'); } },
      telegram, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.deepEqual(received, [pending.notifications[0]!.text, growing.notifications[0]!.text]);
    assert.ok(received[1]!.length <= 4096);
    for (const [url] of received[1]!.matchAll(/https?:\/\/\S+/gu)) assert.ok(allSources.some((source) => source.url === url));
    assert.deepEqual(recovered.digest[0]?.sources, allSources);
    for (const { url } of allSources) assert.ok(recovered.markdown.includes(url));
    assert.equal(recovered.notifications[0]?.status, 'sent');
    assert.deepEqual(recovered.notifications[0]?.attempts.map(({ status }) => status), ['unknown', 'sent']);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('热度上涨不产生模型工作；同一来源 URL 有据的实质更新关联原动态并再次通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-update-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  const updated = { ...duplicate, title: 'City adds 50 bicycle stations' };
  const newChange = '公共自行车新增五十个站点。';
  const newQuote = 'The public bicycle service has opened fifty additional stations across the city.';
  const updateModel: DigestModelAdapter = {
    ...model,
    analyze: async () => ({ decisions: [{ candidateId: updated.id, topicIds: ['mobility', 'public-service'], summary: '公共自行车新增五十个站点，让更多居民能够就近使用。', significance: { change: newChange, whyItMatters } }], usage }),
    verifyDevelopment: async ({ source }) => ({ verification: {
      supported: true, change: newChange, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: newChange, sourceId: source.id, quote: source.text }],
    }, usage }),
    resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'substantive-update' }, usage }),
  };
  try {
    const initial = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model, sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    const popular = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [{ ...first, score: 300 }] }, model: { analyze: async () => { throw new Error('分数上涨不应调用模型'); } }, telegram, clock: () => now });
    assert.equal(popular.usage, null);
    assert.equal(sends, 1);
    state.close();
    state = await createSqliteStateStore(path);
    const update = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [updated] }, model: updateModel, sources: { read: async () => sourceFor(updated, newQuote) }, telegram, clock: () => new Date('2026-11-01T01:30:00.000Z') });
    assert.equal(sends, 2);
    assert.equal(update.digest.length, 1);
    assert.equal(update.digest[0]?.summary, '公共自行车新增五十个站点，让更多居民能够就近使用。');
    assert.equal(developmentNotifications(update)[1]?.developmentId, developmentNotifications(initial)[0]?.developmentId);
    assert.notEqual(developmentNotifications(update)[1]?.revisionId, developmentNotifications(initial)[0]?.revisionId);
    const claims = developmentNotifications(update)[1]!.claims;
    assert.deepEqual(claims.map(({ statement, sourceId, quote }) => ({ statement, sourceId, quote })), [{ statement: newChange, sourceId: `source:${updated.id}`, quote: '' }]);
    assert.match(claims[0]?.evidenceHash ?? '', /^sha256:v1:[0-9a-f]{64}$/);
    assert.equal(update.usage?.costUsd, 0.003);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('已处理帖子正文变化会重新判断，帖子 ID 与通知修订进度互不覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-story-update-'));
  const state = await createSqliteStateStore(join(directory, 'state.sqlite'));
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  const changed = { ...first, title: 'Bicycle service adds 50 stations', text: 'The public bicycle service has opened fifty additional stations across the city.' };
  const newChange = '公共自行车新增五十个站点。';
  const updatedModel: DigestModelAdapter = {
    ...model,
    analyze: async () => ({ decisions: [{ candidateId: first.id, topicIds: ['mobility'], summary: newChange, significance: { change: newChange, whyItMatters } }], usage }),
    verifyDevelopment: async ({ source }) => ({ verification: { supported: true, change: newChange, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: newChange, sourceId: source.id, quote: source.text }] }, usage }),
    resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'substantive-update' }, usage }),
  };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model, sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    const update = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [changed] }, model: updatedModel, sources: { read: async () => sourceFor(changed, changed.text) }, telegram, clock: () => now });
    assert.equal(sends, 2);
    assert.equal(update.status.candidateCount, 1);
    assert.equal(update.digest.length, 1);
    assert.equal(update.digest[0]?.summary, newChange);
    assert.notEqual(update.notifications[0]?.id, update.notifications[1]?.id);
    assert.equal(update.notifications[0]?.status, 'sent');
    assert.equal(developmentNotifications(update)[1]?.developmentId, developmentNotifications(update)[0]?.developmentId);
    assert.equal((await state.load()).candidates[0]?.notificationReview?.status, 'complete');
    const idle = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [{ ...changed, score: 200 }] }, model: { analyze: async () => { throw new Error('正文未再变化'); } }, telegram, clock: () => now });
    assert.equal(idle.usage, null);
    assert.equal(sends, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('普通相关内容也按动态合并摘要与来源，已知事实不会因后来换帖提议重大而首次通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-digest-development-'));
  const state = await createSqliteStateStore(join(directory, 'state.sqlite'));
  const ordinaryModel: DigestModelAdapter = {
    ...model,
    analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: id === first.id ? ['mobility'] : ['public-service'], summary: '公共自行车服务现扩展为全年运营，冬季居民也可使用。', significance: null })), usage }),
    resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'duplicate' }, usage }),
  };
  try {
    const other = { ...duplicate, url: 'https://transport.example/bikes' };
    const ordinary = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first, other] }, model: ordinaryModel, clock: () => now });
    assert.equal(ordinary.digest.length, 1);
    assert.equal(ordinary.notifications.length, 0);
    assert.deepEqual(ordinary.digest[0]?.topicIds, ['mobility', 'public-service']);
    assert.ok(ordinary.digest[0]?.sources.some(({ url }) => url === other.url));
    const newPost = { ...duplicate, id: '503', hnUrl: 'https://news.ycombinator.com/item?id=503' };
    const repeated = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [newPost] }, model: { ...model, resolveDevelopment: ordinaryModel.resolveDevelopment }, sources: { read: async () => sourceFor(newPost) }, telegram: { send: async () => { throw new Error('已知事实不因首次提议重大而变成新变化'); } }, clock: () => now });
    assert.equal(repeated.notifications.length, 0);
    assert.equal(repeated.digest.length, 1);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧 SQLite 中已有的通知确认继续作为已知动态去重，不要求重建或再次送达', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-legacy-development-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model, sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    const legacy = await state.load();
    delete legacy.developments;
    for (const candidate of legacy.candidates) { delete candidate.developmentId; delete candidate.developmentReview; delete candidate.digestSummary; }
    for (const digest of legacy.digest) { delete digest.developmentId; delete digest.candidateIds; }
    for (const notification of developmentNotifications(legacy)) { delete notification.developmentId; delete notification.revisionId; delete notification.candidateIds; delete notification.kind; delete notification.origin; }
    await state.save(legacy);
    state.close();
    state = await createSqliteStateStore(path);
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [duplicate] }, model, sources: { read: async () => sourceFor(duplicate) }, telegram, clock: () => now });
    assert.equal(sends, 1);
    assert.equal(recovered.notifications.length, 1);
    assert.equal(recovered.notifications[0]?.messageId, '1');
    assert.equal(recovered.notifications[0]?.sentAt, now.toISOString());
    assert.equal(recovered.digest.length, 1);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧 SQLite 的待核实进度恢复后仍可形成第一条通知，不把待核实摘要误记为已通知动态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-legacy-review-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  try {
    await runCycle({ loadConfig: async () => ({ ...config, usage: { runBudgetUsd: 0.001 } }), state, hn: { discover: async () => [first] }, model, clock: () => now });
    const legacy = await state.load();
    delete legacy.developments;
    for (const candidate of legacy.candidates) { delete candidate.developmentReview; delete candidate.digestSummary; }
    await state.save(legacy);
    state.close();
    state = await createSqliteStateStore(path);
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model: { ...model, analyze: async () => { throw new Error('摘要已生成'); } }, sources: { read: async () => sourceFor(first) }, telegram: { send: async () => ({ status: 'sent', messageId: 'restored' }) }, clock: () => now });
    assert.equal(recovered.notifications.length, 1);
    assert.equal(recovered.notifications[0]?.status, 'sent');
    assert.equal(recovered.usage?.costUsd, 0.001);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源 URL 复用及相同概括措辞不能把不同的有据新事件永久屏蔽', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-reused-url-'));
  const state = await createSqliteStateStore(join(directory, 'state.sqlite'));
  const broadChange = '城市公共交通新增服务。';
  const ferry = { ...duplicate, title: 'City starts a new ferry service' };
  const makeModel = (story: CandidateStory, summary: string): DigestModelAdapter => ({
    ...model,
    analyze: async () => ({ decisions: [{ candidateId: story.id, topicIds: ['mobility'], summary, significance: { change: broadChange, whyItMatters } }], usage }),
    verifyDevelopment: async ({ source }) => ({ verification: { supported: true, change: broadChange, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: broadChange, sourceId: source.id, quote: source.text }] }, usage }),
    resolveDevelopment: async () => ({ resolution: { developmentId: null, revisionId: null, relation: 'new' }, usage }),
  });
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model: makeModel(first, '公共自行车服务改为全年运营。'), sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [ferry] }, model: makeModel(ferry, '城市开始运营一条新的轮渡航线。'), sources: { read: async () => sourceFor(ferry, 'The city has started operating a new ferry route connecting the two riverside districts.') }, telegram, clock: () => now });
    assert.equal(sends, 2);
    assert.equal(result.digest.length, 2);
    assert.notEqual(developmentNotifications(result)[0]?.developmentId, developmentNotifications(result)[1]?.developmentId);
    assert.equal(result.usage?.costUsd, 0.003);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('历史比较按有界批次共享步数预算，SQLite 重开后继续剩余比较并复用已核实证据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-budget-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const history = Array.from({ length: 11 }, (_, index) => ({ ...first, id: `${601 + index}`, url: `https://city.example/route-${index + 1}`, hnUrl: `https://news.ycombinator.com/item?id=${601 + index}` }));
  const batches: number[] = [];
  const target = { ...duplicate, id: '900', url: 'https://transport.example/eleventh-route', hnUrl: 'https://news.ycombinator.com/item?id=900' };
  const targetChange = '城市开放第十一条公共线路。';
  const compare: NonNullable<DigestModelAdapter['resolveDevelopment']> = async ({ knownDevelopments }) => {
    batches.push(knownDevelopments.length);
    assert.ok(knownDevelopments.length <= 8);
    const repeated = knownDevelopments.find(({ change }) => change.includes('第11条'));
    return { resolution: repeated ? { developmentId: repeated.developmentId, revisionId: repeated.revisionId, relation: 'duplicate' } : { developmentId: null, revisionId: null, relation: 'new' }, usage };
  };
  try {
    await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 100, maxOutputTokens: 20_000 } }), state, hn: { discover: async () => history },
      model: { ...model, analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }, index) => ({ candidateId: id, topicIds: ['mobility'], summary: `城市新增第${index + 1}条独立线路。`, significance: null })), usage }), resolveDevelopment: async () => ({ resolution: { developmentId: null, revisionId: null, relation: 'new' }, usage }) }, clock: () => now,
    });
    const limited = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 3 } }), state, hn: { discover: async () => [target] },
      model: { ...model, analyze: async () => ({ decisions: [{ candidateId: target.id, topicIds: ['mobility'], summary: targetChange, significance: { change: targetChange, whyItMatters } }], usage }), verifyDevelopment: async ({ source }) => ({ verification: { supported: true, change: targetChange, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: targetChange, sourceId: source.id, quote: source.text }] }, usage }), resolveDevelopment: compare },
      sources: { read: async () => sourceFor(target, 'The city opened its eleventh public transit route for residents today.') }, clock: () => now,
    });
    assert.deepEqual(batches, [8]);
    assert.equal(limited.notifications.length, 0);
    assert.equal(limited.status.budget.pauseReason, 'steps');
    assert.equal(limited.usage?.costUsd, 0.003);
    state.close();
    state = await createSqliteStateStore(path);
    const recovered = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxSteps: 1 } }), state, hn: { discover: async () => [] },
      model: { getAllowance: model.getAllowance, analyze: async () => { throw new Error('无需重复摘要'); }, verifyDevelopment: async () => { throw new Error('证据已核实'); }, resolveDevelopment: compare },
      telegram: { send: async () => { throw new Error('第十一条线路已是已知事实'); } }, clock: () => now,
    });
    assert.deepEqual(batches, [8, 3]);
    assert.equal(recovered.digest.length, 11);
    assert.equal(recovered.notifications.length, 0);
    assert.equal(recovered.usage?.costUsd, 0.001);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('既有动态的拟议更新缺少来源证据时只更新关联摘要，重新打开后也不产生通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-unconfirmed-update-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [first] }, model, sources: { read: async () => sourceFor(first) }, telegram, clock: () => now });
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [duplicate] },
      model: { ...model, analyze: async () => ({ decisions: [{ candidateId: duplicate.id, topicIds: ['public-service'], summary: '公共自行车可能增加新站点，尚待来源证实。', significance: { change: '公共自行车新增站点。', whyItMatters } }], usage }), verifyDevelopment: async () => { throw new Error('无法读取来源时不应核实'); }, resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'substantive-update' }, usage }) },
      sources: { read: async () => ({ ...sourceFor(duplicate), status: 'unavailable', text: '', failureCode: 'unsupported-content' }) }, telegram, clock: () => now,
    });
    assert.equal(sends, 1);
    assert.equal(result.notifications.length, 1);
    assert.equal(result.digest.length, 1);
    assert.match(result.digest[0]!.summary, /尚待来源证实.*来源正文未能完整核实/);
    assert.ok(result.digest[0]?.sources.some(({ url }) => url === duplicate.hnUrl));
    state.close();
    state = await createSqliteStateStore(path);
    const reopened = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model: { analyze: async () => { throw new Error('无新工作'); } }, telegram, clock: () => now });
    assert.equal(reopened.notifications.length, 1);
    assert.equal(sends, 1);
    assert.match(reopened.markdown, /尚待来源证实/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重复判定已持久化后中断，恢复时直接合并而不再次付费比较其他历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-identity-checkpoint-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const history = Array.from({ length: 9 }, (_, index) => ({ ...first, id: `${701 + index}`, url: `https://city.example/service-${index + 1}`, hnUrl: `https://news.ycombinator.com/item?id=${701 + index}` }));
  const target = { ...duplicate, id: '901', url: 'https://transport.example/first-service', hnUrl: 'https://news.ycombinator.com/item?id=901' };
  try {
    await state.save({ schemaVersion: 1, candidates: history.map((story) => ({ story, discoveredAt: now.toISOString(), status: 'processed', processedAt: now.toISOString(), topicIds: ['mobility'] })), digest: history.map((story, index) => ({ id: `digest:${story.id}`, candidateId: story.id, title: story.title, summary: `城市新增第${index + 1}项公共服务。`, topicIds: ['mobility'], sources: [{ kind: 'original', url: story.url! }, { kind: 'hn', url: story.hnUrl }], createdAt: now.toISOString() })), notifications: [], lastRunAt: now.toISOString() });
    await assert.rejects(runCycle({
      loadConfig: async () => config,
      state: { load: () => state.load(), save: async (snapshot) => { await state.save(snapshot); if (snapshot.candidates.find(({ story }) => story.id === target.id)?.developmentReview?.match?.relation === 'duplicate') throw new Error('Runner stopped after durable identity checkpoint'); } },
      hn: { discover: async () => [target] }, model: { ...model, analyze: async () => ({ decisions: [{ candidateId: target.id, topicIds: ['mobility'], summary: change, significance: { change, whyItMatters } }], usage }), resolveDevelopment: async ({ knownDevelopments }) => ({ resolution: { ...knownDevelopments[0]!, relation: 'duplicate' }, usage }) }, sources: { read: async () => sourceFor(target) }, clock: () => now,
    }), /Runner stopped after durable identity checkpoint/);
    state.close();
    state = await createSqliteStateStore(path);
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model: { getAllowance: model.getAllowance, analyze: async () => { throw new Error('无需重复摘要'); }, resolveDevelopment: async () => { throw new Error('重复判定已持久化'); } }, clock: () => now });
    assert.equal(recovered.digest.length, 9);
    assert.equal(recovered.notifications.length, 0);
    assert.equal(recovered.usage, null);
    assert.ok(recovered.digest[0]?.sources.some(({ url }) => url === target.hnUrl));
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
