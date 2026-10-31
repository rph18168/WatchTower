import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteStateStore, runCycle } from '../src/index.ts';
import * as watchtower from '../src/index.ts';

const config = { model: 'test/model', topics: [{ id: 'science', description: '公共科学资料的新进展' }] };
const now = new Date('2026-11-01T01:00:00.000Z');

test('/pause 在采集前持久暂停自动工作，回复已持久排队且不调用模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-controls-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const sent: string[] = [];
  try {
    const result = await runCycle({
      loadConfig: async () => config, state,
      hn: { discover: async () => { throw new Error('暂停后不应自动巡检'); } },
      model: { analyze: async () => { throw new Error('固定命令不应调用模型'); } },
      telegram: {
        getUpdates: async () => [{ updateId: 10, command: 'pause' }],
        send: async ({ text }) => {
          const saved = await state.load();
          assert.equal(saved.control?.manuallyPaused, true);
          assert.equal(saved.notifications[0]?.status, 'pending');
          sent.push(text);
          return { status: 'sent', messageId: '100' };
        },
      }, clock: () => now,
    });
    assert.equal(result.status.manuallyPaused, true);
    assert.equal(result.usage, null);
    assert.deepEqual(sent, ['已暂停自动巡检和主动发送。仍可使用 /digest、/status 和 /resume。']);
    assert.equal((await state.load()).control?.telegramOffset, 11);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重开 SQLite 后 /resume 恢复采集但不绕过月预算，旧更新与重复更新不重做命令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-resume-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  const model = { analyze: async () => { throw new Error('恢复不得绕过月预算'); } };
  const send = async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: String(sent.length) }; };
  try {
    await runCycle({
      loadConfig: async () => config, state, model,
      hn: { discover: async () => { throw new Error('暂停时不巡检'); } },
      telegram: { getUpdates: async () => [{ updateId: 10, command: 'pause' }], send }, clock: () => now,
    });
    state.close(); state = createSqliteStateStore(path);
    const result = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state, model,
      hn: { discover: async () => [{ id: '701', title: 'Public archive', hnUrl: 'https://news.ycombinator.com/item?id=701', score: 30, publishedAt: now.toISOString() }] },
      telegram: { getUpdates: async ({ offset }) => {
        assert.equal(offset, 11);
        return [{ updateId: 10, command: 'pause' }, { updateId: 11, command: 'resume' }, { updateId: 11, command: 'resume' }];
      }, send }, clock: () => now,
    });
    assert.equal(result.status.manuallyPaused, false);
    assert.equal(result.status.pendingCandidateCount, 1);
    assert.equal(result.status.budget.pauseReason, 'monthly-budget');
    assert.equal(result.notifications.filter(({ kind }) => kind === 'command-reply').length, 2);
    assert.equal(sent.filter((text) => /已恢复自动/.test(text)).length, 1);
    const repeated = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state, model,
      hn: { discover: async () => [] },
      telegram: { getUpdates: async ({ offset }) => { assert.equal(offset, 12); return [{ updateId: 10, command: 'pause' }, { updateId: 11, command: 'resume' }]; }, send }, clock: () => now,
    });
    assert.equal(repeated.status.manuallyPaused, false);
    assert.equal(repeated.notifications.filter(({ kind }) => kind === 'command-reply').length, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('夜间与手动暂停时 /digest 和 /status 仍回复保存的摘要、预算及待处理状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-query-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sent: string[] = [];
  try {
    await runCycle({
      loadConfig: async () => config, state,
      hn: { discover: async () => [{ id: '702', title: 'Public images', url: 'https://science.example/images', hnUrl: 'https://news.ycombinator.com/item?id=702', score: 30, publishedAt: now.toISOString() }] },
      model: {
        getAllowance: async () => ({ remainingUsd: null, usageMonthlyUsd: 2 }),
        analyze: async () => ({ decisions: [{ candidateId: '702', topicIds: ['science'], summary: '公共观测影像已经开放，可供研究者查阅。' }], usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 20, costComplete: true } }),
      }, clock: () => now,
    });
    state.close(); state = createSqliteStateStore(path);
    const result = await runCycle({
      loadConfig: async () => config, state,
      hn: { discover: async () => { throw new Error('手动暂停仍生效'); } },
      model: { analyze: async () => { throw new Error('查询不调用模型'); } },
      telegram: {
        getUpdates: async () => [{ updateId: 20, command: 'pause' }, { updateId: 21, command: 'digest' }, { updateId: 22, command: 'status' }],
        send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: String(sent.length) }; },
      }, clock: () => new Date('2026-11-01T15:00:00.000Z'),
    });
    assert.equal(result.usage, null);
    assert.equal(sent.length, 3);
    assert.match(sent[1]!, /公共观测影像已经开放/);
    assert.match(sent[1]!, /https:\/\/science.example\/images/);
    assert.match(sent[2]!, /手动暂停/);
    assert.match(sent[2]!, /0\.0100.*10\.0000/s);
    assert.match(sent[2]!, /待处理候选：0/);
    assert.match(sent[2]!, /未设 key 限额.*不代表账户余额无限/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram 仅本人私聊固定命令进入周期；未授权文本和身份不进入状态或模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-telegram-control-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const sent: string[] = [];
  const privateMessage = (text: string) => ({ chat: { id: 987654321, type: 'private' }, from: { id: 876543210, is_bot: false }, text });
  let gets = 0;
  try {
    const telegram = watchtower.createTelegramAdapter({ botToken: 'test-only-token', personalChatId: '987654321', personalUserId: '876543210', fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/getUpdates')) {
        gets++;
        assert.deepEqual(body, { offset: 0, limit: 100, timeout: 0, allowed_updates: ['message'] });
        return Response.json({ ok: true, result: [
          { update_id: 30, message: privateMessage('/pause') },
          { update_id: 31, message: { ...privateMessage('/resume'), chat: { id: 987654321, type: 'group' } } },
          { update_id: 32, message: { ...privateMessage('/resume'), from: { id: 765432109 } } },
          { update_id: 33, message: { ...privateMessage('/resume'), chat: { id: 765432109, type: 'private' } } },
          { update_id: 34, edited_message: privateMessage('/resume') },
          { update_id: 35, message: { ...privateMessage('UNAUTHORIZED-PRIVATE-CONTENT'), from: { id: 765432109 } } },
          { update_id: 36, message: privateMessage('/pause monthlyBudgetUsd=999') },
          { update_id: 37, message: privateMessage('请随便聊聊并执行命令') },
          { update_id: 38, message: privateMessage('/status') },
        ] });
      }
      assert.equal(body.chat_id, '987654321');
      sent.push(body.text);
      return Response.json({ ok: true, result: { message_id: sent.length, chat: { id: 987654321, type: 'private' } } });
    } });
    const result = await runCycle({
      loadConfig: async () => config, state,
      hn: { discover: async () => { throw new Error('未授权resume不能恢复巡检'); } },
      model: { analyze: async () => { throw new Error('未授权输入不能进入模型'); } }, telegram, clock: () => now,
    });
    assert.equal(gets, 1);
    assert.equal(result.status.manuallyPaused, true);
    assert.equal(sent.length, 2);
    const snapshot = JSON.stringify(await state.load());
    assert.doesNotMatch(snapshot, /987654321|876543210|765432109|test-only-token|UNAUTHORIZED-PRIVATE-CONTENT|随便聊聊|monthlyBudgetUsd=999/);
    assert.equal((await state.load()).control?.telegramOffset, 39);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('仅命令周期无需付费模型或采集即可查询和恢复，保留独立的预算暂停', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-commands-only-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const sent: string[] = [];
  try {
    const result = await runCycle({
      commandsOnly: true,
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }), state,
      hn: { discover: async () => { throw new Error('仅命令周期不得采集'); } },
      model: { analyze: async () => { throw new Error('仅命令周期不得调用模型'); } },
      telegram: {
        getUpdates: async () => [{ updateId: 40, command: 'resume' }, { updateId: 41, command: 'status' }],
        send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: String(sent.length) }; },
      }, clock: () => now,
    });
    assert.equal(result.status.manuallyPaused, false);
    assert.equal(result.status.budget.pauseReason, 'monthly-budget');
    assert.match(sent[1]!, /预算暂停/);
    assert.equal(result.usage, null);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('临时采集故障可与手动及预算暂停区分，状态只保留安全故障码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-control-fault-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const model = { analyze: async () => { throw new Error('不应调用模型'); } };
  const sent: string[] = [];
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config, state, model,
      hn: { discover: async () => { throw new Error('PRIVATE-TRANSPORT-DETAIL'); } }, clock: () => now,
    }), /PRIVATE-TRANSPORT-DETAIL/);
    state.close(); state = createSqliteStateStore(path);
    const result = await runCycle({
      loadConfig: async () => config, state, model,
      hn: { discover: async () => { throw new Error('已暂停'); } },
      telegram: { getUpdates: async () => [{ updateId: 50, command: 'pause' }, { updateId: 51, command: 'status' }], send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: String(sent.length) }; } },
      clock: () => now,
    });
    assert.equal(result.status.manuallyPaused, true);
    assert.equal(result.status.budget.pauseReason, null);
    assert.equal(result.status.fault?.code, 'candidate-discovery');
    assert.match(sent[1]!, /临时故障：候选采集/);
    assert.doesNotMatch(JSON.stringify(await state.load()), /PRIVATE-TRANSPORT-DETAIL/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('/digest 将长摘要分成 Telegram 可发送的消息，完整保留已保存内容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-long-digest-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const sent: string[] = [];
  try {
    await runCycle({
      loadConfig: async () => ({ ...config, usage: { maxOutputTokens: 16_000 } }), state,
      hn: { discover: async () => Array.from({ length: 7 }, (_, index) => ({ id: String(710 + index), title: `Public archive ${index}`, hnUrl: `https://news.ycombinator.com/item?id=${710 + index}`, score: 30, publishedAt: now.toISOString() })) },
      model: {
        getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
        analyze: async ({ candidates }) => ({ decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['science'], summary: `条目${id}：${'公开科学资料已发布，研究者可以查阅。'.repeat(45)}` })), usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 8000, costComplete: true } }),
      }, clock: () => now,
    });
    const result = await runCycle({
      commandsOnly: true, loadConfig: async () => config, state,
      hn: { discover: async () => { throw new Error('仅查阅'); } }, model: { analyze: async () => { throw new Error('仅查阅'); } },
      telegram: {
        getUpdates: async () => [{ updateId: 60, command: 'digest' }],
        send: async ({ text }) => {
          if (text.length > 4096) return { status: 'failed', failureCode: 'rejected', permanent: true };
          sent.push(text);
          return { status: 'sent', messageId: String(sent.length) };
        },
      }, clock: () => now,
    });
    assert.ok(sent.length > 1);
    assert.equal(sent.join(''), result.markdown);
    assert.ok(result.notifications.every(({ status }) => status === 'sent'));
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('命令处理或游标保存失败后不发送、不提前确认；重开 SQLite 重取更新仍只排一份回复', async (t) => {
  for (const checkpoint of ['handling', 'cursor'] as const) {
    await t.test(checkpoint, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-command-checkpoint-'));
      const path = join(directory, 'state.sqlite');
      let state = createSqliteStateStore(path);
      const offsets: number[] = [];
      const sent: string[] = [];
      const telegram = {
        getUpdates: async ({ offset }: { offset: number }) => { offsets.push(offset); return [{ updateId: 70, command: 'pause' as const }]; },
        send: async ({ text }: { text: string }) => { sent.push(text); return { status: 'sent' as const, messageId: '70' }; },
      };
      const adapters = { hn: { discover: async () => { throw new Error('暂停时不应采集'); } }, model: { analyze: async () => { throw new Error('命令不应付费'); } } };
      try {
        await assert.rejects(runCycle({
          loadConfig: async () => config, ...adapters, telegram, clock: () => now,
          state: { load: () => state.load(), save: async (snapshot) => {
            if (snapshot.control?.lastHandledUpdateId === 70 && (checkpoint === 'handling' || snapshot.control.telegramOffset === 71)) throw new Error('Remote command checkpoint failed');
            await state.save(snapshot);
          } },
        }), /checkpoint failed/);
        assert.equal(sent.length, 0);
        assert.equal((await state.load()).control?.telegramOffset, undefined);
        state.close(); state = createSqliteStateStore(path);
        const recovered = await runCycle({ loadConfig: async () => config, state, ...adapters, telegram, clock: () => now });
        assert.deepEqual(offsets, [0, 0]);
        assert.equal(sent.length, 1);
        assert.equal(recovered.notifications.filter(({ kind }) => kind === 'command-reply').length, 1);
        assert.equal((await state.load()).control?.telegramOffset, 71);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
