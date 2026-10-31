import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, createSqliteStateStore, DigestModelError, runCycle } from '../src/index.ts';

test('完整周期通过真实 Agent SDK 协议接收通用摘要和实际 usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-openrouter-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
    if (input.url === 'https://openrouter.ai/api/v1/key') {
      assert.equal(input.method, 'GET');
      assert.equal(input.headers.get('authorization'), 'Bearer test-only-key');
      return Response.json({ data: { limit: 10, limit_remaining: 9, usage_monthly: 1 } });
    }
    assert.equal(input.url, 'https://openrouter.ai/api/v1/responses');
    const body = await input.text();
    requests.push(JSON.parse(body));
    const completed = {
      id: 'gen-test-digest', object: 'response', model: 'test/digest',
      created_at: 1793494800, completed_at: 1793494801,
      error: null, incomplete_details: null, instructions: null, metadata: null,
      frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      parallel_tool_calls: false, status: 'completed', tool_choice: 'none', tools: [],
      output: [{
        id: 'message-1', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ decisions: [{ candidateId: '201', topicIds: ['marine'], summary: '新的海洋观测档案向公众开放，可供查阅长期海水温度变化。', significance: null }] }) }],
      }],
      usage: { input_tokens: 420, output_tokens: 80, total_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.002 },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response: completed })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await runCycle({
      loadConfig: async () => ({ model: 'test/digest', topics: [{ id: 'marine', description: '海洋观测与公开科研资料' }], usage: { maxOutputTokens: 128 } }),
      state,
      hn: { discover: async () => [{ id: '201', title: 'Ocean observations archive', url: 'https://ocean.example/archive', hnUrl: 'https://news.ycombinator.com/item?id=201', text: 'Public ocean temperature observations.', score: 25, publishedAt: '2026-11-01T00:00:00.000Z' }] },
      model: createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: fetcher }),
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    assert.equal(result.digest[0]?.summary, '新的海洋观测档案向公众开放，可供查阅长期海水温度变化。');
    assert.deepEqual(result.usage, { costUsd: 0.002, inputTokens: 420, outputTokens: 80, costComplete: true });
    assert.equal(requests.length, 1);
    const sent = requests[0]!;
    assert.equal(sent.model, 'test/digest');
    assert.equal(sent.max_output_tokens, 128);
    assert.deepEqual(JSON.parse(String(sent.input)).topics, [{ id: 'marine', description: '海洋观测与公开科研资料' }]);
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.provider, { require_parameters: true });
    assert.equal((sent.text as { format: { type: string } }).format.type, 'json_schema');
    assert.match(String(sent.instructions), /不可信/);
    assert.match(String(sent.instructions), /简洁中文/);
    assert.equal((await state.load()).budget?.calls?.[0]?.responseId, 'gen-test-digest');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('普通 key 未配置 cap 时仍尊重 provider 402 拒绝，不重试也不把拒绝记录成未知收费', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-provider-reject-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  let paidRequests = 0;
  try {
    const result = await runCycle({
      loadConfig: async () => ({ model: 'test/digest', topics: [{ id: 'marine', description: '海洋观测' }] }),
      state,
      hn: { discover: async () => [{ id: '202', title: 'Observations', hnUrl: 'https://news.ycombinator.com/item?id=202', score: 30, publishedAt: '2026-11-01T00:00:00.000Z' }] },
      model: createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: async (input) => {
        assert.ok(input instanceof Request);
        if (input.url === 'https://openrouter.ai/api/v1/key') {
          return Response.json({ data: { limit: null, limit_remaining: null, usage_monthly: 0, label: 'PRIVATE_KEY_LABEL' } });
        }
        assert.equal(input.url, 'https://openrouter.ai/api/v1/responses');
        paidRequests += 1;
        return Response.json({ error: { code: 402, message: 'PRIVATE_PROVIDER_ERROR' } }, { status: 402 });
      } }),
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    assert.equal(paidRequests, 1);
    assert.equal(result.status.budget.pauseReason, 'provider-limit');
    assert.equal(result.status.budget.spentUsd, 0);
    assert.equal(result.status.pendingCandidateCount, 1);
    assert.doesNotMatch(JSON.stringify(await state.load()), /PRIVATE_/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SDK 传输失败只暴露允许的费用回执，保留未知费用并阻止后续免费重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-transport-cost-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const options = {
      loadConfig: async () => ({ model: 'test/digest', topics: [{ id: 'marine', description: '海洋观测' }] }),
      state,
      hn: { discover: async () => [{ id: '203', title: 'Observations', hnUrl: 'https://news.ycombinator.com/item?id=203', score: 30, publishedAt: '2026-11-01T00:00:00.000Z' }] },
      model: createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: async (input) => {
        assert.ok(input instanceof Request);
        if (input.url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { limit: 10, limit_remaining: 10, usage_monthly: 0 } });
        throw new Error('PRIVATE_TRANSPORT_DETAIL');
      } }),
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    };
    await assert.rejects(runCycle(options), DigestModelError);
    const later = await runCycle({ ...options, hn: { discover: async () => [] } });
    assert.equal(later.status.budget.pauseReason, 'unknown-cost');
    assert.equal(later.status.pendingCandidateCount, 1);
    assert.deepEqual(warnings, []);
    assert.doesNotMatch(JSON.stringify(await state.load()), /PRIVATE_TRANSPORT_DETAIL/);
  } finally {
    console.warn = originalWarn;
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
