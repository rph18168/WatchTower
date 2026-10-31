import { readFile } from 'node:fs/promises';
import type { WatchTowerConfig } from './types.ts';

/** Called for each run; persisted runtime state never supplies configuration. */
export async function readConfigFile(path: string): Promise<WatchTowerConfig> {
  return JSON.parse(await readFile(path, 'utf8'));
}
