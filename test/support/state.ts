import { createSqliteStateStore } from '../../src/index.ts';
import type { StateStore } from '../../src/index.ts';

/** These notification fixtures exercise an established installation. */
export async function establishMonitoringState(state: StateStore): Promise<void> {
  const snapshot = await state.load();
  if (snapshot.initialBaseline || snapshot.lastRunAt || snapshot.candidates.length || snapshot.digest.length || snapshot.notifications.length) return;
  snapshot.initialBaseline = {
    since: '2026-10-27T00:00:00.000Z', until: '2026-10-29T00:00:00.000Z',
    status: 'complete', completedAt: '2026-10-29T00:00:00.000Z',
  };
  await state.save(snapshot);
}

export async function createEstablishedStateStore(path: string) {
  const state = createSqliteStateStore(path);
  await establishMonitoringState(state);
  return state;
}
