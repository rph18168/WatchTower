import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHackerNewsAdapter, createSqliteStateStore, readConfigFile, runCycle } from '../src/index.ts';
import type { CandidateStory, DigestModelAdapter, WatchTowerConfig } from '../src/index.ts';

const now = new Date('2026-11-01T01:00:00.000Z');
const config: WatchTowerConfig = {
  topics: [
    { id: 'computing', description: '降低软件开发成本的计算技术进展' },
    { id: 'astronomy', description: '天文学观测和公共科研设施的新进展' },
  ],
  model: 'openai/gpt-4.1-mini',
};

const stories: CandidateStory[] = [
  {
    id: '101',
    title: 'A compiler reduces memory use',
    url: 'https://compiler.example/release',
    hnUrl: 'https://news.ycombinator.com/item?id=101',
    text: 'The compiler release reduces peak memory use.',
    score: 40,
    publishedAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: '102',
    title: 'A public observatory opens its archive',
    url: 'https://observatory.example/archive',
    hnUrl: 'https://news.ycombinator.com/item?id=102',
    text: 'The observatory released its public image archive.',
    score: 35,
    publishedAt: '2026-11-01T00:10:00.000Z',
  },
  {
    id: '103',
    title: 'A new bread recipe',
    url: 'https://bread.example/recipe',
    hnUrl: 'https://news.ycombinator.com/item?id=103',
    text: 'A sourdough recipe.',
    score: 30,
    publishedAt: '2026-11-01T00:20:00.000Z',
  },
];

test('一个完整周期按不同领域的关注主题保留相关摘要，SQLite 重开后可导出同一摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-t01-'));
  const databasePath = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(databasePath);
  const requests: Parameters<DigestModelAdapter['analyze']>[0][] = [];
  try {
    const result = await runCycle({
      loadConfig: async () => config,
      state,
      hn: { discover: async () => stories },
      model: {
        analyze: async (request) => {
          requests.push(request);
          return {
            decisions: [
              { candidateId: '101', topicIds: ['computing'], summary: '编译器新版降低内存使用量，为资源受限的开发环境提供新选择。' },
              { candidateId: '102', topicIds: ['astronomy'], summary: '天文台开放观测影像档案，公众可直接查阅其观测成果。' },
              { candidateId: '103', topicIds: [], summary: null },
            ],
            usage: { costUsd: 0.0012, inputTokens: 600, outputTokens: 120 },
          };
        },
      },
      clock: () => now,
    });

    assert.deepEqual(result.digest.map(({ candidateId, summary, topicIds, sources }) => ({ candidateId, summary, topicIds, sources })), [
      {
        candidateId: '101',
        summary: '编译器新版降低内存使用量，为资源受限的开发环境提供新选择。',
        topicIds: ['computing'],
        sources: [
          { kind: 'original', url: 'https://compiler.example/release' },
          { kind: 'hn', url: 'https://news.ycombinator.com/item?id=101' },
        ],
      },
      {
        candidateId: '102',
        summary: '天文台开放观测影像档案，公众可直接查阅其观测成果。',
        topicIds: ['astronomy'],
        sources: [
          { kind: 'original', url: 'https://observatory.example/archive' },
          { kind: 'hn', url: 'https://news.ycombinator.com/item?id=102' },
        ],
      },
    ]);
    assert.deepEqual(requests[0]?.topics, config.topics);
    assert.deepEqual(result.usage, { costUsd: 0.0012, inputTokens: 600, outputTokens: 120 });
    assert.deepEqual(result.status, {
      candidateCount: 3,
      processedCandidateCount: 3,
      pendingCandidateCount: 0,
      lastRunAt: '2026-11-01T01:00:00.000Z',
    });

    state.close();
    state = createSqliteStateStore(databasePath);
    const reopened = await runCycle({
      loadConfig: async () => config,
      state,
      hn: { discover: async () => [] },
      model: { analyze: async () => { throw new Error('没有新候选时不应调用模型'); } },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.deepEqual(reopened.digest, result.digest);
    assert.equal(reopened.markdown, '# WatchTower 摘要\n\n## A compiler reduces memory use\n\n编译器新版降低内存使用量，为资源受限的开发环境提供新选择。\n\n- 关注主题：computing\n- 记录时间：2026-11-01T01:00:00.000Z\n- [原文](https://compiler.example/release)\n- [HN 讨论](https://news.ycombinator.com/item?id=101)\n\n## A public observatory opens its archive\n\n天文台开放观测影像档案，公众可直接查阅其观测成果。\n\n- 关注主题：astronomy\n- 记录时间：2026-11-01T01:00:00.000Z\n- [原文](https://observatory.example/archive)\n- [HN 讨论](https://news.ycombinator.com/item?id=102)\n');
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('模型未生成中文摘要时保留待处理候选，SQLite 重开后下一周期可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-recovery-'));
  const path = join(directory, 'state.sqlite');
  let state = createSqliteStateStore(path);
  try {
    await assert.rejects(runCycle({
      loadConfig: async () => config,
      state,
      hn: { discover: async () => [stories[0]!] },
      model: { analyze: async () => ({ decisions: [{ candidateId: '101', topicIds: ['computing'], summary: 'A compiler release reduces memory use.' }], usage: { costUsd: 0.001, inputTokens: 100, outputTokens: 20 } }) },
      clock: () => now,
    }), /Chinese digest summary/);
    state.close();
    state = createSqliteStateStore(path);
    const recovered = await runCycle({
      loadConfig: async () => config,
      state,
      hn: { discover: async () => [] },
      model: { analyze: async () => ({ decisions: [{ candidateId: '101', topicIds: ['computing'], summary: '编译器新版降低内存需求，可供开发者评估。' }], usage: { costUsd: 0.001, inputTokens: 100, outputTokens: 20 } }) },
      clock: () => new Date('2026-11-01T01:15:00.000Z'),
    });
    assert.equal(recovered.digest[0]?.summary, '编译器新版降低内存需求，可供开发者评估。');
    assert.equal(recovered.status.pendingCandidateCount, 0);
    assert.equal(recovered.status.processedCandidateCount, 1);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('同一周期通过 HN 协议读取所有分页，并以帖子 ID 合并重叠候选', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-hn-'));
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const requestedPages: string[] = [];
  try {
    const hn = createHackerNewsAdapter({
      fetch: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.origin + url.pathname, 'https://hn.algolia.com/api/v1/search_by_date');
        assert.equal(url.searchParams.get('tags'), 'story');
        assert.match(url.searchParams.get('numericFilters')!, /^points>=20,created_at_i>=\d+,created_at_i<=\d+$/);
        requestedPages.push(url.searchParams.get('page')!);
        const hit = (index: number) => ({
          objectID: stories[index]!.id,
          title: stories[index]!.title,
          url: stories[index]!.url,
          story_text: null,
          points: stories[index]!.score,
          created_at_i: Math.floor(Date.parse(stories[index]!.publishedAt) / 1000),
        });
        return Response.json({ hits: url.searchParams.get('page') === '0' ? [hit(0)] : [hit(0), hit(1)], nbPages: 2, nbHits: 3 });
      },
    });
    const result = await runCycle({
      loadConfig: async () => config,
      state,
      hn,
      model: {
        analyze: async ({ candidates }) => ({
          decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: ['computing'], summary: '本次动态已保存，详细内容可通过来源查阅。' })),
          usage: { costUsd: 0.001, inputTokens: 200, outputTokens: 40 },
        }),
      },
      clock: () => now,
    });
    assert.deepEqual(result.digest.map(({ candidateId }) => candidateId), ['101', '102']);
    assert.equal(result.status.candidateCount, 2);
    assert.deepEqual(requestedPages, ['0', '1']);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('修改版本管理中的关注主题配置后，下一周期使用新描述而保留原有摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-config-'));
  const configurationPath = join(directory, 'watchtower.json');
  const state = createSqliteStateStore(join(directory, 'state.sqlite'));
  const topicsSeen: string[][] = [];
  try {
    await writeFile(configurationPath, JSON.stringify(config));
    const options = {
      loadConfig: () => readConfigFile(configurationPath),
      state,
      hn: { discover: async () => [stories[0]!] },
      model: {
        analyze: async ({ topics, candidates }: Parameters<DigestModelAdapter['analyze']>[0]) => {
          topicsSeen.push(topics.map(({ description }) => description));
          return {
            decisions: candidates.map(({ id }) => ({ candidateId: id, topicIds: [topics[0]!.id], summary: id === '101' ? '编译器更新降低开发环境的内存需求。' : '新的面包制作方法介绍了发酵过程。' })),
            usage: { costUsd: 0.001, inputTokens: 200, outputTokens: 40 },
          };
        },
      },
      clock: () => now,
    };
    await runCycle(options);
    await writeFile(configurationPath, JSON.stringify({ model: config.model, topics: [{ id: 'baking', description: '家庭烘焙方法和发酵技术' }] }));
    const next = await runCycle({ ...options, hn: { discover: async () => [stories[2]!] } });
    assert.deepEqual(topicsSeen, [
      ['降低软件开发成本的计算技术进展', '天文学观测和公共科研设施的新进展'],
      ['家庭烘焙方法和发酵技术'],
    ]);
    assert.deepEqual(next.digest.map(({ candidateId, topicIds, summary }) => ({ candidateId, topicIds, summary })), [
      { candidateId: '101', topicIds: ['computing'], summary: '编译器更新降低开发环境的内存需求。' },
      { candidateId: '103', topicIds: ['baking'], summary: '新的面包制作方法介绍了发酵过程。' },
    ]);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
