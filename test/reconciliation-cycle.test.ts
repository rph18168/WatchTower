import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteStateStore, runCycle } from '../src/index.ts';
import type { ModelCallAccountingReconciliation } from '../src/index.ts';

test('核账审计跨完整周期和 SQLite 重开保留费用来源，公开快照仅保留固定审计字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconciled-history-'));
  const path = join(directory, 'state.sqlite');
  let store = createSqliteStateStore(path);
  const audit: ModelCallAccountingReconciliation = {
    method: 'operator-confirmed-exclusive-key-delta', reconciledAt: '2026-11-01T07:40:34.326Z',
    originalStatus: 'unknown', originalCostUsd: null, exclusiveKeyUseConfirmed: true,
    beforeCheckedAt: '2026-11-01T06:16:05.726Z', beforeUsageMonthlyUsd: 0,
    sourceQueryRunId: '41283594068', sourceQueryCheckedAt: '2026-11-01T07:08:53.764Z', afterUsageMonthlyUsd: 0.0000159,
  };
  try {
    const state = await store.load();
    state.control = { manuallyPaused: true };
    state.budget = { pauseReason: null, calls: [
      { id: '2ccb283d-b872-4b8d-b20f-eb4d68678f06', startedAt: '2026-11-01T06:16:05.854Z', model: 'openai/gpt-4.1-mini', status: 'complete', costUsd: 0.0000159, costComplete: true, inputTokens: null, outputTokens: null,
        accountingReconciliation: { ...audit, ...{ label: 'PRIVATE_AUDIT_LABEL', providerBody: 'PRIVATE_AUDIT_BODY', ownerId: 'PRIVATE_AUDIT_ID' } } },
      { id: 'previous-call', startedAt: '2026-10-31T23:50:00.000Z', model: 'test/previous', status: 'complete', costUsd: 0.1, costComplete: true, inputTokens: 50, outputTokens: 10 },
    ] };
    Object.assign(state.budget.calls![1]!, { accountingReconciliation: { method: 'PRIVATE_FORGED_METHOD', sourceQueryRunId: 'PRIVATE_FORGED_ID' } });
    await store.save(state);
    const options = {
      commandsOnly: true,
      loadConfig: async () => ({ model: 'z-ai/glm-5.3-flash', topics: [{ id: 'computing', description: '计算技术进展' }] }),
      hn: { discover: async () => { throw new Error('只读周期不应采集'); } },
      model: { analyze: async () => { throw new Error('只读周期不应付费'); } },
    };
    await runCycle({ ...options, state: store, clock: () => new Date('2026-11-01T08:00:00.000Z') });
    store.close();
    store = createSqliteStateStore(path);
    const recovered = await runCycle({ ...options, state: store, clock: () => new Date('2026-11-01T08:15:00.000Z') });
    assert.equal(recovered.status.budget.spentUsd, 0.0000159);
    assert.equal(recovered.status.manuallyPaused, true);
    assert.equal(recovered.usage, null);
    const saved = await store.load();
    const call = saved.budget!.calls![0]!;
    assert.deepEqual(call.accountingReconciliation, audit);
    assert.equal(call.costUsd, 0.0000159);
    assert.equal(call.costComplete, true);
    assert.equal(call.inputTokens, null);
    assert.equal(call.outputTokens, null);
    assert.equal(call.responseId, undefined);
    assert.equal(saved.budget!.calls![1]!.accountingReconciliation, undefined);
    assert.doesNotMatch(JSON.stringify(saved) + (await readFile(path)).toString(), /PRIVATE_/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
