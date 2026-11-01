import { randomUUID } from 'node:crypto';
import { modelUsageLimits } from './config.ts';
import { safeModelDiagnostic } from './model-diagnostics.ts';
import type { BudgetPauseReason, DigestModelAdapter, ModelBudgetStatus, ModelCallReceipt, ModelCallRecord, ModelExecution, ModelUsage, MonitoringState, StateStore, WatchTowerConfig } from './types.ts';

export class BudgetAdmissionError extends Error {
  readonly reason: BudgetPauseReason;
  constructor(reason: BudgetPauseReason) {
    super(`Model request paused: ${reason}`);
    this.name = 'BudgetAdmissionError';
    this.reason = reason;
  }
}

/** One gate shared by digest, source verification and every actual dispatch. */
export function createModelBudget(options: { state: MonitoringState; store: StateStore; config: WatchTowerConfig; model: DigestModelAdapter; clock: () => Date }) {
  const { state, store, config } = options;
  const limits = modelUsageLimits(config);
  const ledger = state.budget ??= { pauseReason: null };
  const calls = ledger.calls ??= [];
  const runCallIds = new Set<string>();
  let runSpentUsd = 0;
  let steps = 0;
  let providerFloor: number | null = null;
  let providerMonth: string | null = null;

  function requestSizeReason(inputBytes: number, maxOutputTokens: number): BudgetPauseReason | null {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > limits.maxInputBytes) return 'input-size';
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > limits.maxOutputTokens) return 'output-size';
    return null;
  }

  function applicationPauseReason(remainingUsd: number): BudgetPauseReason | null {
    if (remainingUsd <= 0) return 'monthly-budget';
    if (runSpentUsd >= limits.runBudgetUsd) return 'run-budget';
    if (steps >= limits.maxSteps) return 'steps';
    return null;
  }

  async function admit(inputBytes: number, maxOutputTokens: number): Promise<boolean> {
    const now = options.clock().toISOString();
    const status = modelBudgetStatus(state, config, now);
    ledger.pauseReason = calls.some(({ status }) => status !== 'complete') ? 'unknown-cost'
      : applicationPauseReason(status.remainingUsd) ?? requestSizeReason(inputBytes, maxOutputTokens);
    if (ledger.pauseReason) return false;
    try {
      const allowance = await options.model.getAllowance?.();
      if (!allowance || !amount(allowance.usageMonthlyUsd) || !(allowance.remainingUsd === null || finite(allowance.remainingUsd))) {
        throw new Error('Unavailable provider allowance');
      }
      if (providerMonth !== now.slice(0, 7)) {
        providerMonth = now.slice(0, 7);
        providerFloor = null;
      }
      if (allowance.remainingUsd !== null) providerFloor = Math.min(providerFloor ?? Infinity, allowance.remainingUsd);
      ledger.provider = { checkedAt: now, usageMonthlyUsd: allowance.usageMonthlyUsd, remainingUsd: providerFloor };
      if (providerFloor !== null && providerFloor <= 0) {
        ledger.pauseReason = 'provider-limit';
        return false;
      }
      return true;
    } catch {
      ledger.pauseReason = 'provider-unavailable';
      return false;
    }
  }

  async function reserve(): Promise<ModelCallRecord> {
    const call: ModelCallRecord = {
      id: randomUUID(), startedAt: options.clock().toISOString(), status: 'in-flight',
      model: config.model,
      costUsd: null, inputTokens: null, outputTokens: null, costComplete: false,
    };
    calls.push(call);
    runCallIds.add(call.id);
    steps += 1;
    // Survives runner interruption: an unfinished reservation is unknown cost.
    await store.save(state);
    return call;
  }

  return {
    /** Free allowance refresh for operational reporting; never reserves a call. */
    async refreshAllowance(): Promise<void> {
      await admit(0, limits.maxOutputTokens);
    },
    status: (): ModelBudgetStatus => {
      const status = modelBudgetStatus(state, config, options.clock().toISOString(), { runSpentUsd, steps });
      ledger.pauseReason = status.pauseReason === 'unknown-cost' ? 'unknown-cost'
        : applicationPauseReason(status.remainingUsd) ?? (providerFloor !== null && providerFloor <= 0 ? 'provider-limit'
          : ['monthly-budget', 'run-budget', 'steps'].includes(ledger.pauseReason ?? '') ? null : ledger.pauseReason);
      return { ...status, pauseReason: ledger.pauseReason };
    },
    usage: (): ModelUsage | null => {
      const receipts = calls.filter(({ id }) => runCallIds.has(id));
      if (!receipts.length) return null;
      return {
        costUsd: receipts.some(({ costUsd }) => costUsd !== null) ? receipts.reduce((sum, { costUsd }) => sum + (costUsd ?? 0), 0) : null,
        inputTokens: receipts.every(({ inputTokens }) => inputTokens !== null) ? receipts.reduce((sum, { inputTokens }) => sum + inputTokens!, 0) : null,
        outputTokens: receipts.every(({ outputTokens }) => outputTokens !== null) ? receipts.reduce((sum, { outputTokens }) => sum + outputTokens!, 0) : null,
        costComplete: receipts.every(({ status }) => status === 'complete'),
      };
    },
    async execute<T extends { usage: ModelUsage }>(input: unknown, operation: (execution: ModelExecution) => Promise<T>): Promise<T | null> {
      if (!await admit(Buffer.byteLength(JSON.stringify(input), 'utf8'), limits.maxOutputTokens)) return null;
      let operationRecordedCost = 0;
      let receipts = 0;
      let active = await reserve();
      let firstRequest = true;
      const settle = async (usage?: ModelCallReceipt) => {
        if (active.status !== 'in-flight') throw new Error('Duplicate or unmatched model accounting receipt');
        const costUsd = amount(usage?.costUsd) ? usage.costUsd : null;
        const costComplete = costUsd !== null && usage?.costComplete === true;
        receipts += 1;
        runSpentUsd += costUsd ?? 0;
        operationRecordedCost += costUsd ?? 0;
        if (providerFloor !== null) providerFloor -= costUsd ?? 0;
        Object.assign(active, {
          status: costComplete ? 'complete' : 'unknown', costUsd, costComplete,
          inputTokens: amount(usage?.inputTokens) ? usage.inputTokens : null,
          outputTokens: amount(usage?.outputTokens) ? usage.outputTokens : null,
        });
        if (typeof usage?.responseId === 'string' && /^[\w.:-]{1,200}$/.test(usage.responseId)) active.responseId = usage.responseId;
        if (typeof usage?.model === 'string' && /^[\w./:-]{1,200}$/.test(usage.model)) active.model = usage.model;
        const diagnostic = safeModelDiagnostic(usage?.diagnostic);
        if (diagnostic) active.diagnostic = diagnostic;
        if (!costComplete) ledger.pauseReason = 'unknown-cost';
        if (ledger.provider) ledger.provider.remainingUsd = providerFloor;
        await store.save(state);
      };
      const outstandingUsage = (usage?: ModelUsage): ModelUsage | undefined => {
        if (!usage || receipts === 0) return usage;
        const alreadyRecorded = operationRecordedCost;
        const aggregateValid = amount(usage.costUsd) && usage.costUsd >= alreadyRecorded;
        return {
          costUsd: aggregateValid ? usage.costUsd! - alreadyRecorded : null,
          inputTokens: null, outputTokens: null,
          costComplete: aggregateValid && usage.costComplete === true,
        };
      };
      const execution: ModelExecution = {
        maxOutputTokens: limits.maxOutputTokens,
        beforeRequest: async ({ inputBytes, maxOutputTokens }) => {
          if (firstRequest) {
            firstRequest = false;
            const reason = requestSizeReason(inputBytes, maxOutputTokens);
            if (reason) {
              // The transport confirms nothing was dispatched. Release only
              // this reservation, retaining every previous usage receipt.
              calls.splice(calls.indexOf(active), 1);
              steps -= 1;
              ledger.pauseReason = reason;
              await store.save(state);
              throw new BudgetAdmissionError(reason);
            }
            return;
          }
          if (active.status === 'in-flight') await settle();
          if (!await admit(inputBytes, maxOutputTokens)) throw new BudgetAdmissionError(ledger.pauseReason!);
          active = await reserve();
        },
        recordUsage: settle,
      };
      try {
        const result = await operation(execution);
        if (active.status === 'in-flight') await settle(outstandingUsage(result.usage));
        return result;
      } catch (error) {
        if (error instanceof BudgetAdmissionError) {
          await store.save(state);
          return null;
        }
        const diagnostic = safeModelDiagnostic(error && typeof error === 'object' && 'diagnostic' in error ? error.diagnostic : undefined);
        if (diagnostic) active.diagnostic = diagnostic;
        if (active.status === 'in-flight') await settle(outstandingUsage(error && typeof error === 'object' && 'usage' in error ? error.usage as ModelUsage : undefined));
        else if (diagnostic) await store.save(state);
        if (error && typeof error === 'object' && 'code' in error && error.code === 'provider-limit') {
          ledger.pauseReason = 'provider-limit';
          await store.save(state);
          return null;
        }
        throw error;
      }
    },
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function amount(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function modelBudgetStatus(state: MonitoringState, config: WatchTowerConfig, now: string, run = { runSpentUsd: 0, steps: 0 }): ModelBudgetStatus {
  const spentUsd = (state.budget?.calls ?? [])
    .filter(({ startedAt }) => startedAt.slice(0, 7) === now.slice(0, 7))
    .reduce((total, { costUsd }) => total + (costUsd ?? 0), 0);
  const monthlyBudgetUsd = modelUsageLimits(config).monthlyBudgetUsd;
  return {
    month: now.slice(0, 7), monthlyBudgetUsd,
    spentUsd, remainingUsd: Math.max(0, monthlyBudgetUsd - spentUsd),
    ...run,
    pauseReason: state.budget?.calls?.some(({ status }) => status !== 'complete') ? 'unknown-cost' : state.budget?.pauseReason ?? null,
  };
}
