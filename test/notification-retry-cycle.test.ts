import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitHubStateStore, createSqliteStateStore, GitHubStateError, runCycle } from '../src/index.ts';
import type { GitHubSnapshotAdapter } from '../src/index.ts';
import type { DevelopmentNotification, RunCycleOptions } from '../src/index.ts';

const config = { model: 'test/model', topics: [{ id: 'astronomy', description: '公共天文研究资料的新进展' }] };
const createdAt = '2026-11-01T01:00:00.000Z';
function pendingNotification(id = '601'): DevelopmentNotification {
  return {
    id: `notification:${id}`, candidateId: id, topicIds: ['astronomy'],
    change: '天文台开放新的观测资料。', whyItMatters: '研究者可以查阅并比较新的观测。',
    text: `第${id}批观测资料已公开。`, claims: [], sources: [], createdAt,
    status: 'pending', sentAt: null, attempts: [],
  };
}
const idle = {
  loadConfig: async () => config,
  hn: { discover: async () => [] },
  model: { analyze: async () => { throw new Error('已提交的通知不需要重新调用模型'); } },
};

function remoteSnapshots(): GitHubSnapshotAdapter {
  let snapshot: { version: string; database: Uint8Array } | null = null;
  let commits = 0;
  return {
    readSnapshot: async () => snapshot && { version: snapshot.version, database: Uint8Array.from(snapshot.database) },
    commitSnapshot: async ({ expectedVersion, database }) => {
      if (expectedVersion !== (snapshot?.version ?? null)) throw new GitHubStateError('conflict');
      snapshot = { version: `commit-${++commits}`, database: Uint8Array.from(database) };
      return snapshot.version;
    },
  };
}

test('未确认发送跨 SQLite 重启自动指数退避，等待期间保持待发送并且不重新调用模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-retry-backoff-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  const sentAt: string[] = [];
  let at = createdAt;
  const telegram: RunCycleOptions['telegram'] = { send: async () => {
    sentAt.push(at);
    if (sentAt.length === 1) throw new Error('Timeout with secret transport details');
    if (sentAt.length === 2) return { status: 'unknown', failureCode: 'network', permanent: true };
    return { status: 'sent', messageId: 'confirmed' };
  } };
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    for (const [time, attempts, status] of [
      [createdAt, 1, 'pending'],
      ['2026-11-01T01:00:59.000Z', 1, 'pending'],
      ['2026-11-01T01:01:00.000Z', 2, 'pending'],
      ['2026-11-01T01:02:59.000Z', 2, 'pending'],
      ['2026-11-01T01:03:00.000Z', 3, 'sent'],
    ] as const) {
      at = time;
      state.close();
      state = createSqliteStateStore(path);
      const result = await runCycle({ ...idle, state, telegram, clock: () => new Date(at) });
      assert.equal(result.notifications[0]?.status, status, time);
      assert.equal(result.notifications[0]?.attempts.length, attempts, time);
    }
    assert.deepEqual(sentAt, [createdAt, '2026-11-01T01:01:00.000Z', '2026-11-01T01:03:00.000Z']);
    assert.doesNotMatch(JSON.stringify(await state.load()), /secret transport/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram 限流指定的等待时间长于本地退避时遵守服务方等待，达到时间才自动重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-retry-after-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let sends = 0;
  const telegram: RunCycleOptions['telegram'] = { send: async () => ++sends === 1
    ? { status: 'failed', failureCode: 'rate-limited', retryAfterSeconds: 300 }
    : { status: 'sent', messageId: 'after-rate-limit' } };
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    await runCycle({ ...idle, state, telegram, clock: () => new Date(createdAt) });
    const waiting = await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-01T01:04:59.000Z') });
    assert.equal(sends, 1);
    assert.equal(waiting.notifications[0]?.status, 'pending');
    const recovered = await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-01T01:05:00.000Z') });
    assert.equal(sends, 2);
    assert.equal(recovered.notifications[0]?.status, 'sent');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('每次外部发送前已远端提交对应的进行中尝试，发送确认和历史在新 runner 中可读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-attempt-checkpoint-'));
  const github = remoteSnapshots();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github });
  const observer = createGitHubStateStore({ path: join(directory, 'observer.sqlite'), github });
  const sent: string[] = [];
  try {
    await first.load();
    await first.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification(), pendingNotification('602')], lastRunAt: createdAt });
    const result = await runCycle({ ...idle, state: first, clock: () => new Date(createdAt), telegram: { send: async ({ text }) => {
      const durable = await observer.load();
      const sending = durable.notifications.find((notification) => notification.text === text)!;
      assert.equal(sending.status, 'pending');
      assert.deepEqual(sending.attempts.at(-1), { at: createdAt, status: 'in-flight' });
      if (sent.length) assert.equal(durable.notifications[0]?.status, 'sent');
      sent.push(text);
      return { status: 'sent', messageId: `confirmed-${sent.length}` };
    } } });
    assert.deepEqual(sent, ['第601批观测资料已公开。', '第602批观测资料已公开。']);
    assert.deepEqual((await observer.load()).notifications, result.notifications);
    assert.equal(result.notifications.every((notification) => notification.status === 'sent' && notification.attempts.length === 1 && notification.attempts[0]?.status === 'sent'), true);
  } finally {
    first.close(); observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('明确永久故障停止自动重试，持久恢复指令只授予一次新机会并保留故障历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-permanent-send-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let sends = 0;
  const telegram: RunCycleOptions['telegram'] = { send: async () => ++sends < 3
    ? { status: 'failed', failureCode: 'recipient-unavailable', permanent: true }
    : { status: 'sent', messageId: 'recipient-fixed' } };
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    await runCycle({ ...idle, state, telegram, clock: () => new Date(createdAt) });
    const blocked = await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.equal(sends, 1);
    assert.equal(blocked.notifications[0]?.status, 'pending');
    assert.deepEqual(blocked.notifications[0]?.attempts[0], { at: createdAt, status: 'failed', failureCode: 'recipient-unavailable', permanent: true });
    for (const [generation, at, expectedStatus] of [
      [1, '2026-11-01T01:02:00.000Z', 'pending'],
      [2, '2026-11-01T01:20:00.000Z', 'sent'],
    ] as const) {
      const resumed = await state.load();
      resumed.control = { manuallyPaused: false, deliveryRetryGeneration: generation };
      await state.save(resumed);
      const result = await runCycle({ ...idle, state, telegram, clock: () => new Date(at) });
      assert.equal(sends, generation + 1);
      assert.equal(result.notifications[0]?.status, expectedStatus);
      assert.equal(result.notifications[0]?.attempts.at(-1)?.retryGeneration, generation);
      if (generation === 1) {
        await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-01T01:10:00.000Z') });
        assert.equal(sends, 2);
      }
    }
    assert.equal((await state.load()).notifications[0]?.attempts.length, 3);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('远端发送进度提交耗时跨过上海 23:00 时重新准入，次日才恢复实际发送', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-checkpoint-window-'));
  const state = createGitHubStateStore({ path: join(directory, 'runner.sqlite'), github: remoteSnapshots() });
  let at = '2026-11-01T14:59:59.000Z';
  let sends = 0;
  let closesWindow = true;
  const common = { ...idle, telegram: { send: async () => { sends++; return { status: 'sent' as const, messageId: 'next-day' }; } }, clock: () => new Date(at) };
  try {
    await state.load();
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    const night = await runCycle({ ...common, state: {
      load: () => state.load(),
      save: async (snapshot) => {
        await state.save(snapshot);
        if (closesWindow && snapshot.notifications.some((notification) => notification.attempts.at(-1)?.status === 'in-flight')) {
          closesWindow = false;
          at = '2026-11-01T15:00:00.000Z';
        }
      },
    } });
    assert.equal(sends, 0);
    assert.equal(night.notifications[0]?.status, 'pending');
    at = '2026-11-02T00:00:00.000Z';
    const morning = await runCycle({ ...common, state });
    assert.equal(sends, 1);
    assert.equal(morning.notifications[0]?.status, 'sent');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner 在提交发送进度后、外部发送前退出，新 runner 保留未确认尝试并在退避后恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-before-send-exit-'));
  const github = remoteSnapshots();
  const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github });
  const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github });
  let sends = 0;
  const telegram: RunCycleOptions['telegram'] = { send: async () => { sends++; return { status: 'sent', messageId: 'after-exit' }; } };
  try {
    await first.load();
    await first.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    await assert.rejects(runCycle({ ...idle, telegram, clock: () => new Date(createdAt), state: {
      load: () => first.load(),
      save: async (snapshot) => {
        await first.save(snapshot);
        if (snapshot.notifications.some((notification) => notification.attempts.at(-1)?.status === 'in-flight')) throw new Error('Runner exited before transport');
      },
    } }), /Runner exited before transport/);
    first.close();
    assert.equal(sends, 0);
    const waiting = await runCycle({ ...idle, state: second, telegram, clock: () => new Date('2026-11-01T01:00:59.000Z') });
    assert.equal(sends, 0);
    assert.deepEqual(waiting.notifications[0]?.attempts, [{ at: createdAt, status: 'in-flight' }]);
    const delivered = await runCycle({ ...idle, state: second, telegram, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.equal(sends, 1);
    assert.equal(delivered.notifications[0]?.status, 'sent');
    assert.deepEqual(delivered.notifications[0]?.attempts.map(({ status }) => status), ['in-flight', 'sent']);
  } finally {
    first.close(); second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram 已接收但响应丢失或确认提交失败时，新 runner 重复送达未确认内容，失败周期不继续发送下一条', async (t) => {
  for (const failure of ['response-lost', 'confirmation-save-failed'] as const) {
    await t.test(failure, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-after-send-loss-'));
      const github = remoteSnapshots();
      const first = createGitHubStateStore({ path: join(directory, 'first.sqlite'), github });
      const second = createGitHubStateStore({ path: join(directory, 'second.sqlite'), github });
      const received: string[] = [];
      const notifications = failure === 'response-lost' ? [pendingNotification()] : [pendingNotification(), pendingNotification('602')];
      try {
        await first.load();
        await first.save({ schemaVersion: 1, candidates: [], digest: [], notifications, lastRunAt: createdAt });
        const firstCycle = runCycle({ ...idle, clock: () => new Date(createdAt), state: {
          load: () => first.load(),
          save: async (snapshot) => {
            if (failure === 'confirmation-save-failed' && snapshot.notifications.some(({ status }) => status === 'sent')) throw new GitHubStateError('save-failed');
            await first.save(snapshot);
          },
        }, telegram: { send: async ({ text }) => {
          received.push(text);
          if (failure === 'response-lost') throw new Error('Telegram accepted; response was lost with private transport details');
          return { status: 'sent', messageId: 'received-before-save-failed' };
        } } });
        if (failure === 'confirmation-save-failed') await assert.rejects(firstCycle, { code: 'save-failed' });
        else assert.equal((await firstCycle).notifications[0]?.status, 'pending');
        assert.deepEqual(received, ['第601批观测资料已公开。']);
        first.close();
        const durable = await second.load();
        assert.equal(durable.notifications[0]?.status, 'pending');
        assert.equal(durable.notifications[0]?.attempts[0]?.status, failure === 'response-lost' ? 'unknown' : 'in-flight');
        if (failure === 'confirmation-save-failed') assert.deepEqual(durable.notifications[1]?.attempts, []);
        const recovered = await runCycle({ ...idle, state: second, clock: () => new Date('2026-11-01T01:01:00.000Z'), telegram: { send: async ({ text }) => {
          received.push(text);
          return { status: 'sent', messageId: `recovered-${received.length}` };
        } } });
        assert.deepEqual(received, failure === 'response-lost'
          ? ['第601批观测资料已公开。', '第601批观测资料已公开。']
          : ['第601批观测资料已公开。', '第601批观测资料已公开。', '第602批观测资料已公开。']);
        assert.equal(recovered.notifications.every(({ status }) => status === 'sent'), true);
        assert.equal(recovered.notifications[0]?.attempts.length, 2);
        assert.doesNotMatch(JSON.stringify(recovered), /private transport details/);
      } finally {
        first.close(); second.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('发送前的远端版本冲突阻止陈旧快照的所有发送，新周期以最新暂停状态恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-send-conflict-'));
  const github = remoteSnapshots();
  const stale = createGitHubStateStore({ path: join(directory, 'stale.sqlite'), github });
  const current = createGitHubStateStore({ path: join(directory, 'current.sqlite'), github });
  let sends = 0;
  let race = true;
  const telegram: RunCycleOptions['telegram'] = { send: async () => { sends++; return { status: 'sent', messageId: 'after-conflict' }; } };
  try {
    await stale.load();
    await stale.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [pendingNotification()], lastRunAt: createdAt });
    await assert.rejects(runCycle({ ...idle, telegram, clock: () => new Date(createdAt), state: {
      load: () => stale.load(),
      save: async (snapshot) => {
        if (race && snapshot.notifications.some((notification) => notification.attempts.at(-1)?.status === 'in-flight')) {
          race = false;
          const newer = await current.load();
          newer.control = { manuallyPaused: true };
          await current.save(newer);
        }
        await stale.save(snapshot);
      },
    } }), { code: 'conflict' });
    assert.equal(sends, 0);
    const paused = await runCycle({ ...idle, state: stale, telegram, clock: () => new Date('2026-11-01T01:01:00.000Z') });
    assert.equal(sends, 0);
    assert.deepEqual(paused.notifications[0]?.attempts, []);
    const resumed = await current.load();
    resumed.control = { manuallyPaused: false };
    await current.save(resumed);
    const delivered = await runCycle({ ...idle, state: stale, telegram, clock: () => new Date('2026-11-01T01:02:00.000Z') });
    assert.equal(sends, 1);
    assert.equal(delivered.notifications[0]?.status, 'sent');
  } finally {
    stale.close(); current.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧夜间通知的不可恢复尝试不能被新建晨间汇总绕过，恢复机会仍属于原通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-summary-retry-owner-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const legacy = { ...pendingNotification(), createdAt: '2026-11-01T15:00:00.000Z' };
  legacy.attempts.push({ at: '2026-11-02T00:00:00.000Z', status: 'failed', failureCode: 'recipient-unavailable', permanent: true });
  const sent: string[] = [];
  const telegram: RunCycleOptions['telegram'] = { send: async ({ text }) => { sent.push(text); return { status: 'sent', messageId: 'same-owner' }; } };
  try {
    await state.save({ schemaVersion: 1, candidates: [], digest: [], notifications: [legacy], lastRunAt: '2026-11-02T00:00:00.000Z' });
    const blocked = await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-02T00:01:00.000Z') });
    assert.deepEqual(sent, []);
    assert.equal(blocked.notifications[0]?.status, 'pending');
    const resumed = await state.load();
    resumed.control = { manuallyPaused: false, deliveryRetryGeneration: 1 };
    await state.save(resumed);
    const delivered = await runCycle({ ...idle, state, telegram, clock: () => new Date('2026-11-02T00:02:00.000Z') });
    assert.deepEqual(sent, [legacy.text]);
    assert.equal(delivered.notifications[0]?.status, 'sent');
    assert.equal(delivered.notifications[0]?.attempts.length, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
