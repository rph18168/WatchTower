import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/openrouter-accounting-check.mjs', import.meta.url));

/** A process-level external protocol boundary: fake key, no forwarding path. */
function runCheck(directory: string, responseCode: string) {
  const preload = `let requests = 0; globalThis.fetch = async (url, options) => {
    if (++requests !== 1 || url !== 'https://openrouter.ai/api/v1/key' || options?.method !== 'GET' || options.redirect !== 'error' || !(options.signal instanceof AbortSignal) || options.body !== undefined || new Headers(options.headers).get('authorization') !== 'Bearer PRIVATE_KEY_FIXTURE') throw new Error('PRIVATE_REFUSED_UNEXPECTED_HTTP');
    ${responseCode}
  };`;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, script], {
    cwd: directory, env: { OPENROUTER_API_KEY: 'PRIVATE_KEY_FIXTURE' }, encoding: 'utf8', timeout: 15_000,
  });
}

test('只读账务 CLI 仅 GET 固定端点，输出包括 BYOK 的数值白名单并明确缺失字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-accounting-'));
  try {
    const result = runCheck(directory, `return Response.json({ data: { usage: 0.25, usage_daily: 0.02, usage_monthly: 0, byok_usage: 1.5, byok_usage_daily: 0.5, limit: 1, limit_remaining: 0.7, label: 'PRIVATE_LABEL', hash: 'PRIVATE_HASH', creator_user_id: 'PRIVATE_IDENTITY' } });`);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.checkedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(output.outcome, 'ok');
    assert.equal(output.values.usage_monthly, 0);
    assert.equal(output.values.byok_usage, 1.5);
    assert.equal(output.values.byok_usage_daily, 0.5);
    assert.equal(output.values.byok_usage_monthly, null);
    assert.ok(output.missing.includes('byok_usage_monthly'));
    assert.equal(output.values.limit_remaining, 0.7);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('只读查询的 HTTP、解析和 fetch 错误只输出固定类别，不泄露响应或错误字符串', async (t) => {
  const scenarios = [
    { name: 'http', code: `return Response.json({ error: { message: 'PRIVATE_RESPONSE_BODY' } }, { status: 401 });`, outcome: 'http-error', status: 401 },
    { name: 'parse', code: `return new Response('PRIVATE_INVALID_JSON');`, outcome: 'invalid-response', status: 200 },
    { name: 'fetch', code: `const error = new Error('PRIVATE_ERROR_MESSAGE'); error.name='PRIVATE_ERROR_NAME'; throw error;`, outcome: 'transport-error', status: undefined },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-accounting-error-'));
    try {
      const result = runCheck(directory, scenario.code);
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.outcome, scenario.outcome);
      assert.equal(output.httpStatus, scenario.status);
      assert.deepEqual(Object.keys(output).sort(), ['checkedAt', 'outcome', ...(scenario.status === undefined ? [] : ['httpStatus'])].sort());
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
      assert.deepEqual(await readdir(directory), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
