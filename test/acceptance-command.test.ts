import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { acceptanceCommand } from '../scripts/acceptance.ts';

test('验收命令区分成功查询没有自然事件和 GitHub 查询失败，不公开原始错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-acceptance-'));
  const args = ['schedule', '--repo', 'owner/WatchTower', '--workflow', 'watchtower.yml',
    '--since', '2026-12-02T00:00:00Z', '--out', directory];
  try {
    const absent = await acceptanceCommand(args, {
      github: { json: async () => ({ total_count: 0, workflow_runs: [] }), jobLog: async () => '' },
    });
    assert.equal(absent.exitCode, 1);
    assert.equal(absent.summary.result, 'NO_NATURAL_EVENT_CREATED');
    assert.equal(JSON.parse(await readFile(join(directory, 'schedule.json'), 'utf8')).querySucceeded, true);
    const failure = await acceptanceCommand(args, {
      github: { json: async () => { throw new Error('EOF token=private-value'); }, jobLog: async () => '' },
    });
    assert.equal(failure.exitCode, 2);
    assert.equal(failure.summary.result, 'QUERY_FAILED');
    assert.equal(JSON.stringify(failure).includes('private-value'), false);
    assert.equal((await readFile(join(directory, 'schedule.json'), 'utf8')).includes('private-value'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('官方状态必须带可核对的 HTTP 时间，过期缓存不能作为实时平台证据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-platform-proof-'));
  let age = '10';
  const fetchStatus: typeof fetch = async input => {
    const summary = String(input).includes('summary.json');
    return new Response(JSON.stringify(summary
      ? { status: { indicator: 'none', description: 'All Systems Operational' }, components: [{ id: 'actions', name: 'Actions', status: 'operational' }], incidents: [] }
      : { incidents: [{ id: 'incident1', name: 'Actions delayed', status: 'resolved',
        created_at: '2026-12-02T00:00:00Z', updated_at: '2026-12-02T00:01:00Z', resolved_at: '2026-12-02T00:01:00Z', components: [{ name: 'Actions' }] }] }),
    { headers: { date: 'Wed, 02 Dec 2026 00:01:00 GMT', age } });
  };
  const args = ['platform', '--since', '2026-12-02T00:00:00Z', '--out', directory];
  const dependencies = { fetch: fetchStatus, now: () => new Date('2026-12-02T00:01:10Z') };
  try {
    assert.equal((await acceptanceCommand(args, dependencies)).exitCode, 0);
    const fresh = JSON.parse(await readFile(join(directory, 'platform.json'), 'utf8'));
    assert.equal(fresh.summary.http.ageSeconds, 10);
    assert.equal(fresh.summary.actionsStatus, 'operational');
    assert.equal(fresh.history.incidents[0].id, 'incident1');
    age = '86400';
    const stale = await acceptanceCommand(args, dependencies);
    assert.equal(stale.exitCode, 4);
    assert.equal(stale.summary.result, 'PLATFORM_FRESHNESS_UNVERIFIED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('自然事件报告读取完整分页；不完整列表和无效响应保持查询失败', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-schedule-pages-'));
  let incomplete = false;
  let malformed = false;
  const github = { jobLog: async () => '', json: async (path: string) => {
    if (malformed) return { unrelated: [] };
    const pageTwo = path.endsWith('page=2');
    return { total_count: 2, workflow_runs: pageTwo && incomplete ? [] : [{ id: pageTwo ? 2 : 1,
      event: 'schedule', created_at: '2026-12-02T00:01:00Z', status: 'completed', conclusion: 'success',
      head_sha: 'a'.repeat(40), html_url: 'https://github.com/owner/WatchTower/actions/runs/1' }] };
  } };
  const args = ['schedule', '--repo', 'owner/WatchTower', '--workflow', 'watchtower.yml', '--since', '2026-12-02T00:00:00Z', '--out', directory];
  try {
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 0);
    const evidence = JSON.parse(await readFile(join(directory, 'schedule.json'), 'utf8'));
    assert.equal(evidence.count, 2);
    incomplete = true;
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 2);
    malformed = true;
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('快照验收报告公开边界问题并隐藏原材料与身份值，损坏字节不能通过完整性核验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-private-proof-'));
  const commit = 'c'.repeat(40);
  try {
    const file = join(directory, 'private.sqlite');
    snapshot(file, [], { telegramUserId: 'private-owner-123' });
    const database = new DatabaseSync(file);
    database.prepare('INSERT INTO candidates VALUES (?)').run(JSON.stringify({ story: { id: 'story-2', text: 'private-source-text' }, status: 'pending' }));
    database.close();
    let corrupt = false;
    const github = { jobLog: async () => '', json: async () => {
      const bytes = corrupt ? Buffer.from('not SQLite') : await readFile(file);
      return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64'),
        sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
    } };
    const args = ['snapshot', '--repo', 'owner/WatchTower', '--commit', commit, '--out', join(directory, 'evidence')];
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 4);
    const reportText = await readFile(join(directory, 'evidence', 'snapshot.json'), 'utf8');
    const report = JSON.parse(reportText);
    assert.ok(report.privacy.sensitiveFieldPaths.length > 0);
    assert.ok(report.privacy.rawMaterialPaths.length > 0);
    assert.equal(reportText.includes('private-owner-123'), false);
    assert.equal(reportText.includes('private-source-text'), false);
    corrupt = true;
    const invalid = await acceptanceCommand(args, { github });
    assert.equal(invalid.exitCode, 4);
    assert.equal(invalid.summary.result, 'SNAPSHOT_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function snapshot(path: string, calls: object[], extra: object = {}) {
  const database = new DatabaseSync(path);
  try {
    database.exec('CREATE TABLE runtime_state (id INTEGER PRIMARY KEY, payload TEXT); CREATE TABLE candidates (payload TEXT); CREATE TABLE digest_entries (payload TEXT);');
    database.prepare('INSERT INTO runtime_state VALUES (1, ?)').run(JSON.stringify({
      schemaVersion: 1, lastRunAt: '2026-12-02T00:02:00Z',
      budget: { pauseReason: null, calls },
      notifications: [{ id: 'reply-1', kind: 'command-reply', status: 'sent', sentAt: '2026-12-02T00:00:00Z',
        messageId: '7', text: '旧摘要回复', attempts: [{ status: 'sent' }] }],
      initialBaseline: { since: '2026-11-30T00:00:00Z', until: '2026-12-02T00:00:00Z', status: 'building' }, ...extra,
    }));
    database.prepare('INSERT INTO candidates VALUES (?)').run(JSON.stringify({ story: { id: 'story-1' }, status: 'processed' }));
    database.prepare('INSERT INTO digest_entries VALUES (?)').run(JSON.stringify({ id: 'digest-1', summary: '旧摘要' }));
  } finally { database.close(); }
}

test('固定 SHA 的只读快照比较保留旧摘要、费用和 message7，未知费用不按零验收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-snapshot-proof-'));
  const before = 'a'.repeat(40), after = 'b'.repeat(40);
  const oldCall = { id: 'old', startedAt: '2026-12-02T00:00:00Z', status: 'complete', model: 'fixture/model',
    responseId: 'gen-old', costUsd: 0.01, costComplete: true, inputTokens: 100, outputTokens: 10 };
  const newCall = { ...oldCall, id: 'new', responseId: 'gen-new', costUsd: 0.02, inputTokens: 200, outputTokens: 20 };
  try {
    snapshot(join(directory, 'before.sqlite'), [oldCall]);
    snapshot(join(directory, 'after.sqlite'), [oldCall, newCall]);
    const github = {
      async json(path: string) {
        if (path.includes('/compare/')) return { status: 'ahead', ahead_by: 2, behind_by: 0,
          base_commit: { sha: before }, merge_base_commit: { sha: before } };
        const bytes = await readFile(join(directory, path.endsWith(before) ? 'before.sqlite' : 'after.sqlite'));
        return { size: bytes.length, encoding: 'base64', content: bytes.toString('base64'),
          sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
      },
      jobLog: async () => '',
    };
    const args = ['compare', '--repo', 'owner/WatchTower', '--before', before, '--after', after, '--out', join(directory, 'evidence')];
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 0);
    const report = JSON.parse(await readFile(join(directory, 'evidence', 'compare.json'), 'utf8'));
    assert.equal(report.continuity.oldDigestRecordsUnchanged, true);
    assert.equal(report.continuity.oldModelCallRecordsUnchanged, true);
    assert.equal(report.continuity.oldSentNotificationsUnchanged, true);
    assert.equal(report.newCallTotals.costUsd, 0.02);
    assert.equal(report.newCallTotals.inputTokens, 200);
    assert.equal(report.after.fees.byUtcMonth['2026-12'].knownCostUsd, 0.03);
    assert.equal(report.after.integrity.quickCheck, 'ok');
    assert.equal(JSON.stringify(report).includes('旧摘要'), false);
    const afterBytes = await readFile(join(directory, 'after.sqlite'));
    assert.deepEqual(await readFile(join(directory, 'evidence', `${after}.sqlite`)), afterBytes);
    // A later recorded call with no receipt must never become a zero-cost success.
    const unknownPath = join(directory, 'after.sqlite');
    const database = new DatabaseSync(unknownPath);
    const runtime = JSON.parse(String(database.prepare('SELECT payload FROM runtime_state').get()!.payload));
    runtime.budget.calls[1] = { ...newCall, status: 'unknown', costUsd: null, costComplete: false };
    database.prepare('UPDATE runtime_state SET payload = ?').run(JSON.stringify(runtime));
    database.close();
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 4);
    const unknown = JSON.parse(await readFile(join(directory, 'evidence', 'compare.json'), 'utf8'));
    assert.equal(unknown.newCallTotals.costUsd, null);
    assert.equal(unknown.newCallTotals.costComplete, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('自然 run 只有实际完整周期成功且 checkout SHA 匹配时才通过，绿色 skipped 不算执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-run-proof-'));
  const checkout = 'a'.repeat(40);
  const run = { id: 42, run_attempt: 1, event: 'schedule', created_at: '2026-12-02T00:01:00Z',
    status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40), html_url: 'https://github.com/owner/WatchTower/actions/runs/42' };
  const cycle: { name: string; status: string; conclusion: string; started_at: string | null; completed_at: string | null } = { name: 'Execute one complete cycle and await each GitHub snapshot save',
    status: 'completed', conclusion: 'skipped', started_at: null, completed_at: null };
  const args = ['run', '--repo', 'owner/WatchTower', '--run', '42', '--attempt', '1', '--event', 'schedule',
    '--mode', 'live', '--expect-checkout', checkout, '--out', directory];
  const github = {
    json: async (path: string) => path.endsWith('/attempts/1') ? run : ({ total_count: 1, jobs: [{
      id: 43, name: 'live', status: 'completed', conclusion: 'success', steps: [
        { ...cycle, name: 'Run actions/checkout@v7', conclusion: 'success' }, cycle,
      ],
    }] }),
    jobLog: async () => `live\tRun actions/checkout@v7\t2026-12-02T00:01:03Z [command]/usr/bin/git log -1 --format=%H\nlive\tRun actions/checkout@v7\t2026-12-02T00:01:03Z ${checkout}\nraw token=private-value`,
  };
  try {
    const skipped = await acceptanceCommand(args, { github });
    assert.equal(skipped.exitCode, 1);
    run.conclusion = 'failure';
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 4);
    run.conclusion = 'success';
    cycle.conclusion = 'success';
    cycle.started_at = '2026-12-02T00:01:05Z';
    cycle.completed_at = '2026-12-02T00:01:10Z';
    const executed = await acceptanceCommand(args, { github });
    assert.equal(executed.exitCode, 0);
    const evidence = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
    assert.equal(evidence.result, 'RUN_EXECUTED');
    assert.equal(evidence.checkoutSha, checkout);
    assert.equal(evidence.run.head_sha, 'b'.repeat(40));
    assert.equal(JSON.stringify(evidence).includes('private-value'), false);
    const mismatch = await acceptanceCommand(args.map(value => value === checkout ? 'c'.repeat(40) : value), { github });
    assert.equal(mismatch.exitCode, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('commands 验收须证明付费周期及模型 Secret 检查被跳过', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchtower-commands-proof-'));
  const checkout = 'd'.repeat(40);
  const step = { status: 'completed', conclusion: 'success', started_at: '2026-12-02T00:01:00Z', completed_at: '2026-12-02T00:02:00Z' };
  const paid = { ...step, name: 'Execute one complete cycle and await each GitHub snapshot save', conclusion: 'skipped' };
  const github = {
    json: async (path: string) => path.endsWith('/attempts/1') ? { id: 42, run_attempt: 1, event: 'workflow_dispatch',
      created_at: '2026-12-02T00:01:00Z', status: 'completed', conclusion: 'success', head_sha: checkout,
      html_url: 'https://github.com/owner/WatchTower/actions/runs/42' } : { total_count: 1, jobs: [{
      id: 43, name: 'live', status: 'completed', conclusion: 'success', steps: [
        { ...step, name: 'Run actions/checkout@v7' }, paid,
        { ...step, name: 'Check model secret without displaying values', conclusion: 'skipped' },
        { ...step, name: 'Process personal Telegram commands from the same persisted state' },
      ],
    }] },
    jobLog: async () => `live\tUNKNOWN STEP\t2026-12-02T00:01:03Z [command]/usr/bin/git log -1 --format=%H\nlive\tUNKNOWN STEP\t2026-12-02T00:01:03Z ${checkout}`,
  };
  const args = ['run', '--repo', 'owner/WatchTower', '--run', '42', '--attempt', '1', '--event', 'workflow_dispatch',
    '--mode', 'commands', '--expect-checkout', checkout, '--out', directory];
  try {
    assert.equal((await acceptanceCommand(args, { github })).exitCode, 0);
    paid.conclusion = 'success';
    const wrongMode = await acceptanceCommand(args, { github });
    assert.equal(wrongMode.exitCode, 4);
    assert.equal(wrongMode.summary.result, 'MODE_UNVERIFIED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
