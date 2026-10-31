import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteStateStore, runCycle } from '../src/index.ts';
import type { CandidateStory, DevelopmentNotification, DigestModelAdapter, SourceReaderAdapter } from '../src/index.ts';

const config = { model: 'test/model', topics: [{ id: 'astronomy', description: '公共天文研究资料的新进展' }] };
const usage = { costUsd: 0.001, inputTokens: 120, outputTokens: 80, costComplete: true };
const story = (id: string): CandidateStory => ({
  id, title: `Observatory archive ${id}`, url: `https://observatory.example/archive/${id}`,
  hnUrl: `https://news.ycombinator.com/item?id=${id}`, score: 40,
  publishedAt: '2026-11-01T00:00:00.000Z',
});
const proposal = (id: string) => ({ change: `天文台开放第${id}批观测影像。`, whyItMatters: '研究者可以直接查阅新的观测资料。' });
const sourceText = (id: string) => `Our observatory opens observation image archive number ${id} to the public today.`;
const sources: SourceReaderAdapter = {
  read: async ({ candidateId, url }) => ({
    id: `source:${candidateId}`, candidateId, originalUrl: url, finalUrl: url,
    status: 'read', title: 'Public archive', text: sourceText(candidateId), truncated: false,
  }),
};
const model: DigestModelAdapter = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({
    decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['astronomy'], summary: `第${id}批观测资料已公开。`, significance: proposal(id) })),
    usage,
  }),
  verifyDevelopment: async ({ candidate, source }) => ({
    verification: {
      ...proposal(candidate.id), supported: true, uncertainty: null, sourceRole: 'primary',
      claims: [{ statement: proposal(candidate.id).change, sourceId: source.id, quote: source.text }],
    },
    usage,
  }),
};

test('上海 08:00 含、23:00 不含；静默时段仍采集并保存摘要和待发送通知', async (t) => {
  for (const { at, delivered } of [
    { at: '2026-10-31T23:59:00.000Z', delivered: false }, // 上海 07:59
    { at: '2026-11-01T00:00:00.000Z', delivered: true },  // 上海 08:00
    { at: '2026-11-01T14:59:00.000Z', delivered: true },  // 上海 22:59
    { at: '2026-11-01T15:00:00.000Z', delivered: false }, // 上海 23:00
  ]) {
    await t.test(at, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-window-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      const sent: string[] = [];
      try {
        const result = await runCycle({
          loadConfig: async () => config, state, hn: { discover: async () => [story('501')] }, model, sources,
          telegram: { send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: '501' }; } },
          clock: () => new Date(at),
        });
        assert.equal(sent.length, delivered ? 1 : 0);
        assert.equal(result.digest[0]?.summary, '第501批观测资料已公开。');
        assert.equal(result.notifications[0]?.status, delivered ? 'sent' : 'pending');
        assert.equal((await state.load()).notifications[0]?.status, delivered ? 'sent' : 'pending');
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('夜间动态跨 SQLite 重启保留，08:00 汇总送达并保留每项意义、原文及 HN 入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-overnight-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  const deliveryCheckpoints: boolean[] = [];
  try {
    for (const { id, at } of [
      { id: '502', at: '2026-11-01T15:00:00.000Z' }, // 上海 23:00
      { id: '503', at: '2026-11-01T23:59:00.000Z' }, // 次日 07:59
    ]) {
      const result = await runCycle({
        loadConfig: async () => config, state, hn: { discover: async () => [story(id)] }, model, sources,
        telegram: { send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: 'night' }; } },
        clock: () => new Date(at),
      });
      assert.equal(result.notifications.every(({ status }) => status === 'pending'), true);
      assert.equal(sent.length, 0);
      state.close();
      state = createSqliteStateStore(path);
    }
    const morning = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('夜间核实与摘要已持久保存'); } },
      telegram: { send: async ({ text }) => {
        deliveryCheckpoints.push((await state.load()).notifications.every(({ status }) => status === 'pending'));
        sent.push(text);
        return { status: 'sent', messageId: 'morning' };
      } },
      clock: () => new Date('2026-11-02T00:00:00.000Z'),
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(deliveryCheckpoints, [true]);
    assert.match(sent[0]!, /夜间动态汇总/);
    for (const id of ['502', '503']) {
      assert.ok(sent[0]!.includes(proposal(id).change));
      assert.ok(sent[0]!.includes(proposal(id).whyItMatters));
      assert.ok(sent[0]!.includes(story(id).url!));
      assert.ok(sent[0]!.includes(story(id).hnUrl));
    }
    assert.equal(morning.digest.length, 2);
    assert.equal(morning.notifications.every(({ status }) => status === 'sent'), true);
    state.close();
    state = createSqliteStateStore(path);
    let repeated = 0;
    await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
      telegram: { send: async () => { repeated++; return { status: 'sent', messageId: 'repeat' }; } },
      clock: () => new Date('2026-11-02T00:15:00.000Z'),
    });
    assert.equal(repeated, 0);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('超长夜间汇总拆成 Telegram 可接收的稳定批次，每批只确认自己的动态，未知结果重启后重试同一批', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-batches-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const stories = ['510', '511', '512', '513', '514', '515'].map(story);
  const longProposal = (id: string) => ({
    change: `天文台公开第${id}批资料。${'新增观测覆盖遥远星系。'.repeat(35)}`,
    whyItMatters: '研究者能够比较跨年的观测。'.repeat(35),
  });
  const longModel: DigestModelAdapter = {
    ...model,
    analyze: async ({ candidates }) => ({
      decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['astronomy'], summary: `第${id}批资料已公开。`, significance: longProposal(id) })), usage,
    }),
    verifyDevelopment: async ({ candidate, source }) => ({
      verification: { ...longProposal(candidate.id), supported: true, uncertainty: null, sourceRole: 'primary', claims: [{ statement: longProposal(candidate.id).change, sourceId: source.id, quote: source.text }] }, usage,
    }),
  };
  const sent: string[] = [];
  try {
    await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => stories }, model: longModel, sources,
      clock: () => new Date('2026-11-01T15:00:00.000Z'),
    });
    state.close();
    state = createSqliteStateStore(path);
    const morning = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
      telegram: { send: async ({ text }) => {
        sent.push(text);
        return sent.length === 1 ? { status: 'sent', messageId: 'batch-one' } : { status: 'unknown', failureCode: 'network' };
      } },
      clock: () => new Date('2026-11-02T00:00:00.000Z'),
    });
    assert.equal(sent.length, 2);
    assert.equal(sent.every((text) => text.length <= 4096), true);
    for (const notification of morning.notifications) {
      if (!('candidateId' in notification)) continue;
      assert.equal(notification.status, sent[0]!.includes(notification.change) ? 'sent' : 'pending');
      assert.ok(sent.some((text) => text.includes(notification.change) && text.includes(notification.whyItMatters) && text.includes(story(notification.candidateId).url!) && text.includes(story(notification.candidateId).hnUrl)));
    }
    state.close();
    state = createSqliteStateStore(path);
    const repeated: string[] = [];
    const recovered = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
      telegram: { send: async ({ text }) => { repeated.push(text); return { status: 'sent', messageId: 'batch-two' }; } },
      clock: () => new Date('2026-11-02T00:15:00.000Z'),
    });
    assert.deepEqual(repeated, [sent[1]]);
    assert.equal(recovered.notifications.every(({ status }) => status === 'sent'), true);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('每次实际发送都重新检查时段，周期跨过 23:00 后停止后续发送并记录真实尝试时间', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-window-closes-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let at = new Date('2026-11-01T14:59:00.000Z');
  const sent: string[] = [];
  try {
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story('520'), story('521')] }, model,
      sources: { read: async (request) => {
        if (request.candidateId === '521') at = new Date('2026-11-01T14:59:59.000Z');
        return sources.read(request);
      } },
      telegram: { send: async ({ text }) => {
        sent.push(text);
        at = new Date('2026-11-01T15:00:00.000Z');
        return { status: 'sent', messageId: 'before-close' };
      } },
      clock: () => at,
    });
    assert.equal(sent.length, 1);
    assert.equal(result.notifications[0]?.attempts[0]?.at, '2026-11-01T14:59:59.000Z');
    assert.equal(result.notifications[0]?.sentAt, '2026-11-01T14:59:59.000Z');
    assert.equal(result.notifications[1]?.status, 'pending');
    assert.deepEqual(result.notifications[1]?.attempts, []);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧快照中的新闻重试和预算报告共用静默及手动暂停准入，操作回复仍可送达', async (t) => {
  for (const { at, manuallyPaused } of [
    { at: '2026-11-01T15:00:00.000Z', manuallyPaused: false },
    { at: '2026-11-02T00:00:00.000Z', manuallyPaused: true },
    { at: '2026-11-01T15:00:00.000Z', manuallyPaused: true },
  ]) {
    await t.test(`${at} paused=${manuallyPaused}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-admission-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      const sent: string[] = [];
      const createdAt = '2026-11-01T14:45:00.000Z';
      const legacyNews: DevelopmentNotification = {
        id: 'legacy-news', candidateId: '530', topicIds: ['astronomy'],
        text: '已核实的观测资料开放。', ...proposal('530'), claims: [], sources: [], createdAt,
        status: 'pending', sentAt: null, attempts: [{ at: createdAt, status: 'unknown', failureCode: 'network' }],
      };
      try {
        await state.save({
          schemaVersion: 1, candidates: [], digest: [], lastRunAt: createdAt, control: { manuallyPaused },
          notifications: [
            legacyNews,
            { id: 'budget', kind: 'budget-status', origin: 'proactive', text: '模型月预算已耗尽。', createdAt, status: 'pending', sentAt: null, attempts: [] },
            { id: 'reply', kind: 'command-reply', origin: 'command-reply', text: '状态查询：手动控制仍可使用。', createdAt, status: 'pending', sentAt: null, attempts: [] },
          ],
        });
        const options = {
          loadConfig: async () => config, state, hn: { discover: async () => [] }, model,
          telegram: { send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: String(sent.length) }; } },
        };
        const blocked = await runCycle({ ...options, clock: () => new Date(at) });
        assert.deepEqual(sent, ['状态查询：手动控制仍可使用。']);
        assert.deepEqual(blocked.notifications.map(({ status }) => status), ['pending', 'pending', 'sent']);
        assert.equal(blocked.notifications[0]?.attempts.length, 1);
        const resumed = await state.load();
        resumed.control = { manuallyPaused: false };
        await state.save(resumed);
        const delivered = await runCycle({ ...options, clock: () => new Date('2026-11-02T01:00:00.000Z') });
        assert.deepEqual(sent, ['状态查询：手动控制仍可使用。', legacyNews.text, '模型月预算已耗尽。']);
        assert.equal(delivered.notifications.every(({ status }) => status === 'sent'), true);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('晨间汇总的持久化失败时不开始发送，重开 SQLite 后重新形成汇总送达', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-checkpoint-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story('540')] }, model, sources, clock: () => new Date('2026-11-01T15:00:00.000Z') });
    const morning = {
      loadConfig: async () => config, hn: { discover: async () => [] }, model,
      telegram: { send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: 'summary' }; } },
      clock: () => new Date('2026-11-02T00:00:00.000Z'),
    };
    await assert.rejects(runCycle({ ...morning, state: {
      load: () => state.load(),
      save: async (snapshot) => {
        if (snapshot.notifications.some(({ kind }) => kind === 'overnight-summary')) throw new Error('Summary checkpoint unavailable');
        await state.save(snapshot);
      },
    } }), /Summary checkpoint unavailable/);
    assert.equal(sent.length, 0);
    state.close();
    state = createSqliteStateStore(path);
    const recovered = await runCycle({ ...morning, state });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /夜间动态汇总/);
    assert.ok(sent[0]!.includes(story('540').url!));
    assert.equal(recovered.notifications.every(({ status }) => status === 'sent'), true);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
