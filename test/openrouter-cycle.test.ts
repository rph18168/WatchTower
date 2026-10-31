import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, createSqliteStateStore, runCycle } from '../src/index.ts';

test('完整周期通过真实 Agent SDK 协议接收通用摘要和实际 usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-openrouter-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
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
        content: [{ type: 'output_text', text: JSON.stringify({ decisions: [{ candidateId: '201', topicIds: ['marine'], summary: '新的海洋观测档案向公众开放，可供查阅长期海水温度变化。' }] }) }],
      }],
      usage: { input_tokens: 420, output_tokens: 80, total_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.002 },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response: completed })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await runCycle({
      loadConfig: async () => ({ model: 'test/digest', topics: [{ id: 'marine', description: '海洋观测与公开科研资料' }] }),
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
    assert.deepEqual(JSON.parse(String(sent.input)).topics, [{ id: 'marine', description: '海洋观测与公开科研资料' }]);
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.provider, { require_parameters: true });
    assert.equal((sent.text as { format: { type: string } }).format.type, 'json_schema');
    assert.match(String(sent.instructions), /不可信/);
    assert.match(String(sent.instructions), /简洁中文/);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
