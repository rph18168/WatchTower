import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CommandReport, GitHubReader } from './io.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const callSchema = z.looseObject({
  id: z.string(), startedAt: z.iso.datetime(), status: z.enum(['complete', 'unknown', 'in-flight']),
  model: z.string().optional(), responseId: z.string().optional(),
  costUsd: z.number().nonnegative().nullable().optional(), costComplete: z.boolean().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(), outputTokens: z.number().int().nonnegative().nullable().optional(),
});
const notificationSchema = z.looseObject({
  id: z.string(), kind: z.string().optional(), status: z.string(), text: z.string(),
  sentAt: z.string().nullable(), messageId: z.string().optional(), attempts: z.array(z.unknown()),
});
const runtimeSchema = z.looseObject({
  schemaVersion: z.literal(1), lastRunAt: z.iso.datetime().nullable(),
  initialBaseline: z.looseObject({ since: z.string(), until: z.string(), status: z.string() }).optional(),
  budget: z.looseObject({ calls: z.array(callSchema).optional(), pauseReason: z.string().nullable() }).optional(),
  notifications: z.array(notificationSchema).default([]),
  control: z.looseObject({ fault: z.object({ code: z.string(), at: z.string() }).optional() }).optional(),
});
const candidateSchema = z.looseObject({ story: z.looseObject({ id: z.string() }), status: z.enum(['pending', 'processed', 'archived']) });
const digestSchema = z.looseObject({ id: z.string(), summary: z.string() });
type Call = z.infer<typeof callSchema>;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export class SnapshotInvalid extends Error {}

export function callTotals(calls: Call[]) {
  const costComplete = calls.every(call => call.status === 'complete' && call.costComplete === true && typeof call.costUsd === 'number');
  const knownCostUsd = Number(calls.reduce((sum, call) => sum + (call.costComplete ? call.costUsd ?? 0 : 0), 0).toFixed(12));
  return {
    count: calls.length, costComplete, costUsd: costComplete ? knownCostUsd : null, knownCostUsd,
    inputTokens: calls.every(call => typeof call.inputTokens === 'number') ? calls.reduce((sum, call) => sum + call.inputTokens!, 0) : null,
    outputTokens: calls.every(call => typeof call.outputTokens === 'number') ? calls.reduce((sum, call) => sum + call.outputTokens!, 0) : null,
    receiptsComplete: costComplete && calls.every(call => call.model && call.responseId && typeof call.inputTokens === 'number' && typeof call.outputTokens === 'number'),
  };
}

function inspect(bytes: Buffer, path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA trusted_schema = OFF');
    const quickCheck = database.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') throw new SnapshotInvalid();
    const rows = (table: string) => database.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.payload)));
    const rawRuntime = rows('runtime_state');
    if (rawRuntime.length !== 1) throw new SnapshotInvalid();
    const raw = { runtime: rawRuntime[0], candidates: rows('candidates'), digest: rows('digest_entries') };
    const rawMaterialPaths: string[] = [], sensitiveFieldPaths: string[] = [];
    const privateField = /^(?:apiKey|api_key|token|botToken|bot_token|chatId|chat_id|userId|user_id|telegramChatId|telegramUserId|authorization|secret|secrets)$/i;
    function scan(value: unknown, path: string) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const next = `${path}.${key}`;
        if (privateField.test(key) && child !== null && child !== '') sensitiveFieldPaths.push(next);
        if ((key === 'quote' || (key === 'text' && /\.(story|source)$/.test(path))) && typeof child === 'string' && child.length) rawMaterialPaths.push(next);
        scan(child, next);
      }
    }
    scan(raw, 'state');
    const privacy = { rawMaterialPaths, sensitiveFieldPaths,
      physicalPrivateKeyMarkers: /"(?:apiKey|api_key|token|botToken|bot_token|chatId|chat_id|userId|user_id|telegramChatId|telegramUserId|authorization|secret|secrets)"\s*:/i.test(bytes.toString('utf8')) };
    const runtime = runtimeSchema.parse(raw.runtime);
    const candidates = z.array(candidateSchema).parse(raw.candidates);
    const digest = z.array(digestSchema).parse(raw.digest);
    const calls = runtime.budget?.calls ?? [];
    for (const ids of [candidates.map(item => item.story.id), digest.map(item => item.id), calls.map(item => item.id), runtime.notifications.map(item => item.id)]) {
      if (new Set(ids).size !== ids.length) throw new SnapshotInvalid();
    }
    const byUtcMonth = Object.fromEntries([...new Set(calls.map(call => call.startedAt.slice(0, 7)))].sort().map(month =>
      [month, callTotals(calls.filter(call => call.startedAt.startsWith(month)))]));
    const detail = {
      integrity: { quickCheck: 'ok', schemaVersion: runtime.schemaVersion, bytes: bytes.length, sha256: hash(bytes) },
      lastRunAt: runtime.lastRunAt, initialBaseline: runtime.initialBaseline ?? null,
      candidateCounts: Object.fromEntries(['pending', 'processed', 'archived'].map(status => [status, candidates.filter(item => item.status === status).length])),
      digestIds: digest.map(item => item.id),
      fees: { ...callTotals(calls), byUtcMonth },
      calls: calls.map(({ id, startedAt, status, model, responseId, costUsd, costComplete, inputTokens, outputTokens, accountingReconciliation }) =>
        ({ id, startedAt, status, model, responseId, costUsd, costComplete, inputTokens, outputTokens,
          accountingReconciliationSha256: accountingReconciliation ? hash(JSON.stringify(accountingReconciliation)) : null })),
      notifications: runtime.notifications.map(({ text, attempts, ...item }) => ({
        id: item.id, kind: item.kind ?? 'development', status: item.status, sentAt: item.sentAt, messageId: item.messageId,
        attempts: attempts.length, textSha256: hash(text), digestIdsInText: digest.filter(entry => entry.summary && text.includes(entry.summary)).map(entry => entry.id),
      })),
      pauseReason: runtime.budget?.pauseReason ?? null, fault: runtime.control?.fault ?? null, privacy,
    };
    const healthy = !privacy.rawMaterialPaths.length && !privacy.sensitiveFieldPaths.length && !privacy.physicalPrivateKeyMarkers &&
      detail.fees.costComplete && !detail.pauseReason && !detail.fault;
    return { detail, healthy, runtime, candidates, digest, calls };
  } catch { throw new SnapshotInvalid(); }
  finally { database.close(); }
}

export async function readSnapshot(github: GitHubReader, repository: string, commit: string, directory: string) {
  const metadata = z.object({ sha, size: z.number().int().positive().max(16 * 1024 * 1024),
    encoding: z.string(), content: z.string().optional() }).parse(await github.json(`repos/${repository}/contents/state.sqlite?ref=${commit}`));
  let content = metadata.content;
  if (metadata.encoding !== 'base64' || !content) {
    const blob = z.object({ encoding: z.literal('base64'), content: z.string() }).parse(await github.json(`repos/${repository}/git/blobs/${metadata.sha}`));
    content = blob.content;
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content) || content.length > 24 * 1024 * 1024) throw new SnapshotInvalid();
  const bytes = Buffer.from(content, 'base64');
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== metadata.size || blobSha !== metadata.sha) throw new SnapshotInvalid();
  const path = join(directory, `${commit}.sqlite`);
  await writeFile(path, bytes);
  const snapshot = inspect(bytes, path);
  return { ...snapshot, detail: { commit, blob: metadata.sha, path, ...snapshot.detail } };
}

export async function snapshotReport(github: GitHubReader, repository: string, commit: string, directory: string): Promise<CommandReport> {
  const snapshot = await readSnapshot(github, repository, commit, directory);
  return { exitCode: snapshot.healthy ? 0 : 4, detail: { ...snapshot.detail, result: snapshot.healthy ? 'SNAPSHOT_CHECKED' : 'SNAPSHOT_REQUIRES_ATTENTION' } };
}

export async function compareSnapshots(github: GitHubReader, repository: string, base: string, head: string, directory: string): Promise<CommandReport> {
  const before = await readSnapshot(github, repository, base, directory);
  const after = await readSnapshot(github, repository, head, directory);
  const ancestry = z.object({ status: z.string(), ahead_by: z.number(), behind_by: z.number(),
    base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }) }).parse(
      await github.json(`repos/${repository}/compare/${base}...${head}`));
  const retained = <T>(old: T[], current: T[], id: (value: T) => string) => {
    const indexed = new Map(current.map(value => [id(value), value]));
    return old.every(value => isDeepStrictEqual(value, indexed.get(id(value))));
  };
  const oldNotificationMap = new Map(after.runtime.notifications.map(item => [item.id, item]));
  const continuity = {
    ancestryRetained: ancestry.base_commit.sha === base && ancestry.merge_base_commit.sha === base && ancestry.behind_by === 0 && ['ahead', 'identical'].includes(ancestry.status),
    candidateIdsRetained: before.candidates.every(item => after.candidates.some(current => current.story.id === item.story.id)),
    oldDigestRecordsUnchanged: retained(before.digest, after.digest, item => item.id),
    oldModelCallRecordsUnchanged: retained(before.calls, after.calls, item => item.id),
    oldSentNotificationsUnchanged: retained(before.runtime.notifications.filter(item => item.status === 'sent'), after.runtime.notifications, item => item.id),
    notificationAttemptsRetained: before.runtime.notifications.every(item => {
      const current = oldNotificationMap.get(item.id);
      return current && isDeepStrictEqual(item.attempts, current.attempts.slice(0, item.attempts.length));
    }),
    initialBaselineWindowRetained: before.runtime.initialBaseline?.since === after.runtime.initialBaseline?.since && before.runtime.initialBaseline?.until === after.runtime.initialBaseline?.until,
  };
  const oldCallIds = new Set(before.calls.map(call => call.id));
  const newCalls = after.calls.filter(call => !oldCallIds.has(call.id));
  const oldNotificationIds = new Set(before.runtime.notifications.map(item => item.id));
  const newCallTotals = callTotals(newCalls);
  const healthy = before.healthy && after.healthy && Object.values(continuity).every(Boolean) && newCallTotals.receiptsComplete;
  return { exitCode: healthy ? 0 : 4, detail: {
    result: healthy ? 'SNAPSHOTS_CONTINUE' : 'SNAPSHOTS_REQUIRE_REVIEW', before: before.detail, after: after.detail,
    ancestry, continuity, newCallTotals, newCallIds: newCalls.map(call => call.id),
    newSentNotifications: after.detail.notifications.filter(item => item.status === 'sent' && !oldNotificationIds.has(item.id)),
  } };
}
