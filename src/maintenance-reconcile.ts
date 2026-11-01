// Temporary, single-call T10 accounting maintenance. Remove after reconciliation.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHubSnapshotAdapter } from './adapters/github.ts';
import { createGitHubStateStore, GitHubStateError } from './adapters/github-state.ts';

const callId = '2ccb283d-b872-4b8d-b20f-eb4d68678f06';
const costUsd = 0.0000159;
const report = (data: object, exitCode = 0) => {
  process.stdout.write(JSON.stringify(data) + '\n');
  process.exitCode = exitCode;
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'expected-state-sha': { type: 'string' },
    'confirm-exclusive-key-delta': { type: 'boolean', default: false },
  } });
  if (!values['confirm-exclusive-key-delta']) {
    report({ outcome: 'refused', reason: 'confirmation-required' }, 2);
    return;
  }
  const expectedStateSha = values['expected-state-sha'];
  if (!expectedStateSha || !/^[0-9a-f]{40}$/.test(expectedStateSha)) {
    report({ outcome: 'refused', reason: 'invalid-state-sha' }, 2);
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  const key = process.env.OPENROUTER_API_KEY;
  if (!token?.trim() || !key?.trim()) {
    report({ outcome: 'refused', reason: 'missing-credentials' }, 2);
    return;
  }
  const reconciledAt = new Date().toISOString();
  if (reconciledAt.slice(0, 10) !== '2026-11-01' || reconciledAt < '2026-11-01T07:08:53.764Z') {
    report({ outcome: 'refused', reason: 'date-mismatch' }, 1);
    return;
  }
  const github = createGitHubSnapshotAdapter({ repository: 'rph18168/WatchTower', branch: 'watchtower-state', token });
  const snapshot = await github.readSnapshot();
  if (!snapshot) {
    report({ outcome: 'refused', reason: 'state-missing' }, 1);
    return;
  }
  if (snapshot.version !== expectedStateSha) {
    report({ outcome: 'refused', reason: 'version-mismatch' }, 1);
    return;
  }
  let stateSha: string | undefined;
  const store = createGitHubStateStore({ path: resolve('.watchtower/reconcile-2026-11-01.sqlite'), github: {
    readSnapshot: async () => snapshot,
    commitSnapshot: async (request) => stateSha = await github.commitSnapshot(request),
  } });
  try {
    const state = await store.load();
    const call = state.budget?.calls?.find(({ id }) => id === callId);
    const before = state.budget?.provider;
    if (!state.budget || !call || state.budget.pauseReason !== 'unknown-cost' ||
        call.startedAt !== '2026-11-01T06:16:05.854Z' || call.model !== 'openai/gpt-4.1-mini' ||
        call.status !== 'unknown' || call.costUsd !== null || call.costComplete !== false ||
        call.inputTokens !== null || call.outputTokens !== null || call.responseId !== undefined || call.accountingReconciliation !== undefined ||
        state.budget.calls!.filter(({ id }) => id === callId).length !== 1 ||
        state.budget.calls!.some((other) => other.id !== callId && (other.status !== 'complete' || other.costComplete !== true || other.costUsd === null)) ||
        before?.checkedAt !== '2026-11-01T06:16:05.726Z' || before.usageMonthlyUsd !== 0 || before.remainingUsd !== 1) {
      report({ outcome: 'refused', reason: 'state-mismatch' }, 1);
      return;
    }
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      report({ outcome: 'refused', reason: 'provider-http', httpStatus: response.status }, 1);
      return;
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > 64_000) {
      report({ outcome: 'refused', reason: 'provider-mismatch' }, 1);
      return;
    }
    const data: unknown = JSON.parse(raw).data;
    const expectedProvider = {
      usage: costUsd, usage_daily: costUsd, usage_weekly: costUsd, usage_monthly: costUsd,
      byok_usage: 0, byok_usage_daily: 0, byok_usage_weekly: 0, byok_usage_monthly: 0,
      limit: 1, limit_remaining: 0.9999841,
    };
    const metadata = data as Record<string, unknown> | null;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.is_management_key === true || metadata.is_provisioning_key === true ||
        Object.entries(expectedProvider).some(([field, value]) => !Object.hasOwn(metadata, field) || metadata[field] !== value)) {
      report({ outcome: 'refused', reason: 'provider-mismatch' }, 1);
      return;
    }
    const recheckedAt = new Date().toISOString();
    if (recheckedAt.slice(0, 10) !== reconciledAt.slice(0, 10)) {
      report({ outcome: 'refused', reason: 'date-mismatch' }, 1);
      return;
    }
    call.status = 'complete';
    call.costUsd = costUsd;
    call.costComplete = true;
    call.accountingReconciliation = {
      method: 'operator-confirmed-exclusive-key-delta', reconciledAt: recheckedAt,
      originalStatus: 'unknown', originalCostUsd: null, exclusiveKeyUseConfirmed: true,
      beforeCheckedAt: '2026-11-01T06:16:05.726Z', beforeUsageMonthlyUsd: 0,
      sourceQueryRunId: '41283594068', sourceQueryCheckedAt: '2026-11-01T07:08:53.764Z', afterUsageMonthlyUsd: costUsd,
    };
    if (state.budget.pauseReason === 'unknown-cost' && state.budget.calls!.every(({ status }) => status === 'complete')) state.budget.pauseReason = null;
    await store.save(state);
    report({ outcome: 'reconciled', callId, costUsd, stateSha });
  } finally { store.close(); }
}

try { await main(); }
catch (error) {
  // Never copy provider data, credentials or arbitrary error strings into logs.
  report({ outcome: 'failed', ...(error instanceof GitHubStateError ? { stateError: error.code } : {}) }, 1);
}
