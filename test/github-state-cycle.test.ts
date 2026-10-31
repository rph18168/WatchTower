import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitHubSnapshotAdapter, createGitHubStateStore, createSqliteStateStore, runCycle } from '../src/index.ts';
import type { CandidateStory, DigestModelAdapter, WatchTowerConfig } from '../src/index.ts';
import { githubProtocol } from './support/github.ts';

const config: WatchTowerConfig = {
  topics: [{ id: 'computing', description: '降低软件开发成本的计算技术进展' }],
  model: 'openai/gpt-4.1-mini',
};
const story: CandidateStory = {
  id: '301', title: 'A compiler reduces memory use', url: 'https://compiler.example/release',
  hnUrl: 'https://news.ycombinator.com/item?id=301', score: 40, publishedAt: '2026-11-01T00:00:00.000Z',
};
const model: DigestModelAdapter = {
  getAllowance: async () => ({ remainingUsd: 100, usageMonthlyUsd: 0 }),
  analyze: async ({ candidates }) => ({
    decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['computing'], summary: '编译器新版降低内存需求，可供开发者评估。' })),
    usage: { costUsd: 0.001, inputTokens: 100, outputTokens: 20, costComplete: true },
  }),
};

/** A controlled external GitHub snapshot service, shared across ephemeral runners. */
function githubSnapshots() {
  let snapshot: { version: string; database: Uint8Array } | null = null;
  let sequence = 0;
  return {
    async readSnapshot() {
      return snapshot && { version: snapshot.version, database: Uint8Array.from(snapshot.database) };
    },
    async commitSnapshot(request: { expectedVersion: string | null; database: Uint8Array }) {
      if (request.expectedVersion !== (snapshot?.version ?? null)) throw new Error('State version conflict');
      snapshot = { version: `commit-${++sequence}`, database: Uint8Array.from(request.database) };
      return snapshot.version;
    },
  };
}

test('两个完整周期在不同 runner 工作目录中从 GitHub SQLite 快照延续摘要和已处理进度', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-'));
  const protocol = githubProtocol();
  const github = createGitHubSnapshotAdapter({ repository: 'owner/WatchTower', token: 'test-github-token', fetch: protocol.fetch });
  const first = createGitHubStateStore({ path: join(directory, 'runner-one', 'state.sqlite'), github });
  const second = createGitHubStateStore({ path: join(directory, 'runner-two', 'state.sqlite'), github });
  try {
    const initial = await runCycle({
      loadConfig: async () => config, state: first, hn: { discover: async () => [story] }, model,
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    first.close();
    await rm(join(directory, 'runner-one'), { recursive: true, force: true });
    const recovered = await runCycle({
      loadConfig: async () => config, state: second, hn: { discover: async () => [story] },
      model: { analyze: async () => { throw new Error('已持久化的已处理候选不应再次请求模型'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.deepEqual(recovered.digest, initial.digest);
    assert.equal(recovered.digest[0]?.summary, '编译器新版降低内存需求，可供开发者评估。');
    assert.deepEqual(recovered.status, {
      manuallyPaused: false, fault: null,
      candidateCount: 1, processedCandidateCount: 1, pendingCandidateCount: 0, lastRunAt: '2026-11-01T01:15:00.000Z',
      budget: { month: '2026-11', monthlyBudgetUsd: 10, spentUsd: 0.001, remainingUsd: 9.999, runSpentUsd: 0, steps: 0, pauseReason: null },
    });
    assert.equal(recovered.markdown, initial.markdown);
  } finally {
    first.close(); second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('远端保存失败使用可诊断的安全错误，新 runner 从上次已提交候选恢复而非采用未提交摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-save-'));
  const remote = githubSnapshots();
  let failNextCommit = false;
  const github = {
    readSnapshot: remote.readSnapshot,
    async commitSnapshot(request: Parameters<typeof remote.commitSnapshot>[0]) {
      if (failNextCommit) { failNextCommit = false; throw new Error('provider token: secret-test'); }
      return remote.commitSnapshot(request);
    },
  };
  const first = createGitHubStateStore({ path: join(directory, 'runner-one', 'state.sqlite'), github });
  const recovered = createGitHubStateStore({ path: join(directory, 'runner-two', 'state.sqlite'), github });
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config, state: first, hn: { discover: async () => [story] },
      model: { ...model, getAllowance: async () => { failNextCommit = true; return model.getAllowance!(); } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    }), { message: 'GitHub state save failed; reload the latest committed snapshot before retrying' });
    first.close();
    await rm(join(directory, 'runner-one'), { recursive: true, force: true });
    const result = await runCycle({
      loadConfig: async () => config, state: recovered, hn: { discover: async () => [] }, model,
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(result.digest[0]?.summary, '编译器新版降低内存需求，可供开发者评估。');
    assert.equal(result.digest[0]?.createdAt, '2026-11-01T01:15:00.000Z');
    assert.equal(result.status.pendingCandidateCount, 0);
  } finally {
    first.close(); recovered.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('过期 runner 不能覆盖较新提交，冲突后的完整周期重新载入最新摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-conflict-'));
  const protocol = githubProtocol();
  const github = createGitHubSnapshotAdapter({ repository: 'owner/WatchTower', token: 'test-github-token', fetch: protocol.fetch });
  const initial = createGitHubStateStore({ path: join(directory, 'initial', 'state.sqlite'), github });
  const stale = createGitHubStateStore({ path: join(directory, 'stale', 'state.sqlite'), github });
  const current = createGitHubStateStore({ path: join(directory, 'current', 'state.sqlite'), github });
  const loaded = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const common = { loadConfig: async () => config, model, clock: () => new Date('2026-11-01T01:00:00.000Z') };
  try {
    await runCycle({ ...common, state: initial, hn: { discover: async () => [story] } });
    const staleCycle = runCycle({
      ...common, state: stale,
      hn: { discover: async () => { loaded.resolve(); await release.promise; return [{ ...story, id: '303' }]; } },
    });
    await loaded.promise;
    await runCycle({ ...common, state: current, hn: { discover: async () => [{ ...story, id: '302' }] } });
    release.resolve();
    await assert.rejects(staleCycle, { name: 'GitHubStateError', code: 'conflict' });
    const next = await runCycle({
      ...common, state: stale, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('已提交候选不应再次处理'); } },
    });
    assert.deepEqual(next.digest.flatMap(({ candidateId, candidateIds }) => candidateIds ?? [candidateId]), ['301', '302']);
    assert.equal(next.status.processedCandidateCount, 2);
  } finally {
    release.resolve(); initial.close(); stale.close(); current.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('已存在但损坏或未完成事务状态的快照不得被当成首次基线', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-invalid-'));
  const emptyPath = join(directory, 'uncommitted.sqlite');
  const empty = createSqliteStateStore(emptyPath);
  empty.close();
  try {
    for (const bytes of [Buffer.from('not a SQLite snapshot'), await readFile(emptyPath)]) {
      const state = createGitHubStateStore({
        path: join(directory, 'runner', 'state.sqlite'),
        github: {
          readSnapshot: async () => ({ version: 'known-commit', database: bytes }),
          commitSnapshot: async () => { throw new Error('损坏状态不应被新状态覆盖'); },
        },
      });
      try {
        await assert.rejects(runCycle({
          loadConfig: async () => config, state,
          hn: { discover: async () => { throw new Error('未恢复有效状态时不应采集'); } }, model,
          clock: () => new Date('2026-11-01T01:00:00.000Z'),
        }), { name: 'GitHubStateError', code: 'snapshot-invalid' });
      } finally { state.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('提交响应丢失时先核对远端完整快照，确证持久化后新 runner 不重复生成摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-uncertain-'));
  const protocol = githubProtocol();
  const github = createGitHubSnapshotAdapter({ repository: 'owner/WatchTower', token: 'test-github-token', fetch: protocol.fetch });
  const first = createGitHubStateStore({ path: join(directory, 'first', 'state.sqlite'), github });
  const second = createGitHubStateStore({ path: join(directory, 'second', 'state.sqlite'), github });
  try {
    protocol.loseNextSaveResponse = true;
    const result = await runCycle({
      loadConfig: async () => config, state: first, hn: { discover: async () => [story] }, model,
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    first.close();
    const reopened = await runCycle({
      loadConfig: async () => config, state: second, hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('已持久化摘要不应再次生成'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.deepEqual(reopened.digest, result.digest);
    assert.equal(reopened.status.pendingCandidateCount, 0);
  } finally {
    first.close(); second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('完整周期等待 GitHub 保存确认后才启动后续外部模型工作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-github-await-'));
  const protocol = githubProtocol();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  protocol.beforeCommit = async () => { reached.resolve(); await release.promise; };
  const state = createGitHubStateStore({
    path: join(directory, 'state.sqlite'),
    github: createGitHubSnapshotAdapter({ repository: 'owner/WatchTower', token: 'test-github-token', fetch: protocol.fetch }),
  });
  let modelStarted = false;
  try {
    const cycle = runCycle({
      loadConfig: async () => config, state, hn: { discover: async () => [story] },
      model: { getAllowance: model.getAllowance, analyze: async (request) => { modelStarted = true; return model.analyze(request); } },
      clock: () => new Date('2026-11-01T01:00:00.000Z'),
    });
    await reached.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(modelStarted, false, 'remote save acknowledgement is still pending');
    release.resolve();
    assert.equal((await cycle).status.processedCandidateCount, 1);
  } finally {
    release.resolve(); state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
