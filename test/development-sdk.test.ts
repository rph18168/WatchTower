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
      loadConfig: async () => ({ model: 'test/generic', topics: [{ id: 'mobility', description: '改善城市公共出行的服务变化' }] }), state,
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
