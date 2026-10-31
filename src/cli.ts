import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHackerNewsAdapter, createOpenRouterAdapter, createSqliteStateStore, readConfigFile, runCycle } from './index.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'watchtower.config.json' },
    state: { type: 'string', default: '.watchtower/state.sqlite' },
    digest: { type: 'string', default: '.watchtower/digest.md' },
    'allow-paid-model': { type: 'boolean', default: false },
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
  const state = createSqliteStateStore(resolve(values.state!));
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
} catch {
  // SDK errors can carry source material or request metadata. Never print them.
  process.stderr.write('WatchTower cycle failed. Saved candidates remain available for a subsequent run.\n');
  process.exitCode = 1;
}
