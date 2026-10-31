import assert from 'node:assert/strict';

/** Offline GitHub protocol fixture. Stores immutable commits and rejects stale HEAD writes. */
export function githubProtocol() {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, Buffer>>();
  const commits = new Map<string, Map<string, Buffer>>();
  let sequence = 0;
  let head: string | null = null;
  const oid = () => (++sequence).toString(16).padStart(40, '0');
  const service = {
    beforeCommit: undefined as (() => Promise<void>) | undefined,
    failNextSave: false,
    loseNextSaveResponse: false,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-github-token');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === 'GET' && url.pathname === '/repos/owner/WatchTower/git/ref/heads/watchtower-state') {
        return head ? Response.json({ ref: 'refs/heads/watchtower-state', object: { sha: head, type: 'commit' } }) : new Response(null, { status: 404 });
      }
      if (method === 'GET' && url.pathname === '/repos/owner/WatchTower') {
        return Response.json({ default_branch: 'codex/spec-1-integration' });
      }
      if (method === 'GET' && url.pathname === '/repos/owner/WatchTower/contents/state.sqlite') {
        const bytes = commits.get(url.searchParams.get('ref')!)?.get('state.sqlite');
        assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github.raw+json');
        return bytes ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 404 });
      }
      if (method === 'POST' && url.pathname === '/repos/owner/WatchTower/git/blobs') {
        assert.equal(body.encoding, 'base64');
        const sha = oid();
        blobs.set(sha, Buffer.from(body.content, 'base64'));
        return Response.json({ sha }, { status: 201 });
      }
      if (method === 'POST' && url.pathname === '/repos/owner/WatchTower/git/trees') {
        assert.equal(body.base_tree, undefined);
        const sha = oid();
        trees.set(sha, new Map(body.tree.map((entry: { path: string; mode: string; type: string; sha: string }) => {
          assert.equal(entry.mode, '100644'); assert.equal(entry.type, 'blob');
          return [entry.path, blobs.get(entry.sha)!];
        })));
        return Response.json({ sha }, { status: 201 });
      }
      if (method === 'POST' && url.pathname === '/repos/owner/WatchTower/git/commits') {
        assert.deepEqual(body.parents, []);
        const sha = oid();
        commits.set(sha, trees.get(body.tree)!);
        return Response.json({ sha }, { status: 201 });
      }
      if (method === 'POST' && url.pathname === '/repos/owner/WatchTower/git/refs') {
        assert.equal(body.ref, 'refs/heads/watchtower-state');
        if (head) return Response.json({ message: 'Reference already exists' }, { status: 422 });
        await service.beforeCommit?.();
        if (service.failNextSave) { service.failNextSave = false; return new Response(null, { status: 503 }); }
        head = body.sha;
        return Response.json({ object: { sha: head } }, { status: 201 });
      }
      if (method === 'POST' && url.pathname === '/graphql') {
        const request = body.variables.input;
        assert.equal(request.branch.repositoryNameWithOwner, 'owner/WatchTower');
        assert.equal(request.branch.branchName, 'watchtower-state');
        await service.beforeCommit?.();
        if (service.failNextSave) { service.failNextSave = false; return new Response(null, { status: 503 }); }
        if (request.expectedHeadOid !== head) return Response.json({ errors: [{ type: 'STALE_DATA', message: 'The branch HEAD changed' }] });
        const files = new Map(commits.get(head!)!);
        for (const addition of request.fileChanges.additions) files.set(addition.path, Buffer.from(addition.contents, 'base64'));
        head = oid();
        commits.set(head, files);
        if (service.loseNextSaveResponse) { service.loseNextSaveResponse = false; throw new Error('Connection closed after commit'); }
        return Response.json({ data: { createCommitOnBranch: { commit: { oid: head } } } });
      }
      throw new Error(`Unexpected GitHub protocol request: ${method} ${url.pathname}`);
    }) satisfies typeof fetch,
  };
  return service;
}
