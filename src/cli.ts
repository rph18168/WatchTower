import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHubSnapshotAdapter, createGitHubStateStore, createHackerNewsAdapter, createOpenRouterAdapter, createSqliteStateStore, GitHubStateError, readConfigFile, runCycle } from './index.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'watchtower.config.json' },
    state: { type: 'string', default: '.watchtower/state.sqlite' },
    digest: { type: 'string', default: '.watchtower/digest.md' },
    'allow-paid-model': { type: 'boolean', default: false },
    'github-state': { type: 'boolean', default: false },
    'state-branch': { type: 'string', default: 'watchtower-state' },
  } });
  if (!values['allow-paid-model']) {
    process.stderr.write('Live model execution requires --allow-paid-model. Complete usage controls and final acceptance before unattended operation.\n');
    process.exitCode = 2;
    return;
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key?.trim()) {
    process.stderr.write('OPENROUTER_API_KEY is required.\n');
    process.exitCode = 2;
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (values['github-state'] && (!token?.trim() || !repository?.trim())) {
    process.stderr.write('GITHUB_TOKEN and GITHUB_REPOSITORY are required for --github-state.\n');
    process.exitCode = 2;
    return;
  }
  const state = values['github-state']
    ? createGitHubStateStore({
      path: resolve(values.state!),
      github: createGitHubSnapshotAdapter({ repository: repository!, token: token!, branch: values['state-branch'] }),
    })
    : createSqliteStateStore(resolve(values.state!));
  try {
    const result = await runCycle({
      loadConfig: () => readConfigFile(resolve(values.config!)),
      state,
      hn: createHackerNewsAdapter(),
      model: createOpenRouterAdapter({ apiKey: key }),
    });
    const destination = resolve(values.digest!);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, result.markdown, 'utf8');
    process.stdout.write(JSON.stringify({ status: result.status, usage: result.usage, digestCount: result.digest.length }) + '\n');
  } finally {
    state.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof GitHubStateError) {
    process.stderr.write(`WatchTower cycle failed: ${error.message}.\n`);
    process.exitCode = 1;
  } else {
    // SDK errors can carry source material or request metadata. Never print them.
    process.stderr.write('WatchTower cycle failed. Saved candidates remain available for a subsequent run.\n');
    process.exitCode = 1;
  }
}
