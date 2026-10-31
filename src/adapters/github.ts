import { GitHubStateError } from './github-state.ts';
import type { GitHubSnapshotAdapter } from './github-state.ts';

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const snapshotPath = 'state.sqlite';
interface WriteResponse {
  sha?: unknown;
  object?: { sha?: unknown };
  errors?: unknown[];
  data?: { createCommitOnBranch?: { commit?: { oid?: unknown } } };
}

/** Only this branch is written; no checkout, force update, binary merge or push hook is involved. */
export function createGitHubSnapshotAdapter(options: {
  repository: string;
  token: string;
  branch?: string;
  fetch?: typeof fetch;
}): GitHubSnapshotAdapter {
  const branch = options.branch ?? 'watchtower-state';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) || !options.token.trim() ||
      !/^[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new GitHubStateError('configuration');
  }
  const repositoryPath = `/repos/${options.repository}`;
  const fetcher = options.fetch ?? fetch;
  async function request(path: string, method = 'GET', body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    return fetcher(`https://api.github.com${path}`, {
      method, headers: {
        Authorization: `Bearer ${options.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
  }
  async function json(path: string, body: unknown): Promise<WriteResponse> {
    const response = await request(path, 'POST', body);
    if (!response.ok) throw new GitHubStateError('save-failed');
    return response.json();
  }
  function validOid(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new GitHubStateError('save-failed');
    return value;
  }
  const adapter: GitHubSnapshotAdapter = {
    async readSnapshot() {
      try {
        const reference = await request(`${repositoryPath}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
        if (reference.status === 404) {
          // Permission/network failures must never turn an inaccessible repository into a new baseline.
          const repository = await request(repositoryPath);
          if (!repository.ok || !(await repository.json()).default_branch) throw new GitHubStateError('read-failed');
          return null;
        }
        if (!reference.ok) throw new GitHubStateError('read-failed');
        const version = validOid((await reference.json()).object?.sha);
        const response = await request(`${repositoryPath}/contents/${snapshotPath}?ref=${version}`, 'GET', undefined, 'application/vnd.github.raw+json');
        if (response.status === 404) throw new GitHubStateError('snapshot-missing');
        if (!response.ok) throw new GitHubStateError('read-failed');
        const database = new Uint8Array(await response.arrayBuffer());
        if (database.byteLength > MAX_SNAPSHOT_BYTES) throw new GitHubStateError('snapshot-too-large');
        return { version, database };
      } catch (error) {
        throw error instanceof GitHubStateError ? error : new GitHubStateError('read-failed');
      }
    },
    async commitSnapshot({ expectedVersion, database }) {
      try {
        if (database.byteLength > MAX_SNAPSHOT_BYTES) throw new GitHubStateError('snapshot-too-large');
        const content = Buffer.from(database).toString('base64');
        if (expectedVersion === null) {
          // The first root commit contains the database, so an incomplete branch is never published.
          const blob = validOid((await json(`${repositoryPath}/git/blobs`, { content, encoding: 'base64' })).sha);
          const tree = validOid((await json(`${repositoryPath}/git/trees`, { tree: [{ path: snapshotPath, mode: '100644', type: 'blob', sha: blob }] })).sha);
          const commit = validOid((await json(`${repositoryPath}/git/commits`, { message: 'Initialize WatchTower state', tree, parents: [] })).sha);
          const result = await json(`${repositoryPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit });
          return validOid(result.object?.sha);
        }
        const result = await json('/graphql', {
          query: 'mutation SaveSnapshot($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
          variables: { input: {
            branch: { repositoryNameWithOwner: options.repository, branchName: branch },
            expectedHeadOid: expectedVersion,
            message: { headline: 'Save WatchTower state' },
            fileChanges: { additions: [{ path: snapshotPath, contents: content }] },
          } },
        });
        if (result.errors?.length) throw new GitHubStateError('save-failed');
        return validOid(result.data?.createCommitOnBranch?.commit?.oid);
      } catch (error) {
        if (error instanceof GitHubStateError && error.code === 'snapshot-too-large') throw error;
        try {
          const latest = await adapter.readSnapshot();
          // A timeout can happen after GitHub commits. Only exact bytes establish this save's durability.
          if (latest && Buffer.from(latest.database).equals(Buffer.from(database))) return latest.version;
          if ((latest?.version ?? null) !== expectedVersion) throw new GitHubStateError('conflict');
        } catch (inspectionError) {
          if (inspectionError instanceof GitHubStateError && inspectionError.code === 'conflict') throw inspectionError;
        }
        throw new GitHubStateError('save-failed');
      }
    },
  };
  return adapter;
}
