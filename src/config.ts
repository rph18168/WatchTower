import { readFile } from 'node:fs/promises';
import type { ModelUsageLimits, WatchTowerConfig } from './types.ts';

export function modelUsageLimits(config: WatchTowerConfig): ModelUsageLimits {
  if (config.usage !== undefined && (!config.usage || typeof config.usage !== 'object' || Array.isArray(config.usage))) {
    throw new Error('Invalid model usage limits');
  }
  const limits = {
    monthlyBudgetUsd: 10, runBudgetUsd: 0.25, maxSteps: 6,
    maxInputBytes: 64_000, maxOutputTokens: 4096,
    ...config.usage,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (!name.endsWith('Usd') && (!Number.isSafeInteger(value) || name !== 'maxSteps' && value === 0))) {
      throw new Error('Invalid model usage limits');
    }
  }
  return limits;
}

/** Called for each run; persisted runtime state never supplies configuration. */
export async function readConfigFile(path: string): Promise<WatchTowerConfig> {
  return JSON.parse(await readFile(path, 'utf8'));
}
