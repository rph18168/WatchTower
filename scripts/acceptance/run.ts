import { z } from 'zod';
import { pages, type CommandReport, type GitHubReader } from './io.ts';

export const runMetadata = z.object({
  id: z.number().int().positive(), event: z.string(), created_at: z.iso.datetime(),
  status: z.string(), conclusion: z.string().nullable(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  html_url: z.url(),
});
const stepSchema = z.object({
  name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  started_at: z.iso.datetime().nullable(), completed_at: z.iso.datetime().nullable(),
});
const jobSchema = z.object({
  id: z.number().int().positive(), name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  steps: z.array(stepSchema),
});

export async function inspectSchedule(github: GitHubReader, repository: string, workflow: string, since: string): Promise<CommandReport> {
  const runs = await pages(async page => {
    const response = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runMetadata) }).parse(
      await github.json(`repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=schedule&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`));
    return { total_count: response.total_count, items: response.workflow_runs };
  });
  const matching = runs.filter(run => run.event === 'schedule' && Date.parse(run.created_at) >= Date.parse(since));
  return { exitCode: matching.length ? 0 : 1, detail: {
    result: matching.length ? 'NATURAL_EVENT_CREATED' : 'NO_NATURAL_EVENT_CREATED',
    querySucceeded: true, since, count: matching.length, runs: matching,
  } };
}

export async function inspectRun(github: GitHubReader, repository: string,
  request: { id: string; attempt: string; event: string; mode: string; checkout: string }): Promise<CommandReport> {
  const base = `repos/${repository}/actions/runs/${request.id}/attempts/${request.attempt}`;
  const run = runMetadata.extend({ run_attempt: z.number().int().positive() }).parse(await github.json(base));
  const jobs = await pages(async page => {
    const response = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema) }).parse(
      await github.json(`${base}/jobs?per_page=100&page=${page}`));
    return { total_count: response.total_count, items: response.jobs };
  });
  const job = jobs.find(item => item.name === 'live');
  const cycleName = request.mode === 'commands'
    ? 'Process personal Telegram commands from the same persisted state'
    : 'Execute one complete cycle and await each GitHub snapshot save';
  const cycle = job?.steps.find(step => step.name === cycleName);
  const detail: Record<string, unknown> = { run, jobs, expectedEvent: request.event, expectedCheckout: request.checkout, mode: request.mode };
  if (run.id !== Number(request.id) || run.run_attempt !== Number(request.attempt) || run.event !== request.event) {
    return { exitCode: 4, detail: { ...detail, result: 'RUN_EVIDENCE_MISMATCH' } };
  }
  if (run.status === 'completed' && run.conclusion !== 'success' && run.conclusion !== 'skipped') {
    return { exitCode: 4, detail: { ...detail, result: 'RUN_FAILED' } };
  }
  if (run.status !== 'completed' || !cycle || cycle.conclusion === 'skipped' || cycle.status !== 'completed') {
    return { exitCode: 1, detail: { ...detail, result: 'RUN_NOT_EXECUTED' } };
  }
  if (run.conclusion !== 'success' || job?.conclusion !== 'success' || cycle.conclusion !== 'success' || !cycle.started_at || !cycle.completed_at) {
    return { exitCode: 4, detail: { ...detail, result: 'RUN_FAILED' } };
  }
  if (request.mode === 'commands' && [
    'Execute one complete cycle and await each GitHub snapshot save', 'Check model secret without displaying values',
  ].some(name => job.steps.find(step => step.name === name)?.conclusion !== 'skipped')) {
    return { exitCode: 4, detail: { ...detail, result: 'MODE_UNVERIFIED' } };
  }
  const log = await github.jobLog(repository, { runId: request.id, attempt: request.attempt, jobId: job.id });
  const checkoutStep = job.steps.find(step => step.name.startsWith('Run actions/checkout@'));
  // gh can emit UNKNOWN STEP. Admit those lines only within checkout's API time window.
  let checkoutUsesTimeWindow = false;
  const checkoutLog = log.split('\n').flatMap(line => {
    const [jobName, stepName, ...content] = line.split('\t');
    if (jobName !== job.name) return [];
    const text = content.join('\t');
    if (stepName === checkoutStep?.name) return [text];
    if (stepName === 'UNKNOWN STEP' && checkoutStep?.started_at && checkoutStep.completed_at) {
      const at = Date.parse(text.split(/\s/)[0] ?? '');
      // The jobs API truncates times to seconds; log timestamps retain fractions.
      if (at >= Date.parse(checkoutStep.started_at) && at < Date.parse(checkoutStep.completed_at) + 1000) {
        checkoutUsesTimeWindow = true;
        return [text];
      }
    }
    return [];
  }).join('\n');
  const matches = [...checkoutLog.matchAll(/^\S+\s+[^\r\n]*\bgit log -1 --format=(?:'%H'|"%H"|%H)\r?\n\S+\s+([a-f0-9]{40})\s*$/gm)];
  const checkoutSha = matches.length === 1 ? matches[0]?.[1] : null;
  const verified = checkoutSha === request.checkout && checkoutStep?.conclusion === 'success';
  return { exitCode: verified ? 0 : 4, detail: { ...detail, checkoutSha, checkoutUsesTimeWindow, result: verified ? 'RUN_EXECUTED' : 'CHECKOUT_UNVERIFIED' } };
}
