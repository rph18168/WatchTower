import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitHubStateStore, createSqliteStateStore, createTelegramSender, runCycle } from '../src/index.ts';

const now = new Date('2026-11-01T01:00:00.000Z');
const story = {
  id: '401', title: 'A public observatory opens its archive',
  url: 'https://observatory.example/archive', hnUrl: 'https://news.ycombinator.com/item?id=401',
  text: 'The observatory released its public image archive.', score: 40,
  publishedAt: '2026-11-01T00:10:00.000Z',
};
const config = { model: 'test/model', topics: [{ id: 'astronomy', description: '天文学观测和公共科研设施的新进展' }] };
const usage = { costUsd: 0.001, inputTokens: 120, outputTokens: 80, costComplete: true };
const proposal = { change: '天文台开放全部历史观测影像。', whyItMatters: '公众与研究者现在可查阅长期观测资料。' };
const source = {
  id: 'source:401', candidateId: '401', originalUrl: story.url, finalUrl: story.url,
  status: 'read' as const, title: 'Open archive',
  text: 'Today our observatory opens its complete historical image archive to the public.',
  truncated: false,
};
const verification = {
  supported: true, change: proposal.change, whyItMatters: proposal.whyItMatters,
  uncertainty: null, sourceRole: 'primary' as const,
  claims: [{ statement: proposal.change, sourceId: source.id, quote: source.text }],
};
const significantModel = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async () => ({ decisions: [{ candidateId: story.id, topicIds: ['astronomy'], summary: '天文台开放观测影像档案，公众可以查阅。', significance: proposal }], usage }),
  verifyDevelopment: async () => ({ verification, usage }),
};

test('重大动态读取来源后形成通用中文通知，SQLite 持久保存待发送状态后才发送并确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-notification-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  try {
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] },
      model: {
        getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
        analyze: async () => ({ decisions: [{ candidateId: story.id, topicIds: ['astronomy'], summary: '天文台开放观测影像档案，公众可以查阅。', significance: proposal }], usage }),
        verifyDevelopment: async ({ source: evidence }) => {
          assert.equal(evidence.text, source.text);
          return { verification, usage };
        },
      },
      sources: { read: async (request) => { assert.deepEqual(request, { candidateId: story.id, url: story.url }); return source; } },
      telegram: { send: async ({ text }) => {
        const durable = await state.load();
        assert.equal(durable.notifications[0]?.status, 'pending');
        assert.equal(durable.digest[0]?.candidateId, story.id);
        sent.push(text);
        return { status: 'sent', messageId: '51' };
      } },
      clock: () => now,
    });
    assert.deepEqual(sent, [`${proposal.change}\n\n意义：${proposal.whyItMatters}\n\n来源：${story.url}\nHN 讨论：${story.hnUrl}`]);
    assert.equal(result.notifications[0]?.status, 'sent');
    assert.equal(result.notifications[0]?.sentAt, now.toISOString());
    state.close();
    state = createSqliteStateStore(path);
    const reopened = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('没有新模型工作'); } },
      telegram: { send: async () => { throw new Error('已确认的通知不得重发'); } }, clock: () => now,
    });
    assert.deepEqual(reopened.notifications, result.notifications);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('发送抛出或确认结果不确定时保持待发送状态，SQLite 重开后能够再次发送', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-send-unknown-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  try {
    const first = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] }, model: significantModel,
      sources: { read: async () => source },
      telegram: { send: async () => { throw new Error('Timeout carrying secret transport details'); } }, clock: () => now,
    });
    assert.equal(first.notifications[0]?.status, 'pending');
    assert.deepEqual(first.notifications[0]?.attempts, [{ at: now.toISOString(), status: 'unknown', failureCode: 'network' }]);
    state.close();
    state = createSqliteStateStore(path);
    const recovered = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('核实已持久保存，不应再调用模型'); } },
      telegram: { send: async () => ({ status: 'sent', messageId: '52' }) }, clock: () => new Date('2026-11-01T01:01:00.000Z'),
    });
    assert.equal(recovered.notifications[0]?.status, 'sent');
    assert.equal(recovered.notifications[0]?.attempts.length, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('完整周期使用真实 Telegram 协议只发送至闭包中的个人私聊，不把身份写入公开状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-telegram-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let sends = 0;
  const telegram = createTelegramSender({ botToken: 'test-only-bot-token', personalChatId: '987654321', fetch: async (input, init) => {
    sends++;
    assert.equal(String(input), 'https://api.telegram.org/bottest-only-bot-token/sendMessage');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, '987654321');
    assert.equal(body.parse_mode, undefined);
    assert.equal(body.text, `${proposal.change}\n\n意义：${proposal.whyItMatters}\n\n来源：${story.url}\nHN 讨论：${story.hnUrl}`);
    return Response.json({ ok: true, result: { message_id: 53, chat: { id: 987654321, type: 'private' }, text: body.text } });
  } });
  try {
    const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story] }, model: significantModel, sources: { read: async () => source }, telegram, clock: () => now });
    assert.equal(sends, 1);
    assert.equal(result.notifications[0]?.status, 'sent');
    const snapshot = JSON.stringify(await state.load());
    assert.doesNotMatch(snapshot, /987654321|test-only-bot-token|chat_id/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('保存待发送通知失败时不发送；确认保存失败后从持久待发送状态恢复，接受偶发重复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-send-checkpoint-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let sends = 0;
  const options = {
    loadConfig: async () => config, state, hn: { discover: async () => [story] }, model: significantModel,
    sources: { read: async () => source },
    telegram: { send: async () => { sends++; return { status: 'sent' as const, messageId: '55' }; } }, clock: () => now,
  };
  try {
    await assert.rejects(runCycle({ ...options, state: { load: () => state.load(), save: async (snapshot) => {
      if (snapshot.notifications.length > 0) throw new Error('Durable checkpoint failed');
      await state.save(snapshot);
    } } }), /Durable checkpoint failed/);
    assert.equal(sends, 0);
    await assert.rejects(runCycle({ ...options, state: { load: () => state.load(), save: async (snapshot) => {
      if (snapshot.notifications.some(({ status }) => status === 'sent')) throw new Error('Confirmation checkpoint failed');
      await state.save(snapshot);
    } } }), /Confirmation checkpoint failed/);
    assert.equal(sends, 1);
    assert.equal((await state.load()).notifications[0]?.status, 'pending');
    const recovered = await runCycle({ ...options, hn: { discover: async () => [] }, model: { analyze: async () => { throw new Error('无需重复核实'); } }, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.equal(sends, 2);
    assert.equal(recovered.notifications[0]?.status, 'sent');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('普通相关仅留摘要，不相关不收录；不可核实或未获支持的重大动态不通知', async () => {
  for (const scenario of ['ordinary', 'unrelated', 'no-link', 'unavailable', 'truncated', 'forged', 'wrong-source', 'unknown-role', 'unsupported'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-evidence-'));
    const state = createSqliteStateStore(join(directory, 'state.sqlite'));
    let reads = 0;
    let verifies = 0;
    let sends = 0;
    try {
      const result = await runCycle({
        loadConfig: async () => config, state, hn: { discover: async () => [{ ...story, url: scenario === 'no-link' ? undefined : story.url }] },
        model: {
          ...significantModel,
          analyze: async () => ({ decisions: [{ candidateId: story.id, topicIds: scenario === 'unrelated' ? [] : ['astronomy'], summary: scenario === 'unrelated' ? null : '天文台的新动态已记录。', significance: ['ordinary', 'unrelated'].includes(scenario) ? null : proposal }], usage }),
          verifyDevelopment: async () => {
            verifies++;
            return { verification: {
              ...verification,
              supported: scenario !== 'unsupported',
              uncertainty: scenario === 'unsupported' ? '该来源未确认这一新变化。' : null,
              sourceRole: scenario === 'unknown-role' ? 'unknown' as const : verification.sourceRole,
              claims: [{ statement: proposal.change, sourceId: scenario === 'wrong-source' ? 'source:not-read' : source.id, quote: scenario === 'forged' ? 'This statement does not occur in the page.' : source.text }],
            }, usage };
          },
        },
        sources: { read: async () => { reads++; return scenario === 'unavailable' ? { ...source, status: 'unavailable' as const, text: '', failureCode: 'network' as const } : { ...source, truncated: scenario === 'truncated' }; } },
        telegram: { send: async () => { sends++; return { status: 'sent', messageId: '56' }; } }, clock: () => now,
      });
      assert.equal(sends, 0, scenario);
      assert.equal(result.notifications.length, 0, scenario);
      assert.equal(result.digest.length, scenario === 'unrelated' ? 0 : 1);
      assert.equal(reads, ['ordinary', 'unrelated', 'no-link'].includes(scenario) ? 0 : 1);
      assert.equal(verifies, ['forged', 'wrong-source', 'unknown-role', 'unsupported'].includes(scenario) ? 1 : 0);
      if (!['ordinary', 'unrelated'].includes(scenario)) assert.match(result.digest[0]!.summary, /未能完整核实|证据不足|未提供可核实/);
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('Telegram 只有明确的本人私聊成功响应才能确认送达，错误只保存允许的故障字段', async () => {
  for (const response of [
    { ok: true, result: { message_id: 61, chat: { id: 987654321, type: 'group' } } },
    { ok: true, result: { message_id: 61, chat: { id: 123456789, type: 'private' } } },
    { ok: true },
    { ok: false, error_code: 429, description: 'private token-bearing server details', parameters: { retry_after: 60 } },
    { ok: false, error_code: 403, description: 'private token-bearing server details' },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-telegram-unconfirmed-'));
    const state = createSqliteStateStore(join(directory, 'state.sqlite'));
    try {
      const telegram = createTelegramSender({ botToken: 'test-only-bot-token', personalChatId: '987654321', fetch: async () => Response.json(response) });
      const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story] }, model: significantModel, sources: { read: async () => source }, telegram, clock: () => now });
      assert.equal(result.notifications[0]?.status, 'pending');
      assert.equal(result.notifications[0]?.sentAt, null);
      const attempt = result.notifications[0]?.attempts[0];
      assert.notEqual(attempt?.status, 'sent');
      if (response.error_code === 429) assert.deepEqual(attempt, { at: now.toISOString(), status: 'failed', failureCode: 'rate-limited', retryAfterSeconds: 60 });
      assert.doesNotMatch(JSON.stringify(await state.load()), /token-bearing|987654321|123456789/);
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('GitHub 远端快照保存完成后才发送，新的 runner 可读取送达确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-remote-outbox-'));
  let snapshot: { version: string; database: Uint8Array } | null = null;
  let commits = 0;
  const github = {
    readSnapshot: async () => snapshot,
    commitSnapshot: async ({ expectedVersion, database }: { expectedVersion: string | null; database: Uint8Array }) => {
      assert.equal(expectedVersion, snapshot?.version ?? null);
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = { version: `commit-${++commits}`, database: Uint8Array.from(database) };
      return snapshot.version;
    },
  };
  const state = createGitHubStateStore({ path: join(directory, 'runner-one.sqlite'), github });
  const observer = createGitHubStateStore({ path: join(directory, 'runner-two.sqlite'), github });
  try {
    const result = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] }, model: significantModel,
      sources: { read: async () => source },
      telegram: { send: async () => {
        assert.equal((await observer.load()).notifications[0]?.status, 'pending');
        return { status: 'sent', messageId: '62' };
      } }, clock: () => now,
    });
    assert.equal(result.notifications[0]?.status, 'sent');
    assert.equal((await observer.load()).notifications[0]?.status, 'sent');
  } finally {
    state.close(); observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('摘要耗尽本轮额度后不绕过预算，下一周期从核实进度继续且不重复携带超大 HN 正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-verification-budget-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let verifications = 0;
  const model = { ...significantModel, verifyDevelopment: async () => { verifications++; return { verification, usage }; } };
  try {
    const first = await runCycle({
      loadConfig: async () => ({ ...config, usage: { runBudgetUsd: 0.001, maxInputBytes: 128_000 } }), state,
      hn: { discover: async () => [{ ...story, text: '背景资料'.repeat(6000) }] }, model, sources: { read: async () => source },
      telegram: { send: async () => { throw new Error('核实未准入时不应产生通知'); } }, clock: () => now,
    });
    assert.equal(verifications, 0);
    assert.equal(first.digest.length, 1);
    assert.equal(first.notifications.length, 0);
    assert.equal(first.usage?.costUsd, 0.001);
    assert.equal((await state.load()).candidates[0]?.notificationReview?.status, 'pending');
    state.close();
    state = createSqliteStateStore(path);
    const next = await runCycle({
      loadConfig: async () => ({ ...config, usage: { runBudgetUsd: 0.01 } }), state,
      hn: { discover: async () => [] }, model: { ...model, analyze: async () => { throw new Error('摘要已经持久保存'); } },
      sources: { read: async () => source }, telegram: { send: async () => ({ status: 'sent', messageId: '63' }) }, clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(verifications, 1);
    assert.equal(next.notifications[0]?.status, 'sent');
    assert.equal(next.usage?.costUsd, 0.001);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('单个核实来源超过输入预算时保持待核实，并继续处理后续可容纳的来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-verification-size-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const secondStory = { ...story, id: '404', title: 'A second observatory opens infrared images', url: 'https://observatory.example/infrared', hnUrl: 'https://news.ycombinator.com/item?id=404' };
  const secondProposal = { change: '第二天文台开放红外观测影像。', whyItMatters: '研究者可直接查阅新的红外资料。' };
  const secondSource = { ...source, id: 'source:404', candidateId: '404', originalUrl: secondStory.url, finalUrl: secondStory.url, text: 'Our second observatory opens its infrared image archive to the public today.' };
  const model = {
    getAllowance: significantModel.getAllowance,
    analyze: async () => ({ decisions: [story, secondStory].map(({ id }) => ({ candidateId: id, topicIds: ['astronomy'], summary: '新的天文观测资料现已发布。', significance: id === '401' ? proposal : secondProposal })), usage }),
    verifyDevelopment: async () => ({ verification: { ...verification, ...secondProposal, claims: [{ statement: secondProposal.change, sourceId: secondSource.id, quote: secondSource.text }] }, usage }),
  };
  try {
    await runCycle({ loadConfig: async () => ({ ...config, usage: { runBudgetUsd: 0.001 } }), state, hn: { discover: async () => [story, secondStory] }, model, clock: () => now });
    const result = await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxInputBytes: 8000 } }), state, hn: { discover: async () => [] }, model,
      sources: { read: async ({ candidateId }) => candidateId === '401' ? { ...source, text: '公开数据。'.repeat(2400) } : secondSource },
      telegram: { send: async () => ({ status: 'sent', messageId: '64' }) }, clock: () => now,
    });
    assert.deepEqual(result.notifications.map((notification) => 'candidateId' in notification ? notification.candidateId : undefined), ['404']);
    const persisted = await state.load();
    assert.equal(persisted.candidates[0]?.notificationReview?.status, 'pending');
    assert.equal(persisted.candidates[1]?.notificationReview?.status, 'complete');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
