import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitHubReader {
  json(path: string): Promise<unknown>;
  jobLog(repository: string, request: { runId: string; attempt: string; jobId: number }): Promise<string>;
}

export interface CommandReport { exitCode: number; detail: Record<string, unknown> }

const execute = promisify(execFile);

/** Fixed GET transport: no dispatch, retries, state writes, or raw error output. */
export const githubReader: GitHubReader = {
  async json(path) {
    const { stdout } = await execute('gh', ['api', '--method', 'GET', path, '-H', 'Cache-Control: no-cache'], {
      timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  },
  async jobLog(repository, request) {
    const { stdout } = await execute('gh', ['run', 'view', request.runId, '--repo', repository,
      '--attempt', request.attempt, '--job', String(request.jobId), '--log'], {
      timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  },
};

export async function pages<T>(read: (page: number) => Promise<{ total_count: number; items: T[] }>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const next = await read(page);
    items.push(...next.items);
    if (items.length >= next.total_count) return items;
    if (next.items.length === 0) break;
  }
  throw new Error('Incomplete GitHub listing');
}
