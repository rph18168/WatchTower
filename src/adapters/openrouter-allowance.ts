/** Ordinary inference-key metadata only; never uses a management endpoint. */
export function createAllowanceReader(options: { apiKey: string; fetch?: typeof fetch }) {
  return async (): Promise<{ remainingUsd: number | null; usageMonthlyUsd: number }> => {
    try {
      const response = await (options.fetch ?? fetch)(new Request('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      }));
      if (!response.ok) throw new Error('Metadata request failed');
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 64_000) throw new Error('Oversized provider metadata');
      const { data } = JSON.parse(raw);
      if (!data || data.is_management_key === true || !amount(data.usage_monthly)) throw new Error('Unavailable provider metadata');
      const remaining: number[] = [];
      if (data.limit !== null) {
        if (!amount(data.limit) || !finite(data.limit_remaining)) throw new Error('Unavailable key limit');
        remaining.push(data.limit_remaining);
      }
      if (data.effective_budget != null) {
        if (!finite(data.effective_budget.remaining_usd)) throw new Error('Unavailable effective budget');
        remaining.push(data.effective_budget.remaining_usd);
      }
      if (data.budgets !== undefined) {
        if (!Array.isArray(data.budgets)) throw new Error('Unavailable provider budgets');
        for (const budget of data.budgets) {
          if (!finite(budget?.remaining_usd)) throw new Error('Unavailable provider budget');
          remaining.push(budget.remaining_usd);
        }
      }
      return { remainingUsd: remaining.length ? Math.min(...remaining) : null, usageMonthlyUsd: data.usage_monthly };
    } catch {
      throw new Error('OpenRouter allowance metadata is unavailable');
    }
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function amount(value: unknown): value is number {
  return finite(value) && value >= 0;
}
