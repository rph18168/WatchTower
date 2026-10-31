import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteStateStore, DigestModelError, runCycle } from '../src/index.ts';
import type { BudgetPauseReason, CandidateStory, DigestModelAdapter, ModelUsage, ModelUsageLimits, WatchTowerConfig } from '../src/index.ts';

const config: WatchTowerConfig = {
  model: 'test/digest',
  topics: [{ id: 'science', description: '公共科研设施与开放资料' }],
};
const story = (id: string): CandidateStory => ({
  id, title: `Public archive ${id}`, url: `https://science.example/${id}`,
  hnUrl: `https://news.ycombinator.com/item?id=${id}`, score: 30,
  publishedAt: '2026-11-01T00:00:00.000Z',
});
const model = (costUsd = 0.1): DigestModelAdapter => ({
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({
    decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['science'], summary: '公共科研资料开放，使用者可查阅相关观测。' })),
    usage: { costUsd, inputTokens: 100, outputTokens: 20, costComplete: true },
  }),
});

test('月预算为零时仍持久保存新候选，并公开预算暂停和待处理状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-budget-'));
  const databasePath = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(databasePath);
  try {
    const result = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0 } }),
      state, hn: { discover: async () => [story('301')] },
      model: { ...model(), analyze: async () => { throw new Error('预算为零不应发出付费请求'); } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    assert.equal(result.status.budget.pauseReason, 'monthly-budget');
    assert.equal(result.status.pendingCandidateCount, 1);
    assert.equal(result.usage, null);
    state.close();
    state = createSqliteStateStore(databasePath);
    const saved = await state.load();
    assert.equal(saved.candidates[0]?.story.id, '301');
    assert.equal(saved.budget?.pauseReason, 'monthly-budget');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('已发生费用经重启及配置下调仍保留，UTC 月界即上海 08:00 后重新处理候选', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-month-'));
  const databasePath = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(databasePath);
  try {
    const first = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0.5 } }),
      state, hn: { discover: async () => [story('302')] }, model: model(0.6),
      clock: () => new Date('2026-10-31T23:45:00.000Z'),
    });
    assert.equal(first.status.budget.spentUsd, 0.6);
    assert.equal(first.status.budget.pauseReason, 'monthly-budget');
    state.close();
    state = createSqliteStateStore(databasePath);
    const paused = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0.4 } }),
      state, hn: { discover: async () => [story('303')] },
      model: { ...model(), analyze: async () => { throw new Error('已用月费不能被配置变化抹除'); } },
      clock: () => new Date('2026-10-31T23:59:59.999Z'),
    });
    assert.equal(paused.status.budget.spentUsd, 0.6);
    assert.equal(paused.status.budget.pauseReason, 'monthly-budget');
    assert.equal(paused.status.pendingCandidateCount, 1);
    const resumed = await runCycle({
      loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0.4 } }),
      state, hn: { discover: async () => [] }, model: model(0.2),
      clock: () => new Date('2026-11-01T00:00:00.000Z'),
    });
    assert.equal(resumed.status.pendingCandidateCount, 0);
    assert.equal(resumed.status.budget.month, '2026-11');
    assert.equal(resumed.status.budget.spentUsd, 0.2);
    assert.equal(resumed.status.budget.remainingUsd, 0.2);
    assert.equal(resumed.digest.length, 2);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺失或部分费用留存已知收费且暂停后续模型工作，月界也不能把未知费用当零', async (t) => {
  for (const usage of [
    { costUsd: null, inputTokens: null, outputTokens: null, costComplete: false },
    { costUsd: 0.04, inputTokens: 100, outputTokens: 20, costComplete: false },
  ] satisfies ModelUsage[]) {
    await t.test(`costUsd=${usage.costUsd}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-unknown-'));
      const path = join(directory, 'state.sqlite');
      let state = createSqliteStateStore(path);
      try {
        const first = await runCycle({
          loadConfig: async () => config, state, hn: { discover: async () => [story('304')] },
          model: { ...model(), analyze: async (request) => ({ ...await model().analyze(request), usage }) },
          clock: () => new Date('2026-10-31T23:55:00.000Z'),
        });
        assert.equal(first.status.budget.pauseReason, 'unknown-cost');
        assert.equal(first.status.budget.spentUsd, usage.costUsd ?? 0);
        state.close();
        state = createSqliteStateStore(path);
        const next = await runCycle({
          loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 100 } }),
          state, hn: { discover: async () => [story('305')] },
          model: { ...model(), analyze: async () => { throw new Error('未知费用不能通过月界或上调配置绕过'); } },
          clock: () => new Date('2026-11-01T00:00:00.000Z'),
        });
        assert.equal(next.status.budget.pauseReason, 'unknown-cost');
        assert.equal(next.status.pendingCandidateCount, 1);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('失败的模型请求也结算实际收费或留下未知费用，重启不会免费重试', async (t) => {
  for (const receipt of [
    { costUsd: 0.12, inputTokens: 100, outputTokens: 20, costComplete: true },
    { costUsd: null, inputTokens: null, outputTokens: null, costComplete: false },
  ] satisfies ModelUsage[]) {
    await t.test(`failed costUsd=${receipt.costUsd}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-failed-cost-'));
      const path = join(directory, 'state.sqlite');
      let state = createSqliteStateStore(path);
      try {
        await assert.rejects(runCycle({
          loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0.1 } }),
          state, hn: { discover: async () => [story('306')] },
          model: { ...model(), analyze: async () => { throw new DigestModelError(receipt); } },
          clock: () => new Date('2026-11-01T01:00:00.000Z'),
        }), DigestModelError);
        state.close();
        state = createSqliteStateStore(path);
        const recovered = await runCycle({
          loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 0.1 } }),
          state, hn: { discover: async () => [] },
          model: { ...model(), analyze: async () => { throw new Error('失败收费已经用完可用预算'); } },
          clock: () => new Date('2026-11-01T01:15:00.000Z'),
        });
        assert.equal(recovered.status.budget.spentUsd, receipt.costUsd ?? 0);
        assert.equal(recovered.status.budget.pauseReason, receipt.costComplete ? 'monthly-budget' : 'unknown-cost');
        assert.equal(recovered.status.pendingCandidateCount, 1);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('应用配置不能覆盖 provider 拦截或未知额度，provider 恢复后可继续', async (t) => {
  for (const getAllowance of [
    async () => ({ remainingUsd: 0, usageMonthlyUsd: 1 }),
    async () => { throw new Error('provider metadata contains private transport detail'); },
  ]) {
    await t.test(getAllowance.toString().includes('throw') ? 'metadata failure' : 'no provider allowance', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-provider-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      try {
        const paused = await runCycle({
          loadConfig: async () => ({ ...config, usage: { monthlyBudgetUsd: 100 } }),
          state, hn: { discover: async () => [story('307')] },
          model: { ...model(), getAllowance, analyze: async () => { throw new Error('本地额度不能覆盖 provider'); } },
          clock: () => new Date('2026-11-01T01:00:00.000Z'),
        });
        assert.ok(['provider-limit', 'provider-unavailable'].includes(paused.status.budget.pauseReason!));
        assert.equal(paused.status.pendingCandidateCount, 1);
        const resumed = await runCycle({
          loadConfig: async () => config, state, hn: { discover: async () => [] }, model: model(),
          clock: () => new Date('2026-11-01T01:15:00.000Z'),
        });
        assert.equal(resumed.status.pendingCandidateCount, 0);
        assert.equal(resumed.status.budget.pauseReason, null);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('每轮费用、步数与 UTF-8 输入规模限制在付费请求前生效', async (t) => {
  const cases: { limits: Partial<ModelUsageLimits>; reason: BudgetPauseReason }[] = [
    { limits: { runBudgetUsd: 0 }, reason: 'run-budget' },
    { limits: { maxSteps: 0 }, reason: 'steps' },
    { limits: { maxInputBytes: 100 }, reason: 'input-size' },
  ];
  for (const { limits, reason } of cases) {
    await t.test(reason, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-limits-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      try {
        const paused = await runCycle({
          loadConfig: async () => ({ ...config, usage: limits }),
          state, hn: { discover: async () => [story('308')] },
          model: { ...model(), analyze: async () => { throw new Error('请求超出配置限额'); } },
          clock: () => new Date('2026-11-01T01:00:00.000Z'),
        });
        assert.equal(paused.status.budget.pauseReason, reason);
        assert.equal(paused.status.pendingCandidateCount, 1);
        const resumed = await runCycle({
          loadConfig: async () => config, state, hn: { discover: async () => [] }, model: model(),
          clock: () => new Date('2026-11-01T01:15:00.000Z'),
        });
        assert.equal(resumed.status.pendingCandidateCount, 0);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('追加请求与重试共享逐次准入，上一响应实际费用在下一次派发前已核算', async (t) => {
  const cases: { limits: Partial<ModelUsageLimits>; reason: BudgetPauseReason; firstUsage?: ModelUsage; secondBytes?: number; secondOutput?: number; providerBlocked?: boolean }[] = [
    { limits: { maxSteps: 1 }, reason: 'steps' },
    { limits: { runBudgetUsd: 0.1 }, reason: 'run-budget' },
    { limits: { monthlyBudgetUsd: 0.1 }, reason: 'monthly-budget' },
    { limits: {}, reason: 'unknown-cost', firstUsage: { costUsd: 0.2, inputTokens: 100, outputTokens: 20, costComplete: false } },
    { limits: {}, reason: 'provider-limit', providerBlocked: true },
    { limits: { maxInputBytes: 2000 }, reason: 'input-size', secondBytes: 2001 },
    { limits: { maxOutputTokens: 128 }, reason: 'output-size', secondOutput: 129 },
  ];
  for (const { limits, reason, firstUsage, secondBytes, secondOutput, providerBlocked } of cases) {
    await t.test(reason, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-each-request-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      let paidRequests = 0;
      let providerRemaining = 100;
      try {
        const result = await runCycle({
          loadConfig: async () => ({ ...config, usage: limits }),
          state, hn: { discover: async () => [story('309')] },
          model: {
            getAllowance: async () => ({ remainingUsd: providerRemaining, usageMonthlyUsd: 0 }),
            analyze: async ({ execution }) => {
              assert.ok(execution);
              await execution.beforeRequest({ inputBytes: 1000, maxOutputTokens: execution.maxOutputTokens });
              paidRequests += 1;
              await execution.recordUsage(firstUsage ?? { costUsd: 0.2, inputTokens: 100, outputTokens: 20, costComplete: true });
              if (providerBlocked) providerRemaining = 0;
              await execution.beforeRequest({ inputBytes: secondBytes ?? 1000, maxOutputTokens: secondOutput ?? execution.maxOutputTokens });
              paidRequests += 1;
              throw new Error('追加付费请求应被拦截');
            },
          },
          clock: () => new Date('2026-11-01T01:00:00.000Z'),
        });
        assert.equal(paidRequests, 1);
        assert.equal(result.status.budget.spentUsd, 0.2);
        assert.equal(result.usage?.costUsd, 0.2);
        assert.equal(result.usage?.costComplete, reason !== 'unknown-cost');
        assert.equal(result.status.budget.pauseReason, reason);
        assert.equal(result.status.pendingCandidateCount, 1);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('无效用量配置在任何采集或付费操作前拒绝，不能成为无限额度', async (t) => {
  for (const raw of ['{"monthlyBudgetUsd":-1}', '{"runBudgetUsd":"0.1"}', '{"maxSteps":0.5}', '{"maxInputBytes":0}', '{"maxOutputTokens":0}', 'null', '[]']) {
    await t.test(raw, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'watchtower-invalid-limits-'));
      const state = createSqliteStateStore(join(directory, 'state.sqlite'));
      try {
        await assert.rejects(runCycle({
          loadConfig: async () => ({ ...config, usage: JSON.parse(raw) }),
          state,
          hn: { discover: async () => { throw new Error('无效配置不得启动采集'); } },
          model: model(), clock: () => new Date('2026-11-01T01:00:00.000Z'),
        }), /usage limits/);
      } finally {
        state.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('在途费用记录必须等状态存储确认持久化后才开始模型操作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-budget-checkpoint-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let paidRequests = 0;
  try {
    const running = runCycle({
      loadConfig: async () => config,
      state: {
        load: () => state.load(),
        save: async (snapshot) => {
          await state.save(snapshot);
          if (snapshot.budget?.calls?.some(({ status }) => status === 'in-flight')) {
            arrived.resolve();
            await release.promise;
          }
        },
      },
      hn: { discover: async () => [story('310')] },
      model: { ...model(), analyze: async (request) => { paidRequests += 1; return model().analyze(request); } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    await arrived.promise;
    assert.equal(paidRequests, 0);
    release.resolve();
    const result = await running;
    assert.equal(result.status.processedCandidateCount, 1);
  } finally {
    release.resolve();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('费用回执保存失败阻止追加请求，重新打开 SQLite 后以在途未知费用暂停', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-budget-save-failure-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let paidRequests = 0;
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config,
      state: {
        load: () => state.load(),
        save: async (snapshot) => {
          if (snapshot.budget?.calls?.some(({ status }) => status === 'complete')) throw new Error('Simulated durable checkpoint failure');
          await state.save(snapshot);
        },
      },
      hn: { discover: async () => [story('311')] },
      model: { ...model(), analyze: async ({ execution }) => {
        assert.ok(execution);
        await execution.beforeRequest({ inputBytes: 1000, maxOutputTokens: execution.maxOutputTokens });
        paidRequests += 1;
        await execution.recordUsage({ costUsd: 0.01, inputTokens: 100, outputTokens: 20, costComplete: true });
        paidRequests += 1;
        throw new Error('不能继续请求');
      } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    }), /checkpoint failure/);
    assert.equal(paidRequests, 1);
    state.close();
    state = createSqliteStateStore(path);
    const recovered = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { ...model(), analyze: async () => { throw new Error('未持久结算的请求费用仍未知'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(recovered.status.budget.pauseReason, 'unknown-cost');
    assert.equal(recovered.status.pendingCandidateCount, 1);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('后续请求失败的累计 usage 不会重复计入之前已保存的收费', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-aggregate-failure-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story('312')] },
      model: { ...model(), analyze: async ({ execution }) => {
        assert.ok(execution);
        await execution.beforeRequest({ inputBytes: 1000, maxOutputTokens: execution.maxOutputTokens });
        await execution.recordUsage({ costUsd: 0.03, inputTokens: 100, outputTokens: 20, costComplete: true });
        await execution.beforeRequest({ inputBytes: 1000, maxOutputTokens: execution.maxOutputTokens });
        throw new DigestModelError({ costUsd: 0.03, inputTokens: 100, outputTokens: 20, costComplete: false });
      } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    }), DigestModelError);
    const next = await runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [] },
      model: { ...model(), analyze: async () => { throw new Error('追加请求费用仍未知'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(next.status.budget.spentUsd, 0.03);
    assert.equal(next.status.budget.pauseReason, 'unknown-cost');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
