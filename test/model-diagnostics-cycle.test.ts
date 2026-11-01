import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, createSqliteStateStore, DigestModelError, runCycle } from '../src/index.ts';
import type { CandidateStory } from '../src/index.ts';

const config = { model: 'test/model', topics: [{ id: 'marine', description: '公开海洋观测资料' }] };
const clock = () => new Date('2026-11-01T01:00:00.000Z');
const story = (id: string): CandidateStory => ({ id, title: `Public observations ${id}`, hnUrl: `https://news.ycombinator.com/item?id=${id}`, score: 30, publishedAt: '2026-11-01T00:00:00.000Z' });

function completed(id: string, output = JSON.stringify({ decisions: [{ candidateId: id, topicIds: ['marine'], summary: '观测档案已向公众开放。', significance: null }] })): Response {
  const response = {
    id: 'gen-1793494800-abcdefghijklmno', object: 'response', model: 'test/model', created_at: 1793494800, completed_at: 1793494801,
    error: null, incomplete_details: null, instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
    temperature: null, top_p: null, parallel_tool_calls: false, status: 'completed', tool_choice: 'none', tools: [],
    output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output }] }],
    usage: { input_tokens: 420, output_tokens: 80, total_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.002 },
  };
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('HTTP 拒绝的安全诊断随未知费用跨 SQLite 恢复，既有完整收费保留且不再派发模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-model-http-diagnostic-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let posts = 0;
  const model = createOpenRouterAdapter({ apiKey: 'PRIVATE_API_KEY_FIXTURE', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0, label: 'PRIVATE_KEY_LABEL' } });
    assert.equal(input.url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(input.method, 'POST');
    posts++;
    if (posts === 1) return completed('901');
    return Response.json({ error: { message: 'PRIVATE_PROVIDER_BODY', creator: 'PRIVATE_IDENTITY' } }, { status: 401, headers: { 'x-request-id': 'PRIVATE_UNRECOGNIZED_ID' } });
  } });
  try {
    await runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [story('901')] }, clock });
    state.close(); state = createSqliteStateStore(path);
    await assert.rejects(runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [story('902')] }, clock }), DigestModelError);
    const saved = await state.load();
    assert.deepEqual(saved.budget?.calls?.[1]?.diagnostic, { stage: 'http', errorClass: 'HttpError', httpStatus: 401 });
    assert.equal(saved.budget?.calls?.[1]?.status, 'unknown');
    assert.equal(saved.budget?.calls?.[1]?.costUsd, null);
    assert.equal(saved.budget?.calls?.[0]?.costUsd, 0.002);
    assert.equal(saved.budget?.calls?.[0]?.status, 'complete');
    state.close(); state = createSqliteStateStore(path);
    const later = await runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [] }, clock });
    assert.equal(later.status.budget.pauseReason, 'unknown-cost');
    assert.equal(later.usage, null);
    assert.equal(posts, 2);
    assert.equal(later.digest.length, 1);
    assert.doesNotMatch(JSON.stringify(await state.load()), /PRIVATE_/);
    assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE_')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fetch 异常只保留固定原生类别及 cause code，私有 name／message 不进入账本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-model-fetch-diagnostic-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let posts = 0;
  const model = createOpenRouterAdapter({ apiKey: 'PRIVATE_API_KEY', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0 } });
    posts++;
    const error = new TypeError('PRIVATE_TRANSPORT_BODY', { cause: { code: 'ECONNRESET', headers: 'PRIVATE_AUTH_HEADER' } });
    error.name = 'PRIVATE_ERROR_NAME';
    throw error;
  } });
  try {
    await assert.rejects(runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [story('903')] }, clock }), DigestModelError);
    assert.deepEqual((await state.load()).budget?.calls?.[0]?.diagnostic, { stage: 'transport', errorClass: 'TypeError', transportCode: 'ECONNRESET' });
    state.close(); state = createSqliteStateStore(path);
    const later = await runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [] }, clock });
    assert.equal(later.status.budget.pauseReason, 'unknown-cost');
    assert.equal(posts, 1);
    assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE_')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP 成功后的无效 SSE 与无响应的连接失败可区分，费用仍未知且禁止重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-model-response-diagnostic-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  let posts = 0;
  const requestId = '61ab2f09-001b-4cb2-943b-f9c789ce34e5';
  const model = createOpenRouterAdapter({ apiKey: 'PRIVATE_API_KEY', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0 } });
    posts++;
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"invalid":"PRIVATE_STREAM_BODY"}}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'x-request-id': requestId, 'Authorization': 'PRIVATE_AUTH_HEADER' },
    });
  } });
  try {
    await assert.rejects(runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [story('904')] }, clock }), DigestModelError);
    const call = (await state.load()).budget?.calls?.[0];
    assert.deepEqual(call?.diagnostic, { stage: 'response', errorClass: 'ResponseError', httpStatus: 200, requestId });
    assert.equal(call?.status, 'unknown');
    assert.equal(call?.costUsd, null);
    state.close(); state = createSqliteStateStore(path);
    const later = await runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [] }, clock });
    assert.equal(later.status.budget.pauseReason, 'unknown-cost');
    assert.equal(posts, 1);
    assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE_')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('完整收费后结构校验失败仍保存响应诊断，不抹掉已完成的费用回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-model-schema-diagnostic-'));
  const path = join(directory, 'state.sqlite');
  const state = createSqliteStateStore(path);
  const model = createOpenRouterAdapter({ apiKey: 'PRIVATE_API_KEY', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0 } });
    return completed('905', JSON.stringify({ decisions: [{ candidateId: '905', topicIds: 'PRIVATE_SCHEMA_VALUE', summary: '观测档案已开放。', significance: null }] }));
  } });
  try {
    await assert.rejects(runCycle({ loadConfig: async () => config, state, model, hn: { discover: async () => [story('905')] }, clock }), DigestModelError);
    const saved = await state.load();
    assert.deepEqual(saved.budget?.calls?.[0]?.diagnostic, { stage: 'response', errorClass: 'ValidationError', httpStatus: 200, generationId: 'gen-1793494800-abcdefghijklmno' });
    assert.equal(saved.budget?.calls?.[0]?.status, 'complete');
    assert.equal(saved.budget?.calls?.[0]?.costUsd, 0.002);
    assert.equal(saved.budget?.calls?.[0]?.inputTokens, 420);
    assert.equal(saved.budget?.calls?.[0]?.outputTokens, 80);
    assert.equal(saved.digest.length, 0);
    assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE_')), false);
  } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
});

test('402／429 的诊断不改变已有明确拒绝回执，不重试也不变成未知费用', async (t) => {
  for (const status of [402, 429]) await t.test(String(status), async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watchtower-model-refusal-diagnostic-'));
    const state = createSqliteStateStore(join(directory, 'state.sqlite'));
    let posts = 0;
    try {
      const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story(`9${status}`)] }, clock,
        model: createOpenRouterAdapter({ apiKey: 'PRIVATE_KEY', fetch: async (input) => {
          assert.ok(input instanceof Request);
          if (input.url.endsWith('/key')) return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0 } });
          posts++;
          return Response.json({ error: { message: 'PRIVATE_REFUSAL_BODY' } }, { status });
        } }),
      });
      const call = (await state.load()).budget?.calls?.[0];
      assert.deepEqual(call?.diagnostic, { stage: 'http', errorClass: 'HttpError', httpStatus: status });
      assert.equal(call?.status, 'complete');
      assert.equal(call?.costUsd, 0);
      assert.equal(call?.costComplete, true);
      assert.equal(result.status.budget.pauseReason, 'provider-limit');
      assert.equal(posts, 1);
      assert.doesNotMatch(JSON.stringify(await state.load()), /PRIVATE_/);
    } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
