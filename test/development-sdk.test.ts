import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenRouterAdapter, runCycle } from '../src/index.ts';
import { createEstablishedStateStore as createSqliteStateStore } from './support/state.ts';

test('真实 Agent SDK 使用同一个通用契约识别并核实非计算机主题的重大动态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-verification-sdk-'));
  const state = await createSqliteStateStore(join(directory, 'state.sqlite'));
  const inputs: Record<string, unknown>[] = [];
  const change = '公共自行车计划新增全年服务。';
  const whyItMatters = '本地居民在冬季也能使用公共自行车。';
  const quote = 'Our public bicycle service will operate throughout the year starting today.';
  const sourceText = quote + '城市交通公开资料。'.repeat(1300);
  const fetcher: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 100, limit_remaining: 100, usage_monthly: 0 } });
    const outbound = await input.text();
    assert.ok(Buffer.byteLength(outbound, 'utf8') <= 64_000, 'the full guarded SDK request must fit the default input limit');
    const body = JSON.parse(outbound);
    inputs.push(body);
    const data = inputs.length === 1
      ? { decisions: [{ candidateId: '402', topicIds: ['mobility'], summary: '公共自行车服务扩展为全年运营，可改善冬季出行选择。', significance: { change, whyItMatters } }] }
      : { supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: change, sourceId: 'source:402', quote }] };
    const response = {
      id: `generation-${inputs.length}`, object: 'response', model: 'test/generic', created_at: 1793494800, completed_at: 1793494801,
      error: null, incomplete_details: null, instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
      temperature: null, top_p: null, parallel_tool_calls: false, status: 'completed', tool_choice: 'none', tools: [],
      output: [{ id: `message-${inputs.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.002 },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await runCycle({
      loadConfig: async () => ({ model: 'test/generic', verificationReasoningEffort: 'low', topics: [{ id: 'mobility', description: '改善城市公共出行的服务变化' }] }), state,
      hn: { discover: async () => [{ id: '402', title: 'Public bicycle service becomes year round', url: 'https://city.example/bicycles', hnUrl: 'https://news.ycombinator.com/item?id=402', score: 28, publishedAt: '2026-11-01T00:00:00.000Z' }] },
      model: createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: fetcher }),
      sources: { read: async ({ candidateId, url }) => ({ id: `source:${candidateId}`, candidateId, originalUrl: url, finalUrl: url, title: 'Bicycle service', text: sourceText, status: 'read', truncated: false }) },
      telegram: { send: async () => ({ status: 'sent', messageId: '54' }) }, clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    assert.equal(result.notifications[0]?.status, 'sent');
    assert.equal(inputs.length, 2);
    assert.equal(result.usage?.costUsd, 0.004);
    assert.match(String(inputs[1]?.instructions), /不可信/);
    assert.match(String(inputs[1]?.instructions), /一手|官方/);
    assert.equal(JSON.parse(String(inputs[1]?.input)).source.text, sourceText);
    assert.equal(inputs[1]?.tools, undefined);
    assert.deepEqual(inputs[1]?.reasoning, { effort: 'low' });
    assert.equal(inputs[1]?.max_output_tokens, 4096);
    assert.deepEqual(inputs[1]?.provider, { require_parameters: true });
    assert.equal(inputs[0]?.reasoning, undefined);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('不完整核实保留实际收费与待核实状态，受限推理的下一周期完成核实且重启不重复通知', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-verification-recovery-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const change = '公共自行车计划新增全年服务。';
  const whyItMatters = '居民冬季也能使用公共自行车。';
  const quote = 'Public bicycles now operate throughout the year.';
  const story = { id: '407', title: 'Year-round bicycles', url: 'https://city.example/bicycles',
    hnUrl: 'https://news.ycombinator.com/item?id=407', score: 30, publishedAt: '2026-11-01T00:00:00.000Z' };
  const config = { model: 'test/generic', verificationReasoningEffort: 'low' as const, topics: [{ id: 'mobility', description: '公共出行服务变化' }] };
  const requests: Record<string, unknown>[] = [];
  let incomplete = true;
  let sends = 0;
  const model = createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 100, limit_remaining: 100, usage_monthly: 0 } });
    const body = JSON.parse(await input.text());
    requests.push(body);
    const verifying = body.text.format.name === 'watchtower_development';
    const truncated = verifying && incomplete;
    const data = verifying
      ? { supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: change, sourceId: 'source:407', quote }] }
      : { decisions: [{ candidateId: story.id, topicIds: ['mobility'], summary: change, significance: { change, whyItMatters } }] };
    const response = {
      id: `gen-1793494800-verification${requests.length}`, object: 'response', model: 'test/generic', created_at: 1793494800, completed_at: 1793494801,
      error: null, incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
      instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
      temperature: null, top_p: null, parallel_tool_calls: false, status: truncated ? 'incomplete' : 'completed', tool_choice: 'none', tools: [],
      // Even valid JSON from an incomplete response must not authorize a notification.
      output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      usage: { input_tokens: 611, output_tokens: truncated ? 4096 : 100, total_tokens: truncated ? 4707 : 711,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: truncated ? 4099 : 50 }, cost: 0.002 },
    };
    const type = truncated ? 'response.incomplete' : 'response.completed';
    return new Response(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 0, response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const sources = { read: async () => ({ id: 'source:407', candidateId: story.id, originalUrl: story.url,
    finalUrl: story.url, title: story.title, text: quote, status: 'read' as const, truncated: false }) };
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: String(++sends) }) };
  const clock = () => new Date('2026-11-01T01:00:00.000Z');
  try {
    await assert.rejects(runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [story] }, model, sources, telegram, clock }), { name: 'StructuredModelError' });
    const failed = await state.load();
    assert.equal(sends, 0);
    assert.equal(failed.notifications.length, 0);
    assert.equal(failed.candidates[0]?.notificationReview?.status, 'pending');
    assert.equal(failed.candidates[0]?.notificationReview?.verification, undefined);
    const call = failed.budget?.calls?.[1];
    assert.equal(call?.status, 'complete');
    assert.equal(call?.costUsd, 0.002);
    assert.equal(call?.outputTokens, 4096);
    assert.deepEqual(call?.diagnostic, { stage: 'response', errorClass: 'ResponseError', httpStatus: 200, generationId: 'gen-1793494800-verification2' });
    state.close(); state = await createSqliteStateStore(path);
    incomplete = false;
    const recovered = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model, sources, telegram, clock });
    assert.equal(recovered.notifications[0]?.status, 'sent');
    assert.equal(sends, 1);
    assert.equal(recovered.status.budget.spentUsd, 0.006);
    assert.deepEqual((await state.load()).budget?.calls?.[1], call);
    state.close(); state = await createSqliteStateStore(path);
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [] }, model, sources, telegram, clock });
    assert.equal(sends, 1);
    assert.equal(requests.length, 3);
    for (const request of requests.slice(1)) {
      assert.deepEqual(request.reasoning, { effort: 'low' });
      assert.equal(request.max_output_tokens, 4096);
    }
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实 SDK 的动态身份比较与摘要、来源核实共用预算和实际费用回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-development-identity-sdk-'));
  const path = join(directory, 'state.sqlite');
  let state = await createSqliteStateStore(path);
  const operationNames: string[] = [];
  const change = '公共自行车计划新增全年服务。';
  const whyItMatters = '居民冬季也能使用公共自行车。';
  const quote = 'Our public bicycle service will operate throughout the year starting today.';
  const fetcher: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith('/key')) return Response.json({ data: { limit: 100, limit_remaining: 100, usage_monthly: 0 } });
    const outbound = await input.text();
    const body = JSON.parse(outbound);
    assert.equal(body.reasoning, undefined, 'omitted configuration must preserve the provider default for every operation');
    const request = JSON.parse(String(body.input));
    const name = body.text.format.name;
    operationNames.push(name);
    assert.ok(Buffer.byteLength(outbound, 'utf8') <= 64_000);
    let data: unknown;
    if (name === 'watchtower_digest') {
      data = { decisions: [{ candidateId: request.candidates[0].id, topicIds: ['mobility'], summary: change, significance: { change, whyItMatters } }] };
    } else if (name === 'watchtower_development') {
      data = { supported: true, change, whyItMatters, uncertainty: null, sourceRole: 'primary', claims: [{ statement: change, sourceId: request.source.id, quote }] };
    } else {
      assert.equal(name, 'watchtower_development_identity');
      assert.equal(request.knownDevelopments.length, 1);
      assert.equal(request.verifiedChange, change);
      assert.match(String(body.instructions), /不可信/);
      data = { developmentId: request.knownDevelopments[0].developmentId, revisionId: request.knownDevelopments[0].revisionId, relation: 'duplicate' };
    }
    const response = {
      id: `identity-generation-${operationNames.length}`, object: 'response', model: 'test/generic', created_at: 1793494800, completed_at: 1793494801,
      error: null, incomplete_details: null, instructions: null, metadata: null, frequency_penalty: null, presence_penalty: null,
      temperature: null, top_p: null, parallel_tool_calls: false, status: 'completed', tool_choice: 'none', tools: [],
      output: [{ id: `identity-message-${operationNames.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, cost: 0.002 },
    };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const model = createOpenRouterAdapter({ apiKey: 'test-only-key', fetch: fetcher });
  const config = { model: 'test/generic', topics: [{ id: 'mobility', description: '公共出行服务变化' }] };
  const stories = [
    { id: '405', title: 'Bicycle service becomes year round', url: 'https://city.example/bicycles', hnUrl: 'https://news.ycombinator.com/item?id=405', score: 30, publishedAt: '2026-11-01T00:00:00.000Z' },
    { id: '406', title: 'Winter bicycle service', url: 'https://transport.example/bicycles', hnUrl: 'https://news.ycombinator.com/item?id=406', score: 40, publishedAt: '2026-11-01T00:15:00.000Z' },
  ];
  const sources = { read: async ({ candidateId, url }: { candidateId: string; url: string }) => ({ id: `source:${candidateId}`, candidateId, originalUrl: url, finalUrl: url, title: 'Bicycle service', text: quote, status: 'read' as const, truncated: false }) };
  let sends = 0;
  const telegram = { send: async () => ({ status: 'sent' as const, messageId: `${++sends}` }) };
  try {
    await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [stories[0]!] }, model, sources, telegram, clock: () => new Date('2026-11-01T01:00:00.000Z') });
    state.close();
    state = await createSqliteStateStore(path);
    const result = await runCycle({ loadConfig: async () => config, state, hn: { discover: async () => [stories[1]!] }, model, sources, telegram, clock: () => new Date('2026-11-01T01:15:00.000Z') });
    assert.deepEqual(operationNames, ['watchtower_digest', 'watchtower_development', 'watchtower_digest', 'watchtower_development', 'watchtower_development_identity']);
    assert.equal(sends, 1);
    assert.equal(result.digest.length, 1);
    assert.equal(result.usage?.costUsd, 0.006);
    assert.equal(result.status.budget.spentUsd, 0.01);
    assert.equal(result.status.budget.steps, 3);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
