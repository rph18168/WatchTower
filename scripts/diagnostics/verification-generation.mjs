// Temporary read-only probe for the two calls in production run 42253142190.
const ids = ['gen-1793982699-sHM8bG64iDYAUKNHGpcu', 'gen-1793982710-6o6oy3sXG9Gkn1iVeQms'];
const key = process.env.OPENROUTER_API_KEY;
if (!key?.trim()) {
  console.error('[DEBUG-verification-response] missing credential');
  process.exit(2);
}
const numberFields = ['tokens_prompt', 'tokens_completion', 'native_tokens_prompt', 'native_tokens_completion',
  'native_tokens_reasoning', 'total_cost', 'latency', 'generation_time'];
const reasonValues = new Set(['stop', 'length', 'max_tokens', 'max_output_tokens', 'tool_calls', 'function_call',
  'content_filter', 'error', 'cancelled', 'end_turn', 'eos_token', 'stop_sequence']);
const results = [];
for (const id of ids) {
  let stage = 'request';
  let httpStatus = null;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${id}`, {
      method: 'GET', headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    httpStatus = response.status;
    if (!response.ok) {
      results.push({ id, httpStatus: response.status });
      process.exitCode = 1;
      await response.body?.cancel();
      continue;
    }
    stage = 'decode';
    const envelope = await response.json();
    const data = envelope.data;
    stage = 'identity';
    if (data?.id !== id) {
      results.push({ id, httpStatus, error: 'unexpected-receipt-identity',
        returnedId: typeof data?.id === 'string' && /^gen-\d{10,16}-[A-Za-z0-9]{8,128}$/.test(data.id) ? data.id : null,
        hasData: Boolean(data && typeof data === 'object') });
      process.exitCode = 1;
      continue;
    }
    const receipt = { id, httpStatus: response.status,
      model: typeof data.model === 'string' && /^[\w./:+-]{1,120}$/.test(data.model) ? data.model : null,
      cancelled: typeof data.cancelled === 'boolean' ? data.cancelled : null,
      finish_reason: reasonValues.has(data.finish_reason) ? data.finish_reason : data.finish_reason == null ? null : 'unrecognized',
      native_finish_reason: reasonValues.has(data.native_finish_reason) ? data.native_finish_reason : data.native_finish_reason == null ? null : 'unrecognized',
    };
    for (const name of numberFields) receipt[name] = typeof data[name] === 'number' && Number.isFinite(data[name]) ? data[name] : null;
    results.push(receipt);
  } catch (error) {
    results.push({ id, httpStatus, stage, error: 'metadata-query-failed',
      errorClass: ['TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'UnknownError' });
    process.exitCode = 1;
  }
}
console.log('[DEBUG-verification-response] ' + JSON.stringify({ checkedAtUtc: new Date().toISOString(),
  environment: { actions: process.env.GITHUB_ACTIONS === 'true', node: process.version,
    sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID }, results }));
