import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSqliteStateStore, runCycle } from '../src/index.ts';
import type { MonitoringState } from '../src/index.ts';

const script = fileURLToPath(new URL('../src/maintenance-reconcile.ts', import.meta.url));
const expectedHead = 'a'.repeat(40);
const savedHead = 'b'.repeat(40);
const checkedAt = '2026-11-01T07:20:00.000Z';
const provider = {
  usage: 0.0000159, usage_daily: 0.0000159, usage_weekly: 0.0000159, usage_monthly: 0.0000159,
  byok_usage: 0, byok_usage_daily: 0, byok_usage_weekly: 0, byok_usage_monthly: 0,
  limit: 1, limit_remaining: 0.9999841, label: 'PRIVATE_LABEL', hash: 'PRIVATE_HASH', creator: 'PRIVATE_IDENTITY',
};

async function fixture(directory: string): Promise<MonitoringState> {
  const store = createSqliteStateStore(join(directory, 'before.sqlite'));
  try {
    await store.save({
      schemaVersion: 1, lastRunAt: '2026-11-01T06:13:41.279Z',
      candidates: [{ story: { id: '50322173', title: 'A saved candidate', hnUrl: 'https://news.ycombinator.com/item?id=50322173', score: 30, publishedAt: '2026-11-01T06:00:00.000Z' }, discoveredAt: '2026-11-01T06:16:01.436Z', status: 'pending', processedAt: null, topicIds: [], initialBaseline: true }],
      digest: [],
      notifications: [{ kind: 'budget-status', origin: 'proactive', id: 'budget-status:1', text: '模型费用待核对。', createdAt: '2026-11-01T06:16:01.436Z', status: 'sent', sentAt: '2026-11-01T06:16:12.267Z', messageId: '5', attempts: [{ at: '2026-11-01T06:16:11.000Z', status: 'sent', messageId: '5' }] }],
      initialBaseline: { since: '2026-10-30T06:16:01.436Z', until: '2026-11-01T06:16:01.436Z', status: 'building', completedAt: null },
      control: { manuallyPaused: true, telegramOffset: 4, deliveryRetryGeneration: 2, fault: { code: 'model-processing', at: '2026-11-01T06:16:01.436Z' }, budgetNotice: { fingerprint: 'unknown-cost', sequence: 1 } },
      budget: {
        pauseReason: 'unknown-cost', provider: { checkedAt: '2026-11-01T06:16:05.726Z', remainingUsd: 1, usageMonthlyUsd: 0 },
        calls: [
          { id: 'prior-complete', startedAt: '2026-10-31T23:50:00.000Z', model: 'test/previous', status: 'complete', costUsd: 0.1, costComplete: true, inputTokens: 50, outputTokens: 10 },
          { id: '2ccb283d-b872-4b8d-b20f-eb4d68678f06', startedAt: '2026-11-01T06:16:05.854Z', model: 'openai/gpt-4.1-mini', status: 'unknown', costUsd: null, costComplete: false, inputTokens: null, outputTokens: null },
        ],
      },
    });
    return await store.load();
  } finally { store.close(); }
}

/** Real CLI + SQLite + GitHub CAS protocol; every fetch is intercepted, with no forwarding path. */
async function runMaintenance(directory: string, options: { args?: string[]; now?: string; head?: string; providerData?: unknown; conflict?: boolean; providerFailure?: 'http' | 'parse' | 'transport' } = {}) {
  const preload = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    const seed = readFileSync(${JSON.stringify(join(directory, 'before.sqlite'))});
    const tracePath = ${JSON.stringify(join(directory, 'requests.json'))};
    const trace = [];
    let head = ${JSON.stringify(options.head ?? expectedHead)};
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate { constructor(value) { super(value === undefined ? ${JSON.stringify(options.now ?? checkedAt)} : value); } static now() { return NativeDate.parse(${JSON.stringify(options.now ?? checkedAt)}); } };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      trace.push({ url: url.origin + url.pathname, method });
      writeFileSync(tracePath, JSON.stringify(trace));
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (url.href === 'https://openrouter.ai/api/v1/key') {
        assert.equal(method, 'GET');
        assert.equal(init.body, undefined);
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer PRIVATE_OPENROUTER_KEY');
        if (${options.providerFailure === 'http'}) return Response.json({ error: 'PRIVATE_PROVIDER_BODY' }, { status: 401 });
        if (${options.providerFailure === 'parse'}) return new Response('PRIVATE_INVALID_JSON');
        if (${options.providerFailure === 'transport'}) throw new TypeError('PRIVATE_TRANSPORT_ERROR');
        return Response.json({ data: ${JSON.stringify(options.providerData ?? provider)} });
      }
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-github-token');
      if (method === 'GET' && url.pathname === '/repos/rph18168/WatchTower/git/ref/heads/watchtower-state') return Response.json({ object: { sha: head } });
      if (method === 'GET' && url.pathname === '/repos/rph18168/WatchTower/contents/state.sqlite') {
        assert.equal(url.searchParams.get('ref'), head);
        return new Response(seed);
      }
      if (method === 'POST' && url.pathname === '/graphql') {
        const { input } = JSON.parse(init.body).variables;
        assert.deepEqual(input.branch, { repositoryNameWithOwner: 'rph18168/WatchTower', branchName: 'watchtower-state' });
        assert.equal(input.expectedHeadOid, ${JSON.stringify(expectedHead)});
        assert.deepEqual(input.fileChanges.additions.map(({ path }) => path), ['state.sqlite']);
        if (${options.conflict === true}) {
          head = 'cccccccccccccccccccccccccccccccccccccccc';
          return Response.json({ errors: [{ type: 'STALE_DATA', message: 'PRIVATE_CONFLICT_BODY' }] });
        }
        writeFileSync(${JSON.stringify(join(directory, 'after.sqlite'))}, Buffer.from(input.fileChanges.additions[0].contents, 'base64'));
        head = ${JSON.stringify(savedHead)};
        return Response.json({ data: { createCommitOnBranch: { commit: { oid: head } } } });
      }
      throw new Error('PRIVATE_UNEXPECTED_NETWORK');
    };
  `;
  await writeFile(join(directory, 'requests.json'), '[]');
  const args = options.args ?? ['--expected-state-sha', expectedHead, '--confirm-exclusive-key-delta'];
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args], {
    cwd: directory, env: { OPENROUTER_API_KEY: 'PRIVATE_OPENROUTER_KEY', GITHUB_TOKEN: 'test-github-token' }, encoding: 'utf8', timeout: 15_000,
  });
}

test('一次性维护 CLI 只按已确认的 key 用量差额核清指定费用，经 SQLite/CAS 保留全部业务状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-'));
  try {
    const before = await fixture(directory);
    const result = await runMaintenance(directory);
    assert.equal(result.status, 0, result.stderr);
    const afterStore = createSqliteStateStore(join(directory, 'after.sqlite'));
    try {
      const after = await afterStore.load();
      const expected = structuredClone(before);
      expected.budget!.pauseReason = null;
      Object.assign(expected.budget!.calls![1]!, {
        status: 'complete', costUsd: 0.0000159, costComplete: true,
        accountingReconciliation: {
          method: 'operator-confirmed-exclusive-key-delta', reconciledAt: checkedAt,
          originalStatus: 'unknown', originalCostUsd: null, exclusiveKeyUseConfirmed: true,
          beforeCheckedAt: '2026-11-01T06:16:05.726Z', beforeUsageMonthlyUsd: 0,
          sourceQueryRunId: '41283594068', sourceQueryCheckedAt: '2026-11-01T07:08:53.764Z', afterUsageMonthlyUsd: 0.0000159,
        },
      });
      assert.deepEqual(after, expected);
      assert.equal(JSON.parse(result.stdout).stateSha, savedHead);
      assert.doesNotMatch(result.stdout + result.stderr + (await readFile(join(directory, 'after.sqlite'))).toString(), /PRIVATE_/);
      const requests: { url: string; method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
      assert.equal(requests.filter(({ url }) => url.startsWith('https://openrouter.ai/')).length, 1);
    } finally { afterStore.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('维护保存遇到 GitHub CAS 冲突不重试提交、不覆盖远端，也不泄露拒绝正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-conflict-'));
  try {
    await fixture(directory);
    const bytesBefore = await readFile(join(directory, 'before.sqlite'));
    const result = await runMaintenance(directory, { conflict: true });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { outcome: 'failed', stateError: 'conflict' });
    await assert.rejects(access(join(directory, 'after.sqlite')));
    assert.deepEqual(await readFile(join(directory, 'before.sqlite')), bytesBefore);
    const requests: { method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('维护入口拒绝 provider 失败和任意修改参数，日志不包含响应或原始错误', async (t) => {
  const failures: ('http' | 'parse' | 'transport')[] = ['http', 'parse', 'transport'];
  for (const providerFailure of failures) await t.test(providerFailure, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-error-'));
    try {
      await fixture(directory);
      const result = await runMaintenance(directory, { providerFailure });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stdout), providerFailure === 'http' ? { outcome: 'refused', reason: 'provider-http', httpStatus: 401 } : { outcome: 'failed' });
      await assert.rejects(access(join(directory, 'after.sqlite')));
      const requests: { method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await t.test('arbitrary-call-or-cost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-args-'));
    try {
      await fixture(directory);
      const result = await runMaintenance(directory, { args: ['--expected-state-sha', expectedHead, '--confirm-exclusive-key-delta', '--call-id', 'PRIVATE_OTHER_CALL', '--cost-usd', '0'] });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stdout), { outcome: 'failed' });
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8')), []);
      await assert.rejects(access(join(directory, 'after.sqlite')));
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('核账审计经完整周期保留费用来源，公开 SQLite 仅保留固定审计字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-public-'));
  try {
    await fixture(directory);
    const result = await runMaintenance(directory);
    assert.equal(result.status, 0, result.stderr);
    const path = join(directory, 'after.sqlite');
    const store = createSqliteStateStore(path);
    try {
      const state = await store.load();
      const expectedAudit = structuredClone(state.budget!.calls![1]!.accountingReconciliation);
      Object.assign(state.budget!.calls![1]!.accountingReconciliation!, { label: 'PRIVATE_AUDIT_LABEL', providerBody: 'PRIVATE_AUDIT_BODY', ownerId: 'PRIVATE_AUDIT_ID' });
      Object.assign(state.budget!.calls![0]!, { accountingReconciliation: { method: 'PRIVATE_FORGED_METHOD', sourceQueryRunId: 'PRIVATE_FORGED_ID' } });
      await store.save(state);
      const cycle = await runCycle({
        commandsOnly: true, state: store,
        loadConfig: async () => ({ model: 'z-ai/glm-5.3-flash', topics: [{ id: 'computing', description: '计算技术进展' }] }),
        hn: { discover: async () => { throw new Error('维护后的只读周期不应采集'); } },
        model: { analyze: async () => { throw new Error('维护后的只读周期不应付费'); } },
        clock: () => new Date('2026-11-01T07:30:00.000Z'),
      });
      assert.equal(cycle.status.budget.spentUsd, 0.0000159);
      assert.equal(cycle.status.manuallyPaused, true);
      assert.equal(cycle.usage, null);
      const saved = await store.load();
      assert.deepEqual(saved.budget!.calls![1]!.accountingReconciliation, expectedAudit);
      assert.equal(saved.budget!.calls![0]!.accountingReconciliation, undefined);
      assert.doesNotMatch(JSON.stringify(saved) + (await readFile(path)).toString(), /PRIVATE_/);
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('provider 用量、BYOK 或额度有变化及缺失／无效字段时，维护 CLI 不核账也不提交', async (t) => {
  const scenarios = [
    { name: 'lifetime-changed', data: { ...provider, usage: 0.00002 } },
    { name: 'monthly-changed', data: { ...provider, usage_monthly: 0.00002 } },
    { name: 'daily-reset', data: { ...provider, usage_daily: 0 } },
    { name: 'weekly-missing', data: { ...provider, usage_weekly: undefined } },
    { name: 'monthly-string', data: { ...provider, usage_monthly: '0.0000159' } },
    { name: 'byok-nonzero', data: { ...provider, byok_usage_monthly: 0.001 } },
    { name: 'byok-null', data: { ...provider, byok_usage: null } },
    { name: 'remaining-changed', data: { ...provider, limit_remaining: 0.9 } },
    { name: 'management-key', data: { ...provider, is_management_key: true } },
    { name: 'invalid-data', data: [] },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-provider-'));
    try {
      await fixture(directory);
      const result = await runMaintenance(directory, { providerData: scenario.data });
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).reason, 'provider-mismatch');
      await assert.rejects(access(join(directory, 'after.sqlite')));
      const requests: { method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('缺少明确确认、有效预期 SHA、同日账务窗口或状态版本不符时，维护 CLI 不写远端', async (t) => {
  const scenarios = [
    { name: 'unconfirmed', args: ['--expected-state-sha', expectedHead], reason: 'confirmation-required' },
    { name: 'invalid-sha', args: ['--expected-state-sha', 'PRIVATE_BAD_SHA', '--confirm-exclusive-key-delta'], reason: 'invalid-state-sha' },
    { name: 'later-day', now: '2026-11-02T07:20:00.000Z', reason: 'date-mismatch' },
    { name: 'before-source-query', now: '2026-11-01T07:00:00.000Z', reason: 'date-mismatch' },
    { name: 'state-version', head: 'c'.repeat(40), reason: 'version-mismatch' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-gate-'));
    try {
      await fixture(directory);
      const result = await runMaintenance(directory, scenario);
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).reason, scenario.reason);
      await assert.rejects(access(join(directory, 'after.sqlite')));
      const requests: { method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('旧调用、调用前 provider 证据或未知项不唯一时，维护 CLI 不修改任何账本项', async (t) => {
  const scenarios: { name: string; change(state: MonitoringState): void }[] = [
    { name: 'target-model', change: (state) => { state.budget!.calls![1]!.model = 'z-ai/glm-5.3-flash'; } },
    { name: 'target-time', change: (state) => { state.budget!.calls![1]!.startedAt = '2026-11-01T06:17:00.000Z'; } },
    { name: 'already-complete', change: (state) => { state.budget!.calls![1]!.status = 'complete'; } },
    { name: 'partial-cost', change: (state) => { state.budget!.calls![1]!.costUsd = 0; } },
    { name: 'tokens-present', change: (state) => { state.budget!.calls![1]!.inputTokens = 10; } },
    { name: 'receipt-present', change: (state) => { state.budget!.calls![1]!.responseId = 'gen-existing'; } },
    { name: 'another-unknown', change: (state) => { state.budget!.calls!.push({ ...state.budget!.calls![1]!, id: 'another-unknown' }); state.control!.manuallyPaused = false; } },
    { name: 'duplicate-target', change: (state) => { state.budget!.calls!.push({ ...state.budget!.calls![1]! }); } },
    { name: 'before-usage-not-zero', change: (state) => { state.budget!.provider!.usageMonthlyUsd = 0.1; } },
    { name: 'before-time-mismatch', change: (state) => { state.budget!.provider!.checkedAt = '2026-11-01T06:15:00.000Z'; } },
    { name: 'different-pause', change: (state) => { state.budget!.pauseReason = 'provider-limit'; } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-reconcile-target-'));
    try {
      await fixture(directory);
      const store = createSqliteStateStore(join(directory, 'before.sqlite'));
      try { const state = await store.load(); scenario.change(state); await store.save(state); }
      finally { store.close(); }
      const bytesBefore = await readFile(join(directory, 'before.sqlite'));
      const result = await runMaintenance(directory);
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).reason, 'state-mismatch');
      await assert.rejects(access(join(directory, 'after.sqlite')));
      assert.deepEqual(await readFile(join(directory, 'before.sqlite')), bytesBefore);
      const requests: { method: string }[] = JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8'));
      assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
      if (scenario.name === 'another-unknown') {
        const retained = createSqliteStateStore(join(directory, 'before.sqlite'));
        try {
          const cycle = await runCycle({
            state: retained, loadConfig: async () => ({ model: 'z-ai/glm-5.3-flash', topics: [{ id: 'computing', description: '计算技术进展' }] }),
            hn: { discover: async () => [] },
            model: { analyze: async () => { throw new Error('另一项未知费用不能因维护而解锁'); } },
            clock: () => new Date('2026-11-01T07:30:00.000Z'),
          });
          assert.equal(cycle.status.budget.pauseReason, 'unknown-cost');
          assert.equal(cycle.usage, null);
        } finally { retained.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
