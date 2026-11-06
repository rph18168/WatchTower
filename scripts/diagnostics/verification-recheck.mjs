import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenRouterAdapter, createSourceReader, createSqliteStateStore } from '../../src/index.ts';
import { createModelBudget } from '../../src/budget.ts';

// A single isolated verification of the existing public candidate. Never writes
// a remote state ref, invokes Telegram, or retries a model request.
const stateSha = 'deb46641ce0de5c147771050c4e77d26fd66b269';
const expectedStateHash = '23b34c11e343e9450e7a7489bbbcd9cd08e2b7fef3576c60834119182579ed71';
const candidateId = '50370654';
const expectedSourceHash = 'sha256:v1:b12527574bf65094a1bf8b9b404cd6b1d9882ec00ecfb26927b3ba4a070d2c99';
const hash = value => createHash('sha256').update(value).digest('hex');
let stage = 'snapshot';
let store;
let state;
let budget;
let priorCallIds = new Set();
let posts = 0;
const report = { checkedAtUtc: new Date().toISOString(), originalRun: '42253142190', stateSha, candidateId,
  environment: { sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID }, verdict: 'NOT_EXECUTED' };
try {
  const response = await fetch(`https://raw.githubusercontent.com/rph18168/WatchTower/${stateSha}/state.sqlite`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 585728);
  assert.equal(hash(bytes), expectedStateHash);
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-verification-recheck-'));
  const path = join(directory, 'state.sqlite');
  await writeFile(path, bytes);
  store = createSqliteStateStore(path);
  state = await store.load();
  priorCallIds = new Set(state.budget.calls.map(call => call.id));
  assert.ok(state.budget.calls.every(call => call.status === 'complete' && call.costComplete));
  const config = JSON.parse(await readFile('watchtower.config.json', 'utf8'));
  assert.equal(config.model, 'z-ai/glm-5.3-flash');
  assert.equal(config.verificationReasoningEffort, 'low');
  assert.equal(config.usage.maxOutputTokens, 4096);
  config.usage.maxSteps = 1;
  const candidate = state.candidates.find(value => value.story.id === candidateId);
  assert.equal(candidate.notificationReview.status, 'pending');
  stage = 'source';
  const source = await createSourceReader().read({ candidateId, url: candidate.story.url });
  report.source = { status: source.status, truncated: source.truncated, failureCode: source.failureCode ?? null,
    contentHash: `sha256:v1:${hash(source.text)}` };
  assert.equal(source.status, 'read');
  assert.equal(source.truncated, false);
  assert.equal(report.source.contentHash, expectedSourceHash);
  assert.equal(source.title, candidate.notificationReview.source.title);
  assert.equal(source.finalUrl, candidate.notificationReview.source.finalUrl);
  const model = createOpenRouterAdapter({ apiKey: process.env.OPENROUTER_API_KEY ?? '', fetch: async request => {
    assert.ok(request instanceof Request);
    if (request.method === 'GET') assert.equal(request.url, 'https://openrouter.ai/api/v1/key');
    else {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, 'https://openrouter.ai/api/v1/responses');
      assert.equal(++posts, 1);
      const body = JSON.parse(await request.clone().text());
      assert.equal(body.model, config.model);
      assert.equal(body.text.format.name, 'watchtower_development');
      assert.equal(body.max_output_tokens, 4096);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.deepEqual(body.provider, { require_parameters: true });
      assert.equal(body.store, false);
      report.request = { operation: body.text.format.name, model: body.model, reasoning: body.reasoning,
        maxOutputTokens: body.max_output_tokens, inputHash: hash(body.input) };
    }
    return fetch(request);
  } });
  budget = createModelBudget({ state, store, config, model, clock: () => new Date() });
  const { id, title, url, hnUrl, score, publishedAt } = candidate.story;
  const input = { model: config.model, topics: config.topics, candidate: { id, title, url, hnUrl, score, publishedAt },
    proposal: candidate.notificationReview.proposal, source, reasoningEffort: config.verificationReasoningEffort };
  stage = 'verification';
  const result = await budget.execute(input, execution => model.verifyDevelopment({ ...input, execution }));
  assert.ok(result);
  report.verdict = 'VERIFICATION_COMPLETED';
  report.verification = { supported: result.verification.supported, sourceRole: result.verification.sourceRole,
    claims: result.verification.claims.length, hasUncertainty: result.verification.uncertainty !== null };
} catch (error) {
  report.verdict = 'RECHECK_FAILED';
  report.failedStage = stage;
  report.errorClass = ['AssertionError', 'StructuredModelError', 'DevelopmentModelError', 'TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)
    ? error.name : 'UnknownError';
  process.exitCode = 1;
} finally {
  report.posts = posts;
  report.budget = budget?.status();
  report.newCalls = state?.budget?.calls?.filter(call => !priorCallIds.has(call.id)).map(call => ({
    id: call.id, startedAt: call.startedAt, status: call.status, responseId: call.responseId,
    costUsd: call.costUsd, costComplete: call.costComplete, inputTokens: call.inputTokens,
    outputTokens: call.outputTokens, diagnostic: call.diagnostic,
  })) ?? [];
  if (report.newCalls.some(call => call.status !== 'complete' || !call.costComplete)) process.exitCode = 1;
  console.log('[DEBUG-verification-response] ' + JSON.stringify(report));
  store?.close();
}
