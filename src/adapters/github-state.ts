import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStateStore } from '../state.ts';
import type { StateStore } from '../types.ts';

export interface GitHubSnapshot {
  version: string;
  database: Uint8Array;
}

/** External snapshot boundary. A commit must reject an outdated expectedVersion. */
export interface GitHubSnapshotAdapter {
  readSnapshot(): Promise<GitHubSnapshot | null>;
  commitSnapshot(request: { expectedVersion: string | null; database: Uint8Array }): Promise<string>;
}

const errorMessages = {
  'read-failed': 'GitHub state read failed; no local state was used',
  'save-failed': 'GitHub state save failed; reload the latest committed snapshot before retrying',
  conflict: 'GitHub state version conflict; reload the latest committed snapshot before retrying',
  'load-required': 'Load the persisted GitHub state before saving',
  configuration: 'GitHub state requires a repository, branch and token',
  'snapshot-missing': 'The GitHub state branch has no SQLite snapshot; restore a known valid snapshot before retrying',
  'snapshot-too-large': 'The GitHub SQLite snapshot exceeds the application size limit',
  'snapshot-invalid': 'The GitHub SQLite snapshot is invalid; restore a known valid committed snapshot before retrying',
} as const;

/** Safe for logs: never includes provider response bodies, credentials or source text. */
export class GitHubStateError extends Error {
  readonly code: keyof typeof errorMessages;
  constructor(code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = 'GitHubStateError';
    this.code = code;
  }
}

/** Local SQLite is a working copy; every successful save also persists GitHub. */
export function createGitHubStateStore(options: {
  path: string;
  github: GitHubSnapshotAdapter;
}): StateStore & { close(): void } {
  let local: ReturnType<typeof createSqliteStateStore> | null = null;
  let version: string | null = null;
  function close() {
    local?.close();
    local = null;
  }
  return {
    async load() {
      close();
      let snapshot: GitHubSnapshot | null;
      try {
        snapshot = await options.github.readSnapshot();
      } catch (error) {
        throw error instanceof GitHubStateError ? error : new GitHubStateError('read-failed');
      }
      await mkdir(dirname(options.path), { recursive: true });
      for (const suffix of ['', '-journal', '-wal', '-shm']) await rm(options.path + suffix, { force: true });
      if (snapshot) {
        await writeFile(options.path, snapshot.database);
        let validation: DatabaseSync | undefined;
        try {
          validation = new DatabaseSync(options.path, { readOnly: true });
          const checks = validation.prepare('PRAGMA quick_check').all();
          if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('Invalid SQLite snapshot');
          const runtime = validation.prepare('SELECT payload FROM runtime_state WHERE id = 1').get();
          if (!runtime || JSON.parse(String(runtime.payload)).schemaVersion !== 1) throw new Error('Missing committed runtime state');
          validation.prepare('SELECT payload FROM candidates LIMIT 1').get();
          validation.prepare('SELECT payload FROM digest_entries LIMIT 1').get();
        } catch {
          throw new GitHubStateError('snapshot-invalid');
        } finally {
          validation?.close();
        }
      }
      local = createSqliteStateStore(options.path);
      version = snapshot?.version ?? null;
      try {
        return await local.load();
      } catch {
        close();
        throw new GitHubStateError('snapshot-invalid');
      }
    },
    async save(state) {
      if (!local) throw new GitHubStateError('load-required');
      try {
        await local.save(state);
        version = await options.github.commitSnapshot({ expectedVersion: version, database: await readFile(options.path) });
      } catch (error) {
        close();
        throw error instanceof GitHubStateError ? error : new GitHubStateError('save-failed');
      }
    },
    close,
  };
}
