import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { githubReader, type CommandReport, type GitHubReader } from './acceptance/io.ts';
import { inspectRun, inspectSchedule } from './acceptance/run.ts';
import { compareSnapshots, SnapshotInvalid, snapshotReport } from './acceptance/snapshot.ts';
import { inspectPlatform } from './acceptance/platform.ts';

export interface AcceptanceDependencies {
  github?: GitHubReader;
  now?: () => Date;
  fetch?: typeof fetch;
}
interface CommandResult { exitCode: number; summary: Record<string, unknown> }

const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });
const integer = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
const out = z.string().min(1);
const commandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('schedule'), repo: repository, workflow: z.string().regex(/^[\w.-]+$/), since: timestamp, out }),
  z.strictObject({ command: z.literal('run'), repo: repository, run: integer, attempt: integer,
    event: z.enum(['schedule', 'workflow_dispatch']), mode: z.enum(['live', 'commands']), 'expect-checkout': commit, out }),
  z.strictObject({ command: z.literal('snapshot'), repo: repository, commit, out }),
  z.strictObject({ command: z.literal('compare'), repo: repository, before: commit, after: commit, out }),
  z.strictObject({ command: z.literal('platform'), since: timestamp, out }),
]);
const usage = `Read-only WatchTower acceptance (Node 24.15+, authenticated gh):
  schedule --repo owner/repo --workflow FILE_OR_ID --since ISO_TIME --out DIR
  run --repo owner/repo --run ID --attempt N --event schedule|workflow_dispatch --mode live|commands --expect-checkout SHA --out DIR
  snapshot --repo owner/repo --commit SHA --out DIR
  compare --repo owner/repo --before SHA --after SHA --out DIR
  platform --since ISO_TIME --out DIR
Exit: 0 evidence checked; 1 absent/not executed; 2 query/IO failed; 3 arguments; 4 evidence requires review.
Details: docs/acceptance-tools.md`;

/** Public command boundary. Only external read transports and time are replaceable. */
export async function acceptanceCommand(argv: string[], dependencies: AcceptanceDependencies = {}): Promise<CommandResult> {
  if (argv.length === 1 && argv[0] === '--help') return { exitCode: 0, summary: { result: 'HELP', usage } };
  const checkedAtUtc = (dependencies.now?.() ?? new Date()).toISOString();
  let args: z.infer<typeof commandSchema>;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(
      ['repo', 'workflow', 'since', 'out', 'run', 'attempt', 'event', 'mode', 'expect-checkout', 'commit', 'before', 'after']
        .map(name => [name, { type: 'string' as const }])) });
    if (positionals.length !== 1) throw new Error('Expected one command');
    args = commandSchema.parse({ command: positionals[0], ...values });
  } catch { return { exitCode: 3, summary: { result: 'INVALID_ARGUMENTS', help: 'npm run acceptance -- --help' } }; }
  const output = resolve(args.out);
  try { await mkdir(output, { recursive: true }); }
  catch { return { exitCode: 2, summary: { checkedAtUtc, result: 'LOCAL_IO_FAILED' } }; }
  const github = dependencies.github ?? githubReader;
  let report: CommandReport;
  try {
    switch (args.command) {
      case 'schedule': report = await inspectSchedule(github, args.repo, args.workflow, args.since); break;
      case 'run': report = await inspectRun(github, args.repo, { id: args.run, attempt: args.attempt,
        event: args.event, mode: args.mode, checkout: args['expect-checkout'] }); break;
      case 'snapshot': report = await snapshotReport(github, args.repo, args.commit, output); break;
      case 'compare': report = await compareSnapshots(github, args.repo, args.before, args.after, output); break;
      case 'platform': report = await inspectPlatform(dependencies.fetch ?? fetch, dependencies.now ?? (() => new Date()), args.since); break;
    }
  } catch (error) {
    report = error instanceof SnapshotInvalid
      ? { exitCode: 4, detail: { result: 'SNAPSHOT_INVALID' } }
      : { exitCode: 2, detail: { result: 'QUERY_FAILED', querySucceeded: false } };
  }
  try {
    const reportPath = join(output, `${args.command}.json`);
    await writeFile(reportPath, `${JSON.stringify({ checkedAtUtc, repository: 'repo' in args ? args.repo : undefined, ...report.detail }, null, 2)}\n`);
    return { exitCode: report.exitCode, summary: { checkedAtUtc, result: report.detail.result, reportPath } };
  } catch { return { exitCode: 2, summary: { checkedAtUtc, result: 'LOCAL_IO_FAILED' } }; }
}

if (import.meta.main) {
  const result = await acceptanceCommand(process.argv.slice(2));
  console.log(result.summary.result === 'HELP' ? result.summary.usage : JSON.stringify(result.summary));
  process.exitCode = result.exitCode;
}
