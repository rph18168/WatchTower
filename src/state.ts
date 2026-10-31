import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MonitoringState, StateStore } from './types.ts';

/** SQLite is the durable source. Markdown is regenerated from its digest. */
export function createSqliteStateStore(path: string): StateStore & { close(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS digest_entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
  `);
  return {
    async load() {
      const runtime = database.prepare('SELECT payload FROM runtime_state WHERE id = 1').get();
      if (!runtime) {
        return { schemaVersion: 1, candidates: [], digest: [], notifications: [], lastRunAt: null };
      }
      const metadata = JSON.parse(String(runtime.payload));
      if (metadata.schemaVersion !== 1) {
        throw new Error('Unsupported WatchTower state schema');
      }
      return {
        ...metadata,
        notifications: metadata.notifications ?? [],
        developments: metadata.developments ?? [],
        candidates: database.prepare('SELECT payload FROM candidates ORDER BY rowid').all().map((row) => JSON.parse(String(row.payload))),
        digest: database.prepare('SELECT payload FROM digest_entries ORDER BY rowid').all().map((row) => JSON.parse(String(row.payload))),
      };
    },
    async save(state: MonitoringState) {
      const { candidates, digest, ...metadata } = state;
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DELETE FROM candidates; DELETE FROM digest_entries;');
        const insertCandidate = database.prepare('INSERT INTO candidates (id, payload) VALUES (?, ?)');
        const insertDigest = database.prepare('INSERT INTO digest_entries (id, payload) VALUES (?, ?)');
        for (const candidate of candidates) {
          insertCandidate.run(candidate.story.id, JSON.stringify(candidate));
        }
        for (const entry of digest) {
          insertDigest.run(entry.id, JSON.stringify(entry));
        }
        database.prepare('INSERT OR REPLACE INTO runtime_state (id, payload) VALUES (1, ?)').run(JSON.stringify(metadata));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}
