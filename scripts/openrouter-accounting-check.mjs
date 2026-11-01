// Temporary T10 accounting inspection. No application/state/model imports.
const checkedAt = new Date().toISOString();
const fields = ['usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'byok_usage', 'byok_usage_daily', 'byok_usage_weekly', 'byok_usage_monthly', 'limit', 'limit_remaining'];
const report = (data, exitCode = 0) => {
  process.stdout.write(JSON.stringify({ checkedAt, ...data }) + '\n');
  process.exitCode = exitCode;
};

if (process.argv.length > 2) {
  report({ outcome: 'unexpected-arguments' }, 2);
} else if (!process.env.OPENROUTER_API_KEY?.trim()) {
  report({ outcome: 'missing-key' }, 2);
} else {
  let outcome = 'transport-error';
  let httpStatus;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    httpStatus = response.status;
    if (!response.ok) {
      outcome = 'http-error';
      await response.body?.cancel();
      report({ outcome, httpStatus }, 1);
    } else {
      outcome = 'invalid-response';
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > 64_000) throw new Error();
      const { data } = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      if (data.is_management_key === true || data.is_provisioning_key === true) {
        report({ outcome: 'unsupported-key-kind', httpStatus }, 1);
      } else {
        const values = {};
        const missing = [];
        const invalid = [];
        for (const field of fields) {
          const value = data[field];
          values[field] = typeof value === 'number' && Number.isFinite(value) ? value : null;
          if (!Object.hasOwn(data, field)) missing.push(field);
          else if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) invalid.push(field);
        }
        report({ outcome: 'ok', httpStatus, values, missing, invalid });
      }
    }
  } catch {
    // No provider body, header, label, key, identity or raw error is printed.
    report({ outcome, ...(httpStatus === undefined ? {} : { httpStatus }) }, 1);
  }
}
