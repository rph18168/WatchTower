import { z } from 'zod';
import type { CommandReport } from './io.ts';

const incidentSchema = z.object({
  id: z.string(), name: z.string(), status: z.string(),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
  components: z.array(z.object({ name: z.string() })),
});

async function readStatus(endpoint: 'summary' | 'incidents', fetchStatus: typeof fetch, now: () => Date) {
  const requestedAtUtc = now().toISOString();
  const url = `https://www.githubstatus.com/api/v2/${endpoint}.json?watchtower_check=${encodeURIComponent(requestedAtUtc)}`;
  const response = await fetchStatus(url, { headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error('Status query failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Status response exceeds limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const receivedAtUtc = now().toISOString();
  const date = response.headers.get('date');
  const ageHeader = response.headers.get('age');
  const ageSeconds = ageHeader !== null && /^\d+$/.test(ageHeader) ? Number(ageHeader) : null;
  const apparentAgeMs = date ? Date.parse(receivedAtUtc) - Date.parse(date) : NaN;
  const fresh = Number.isFinite(apparentAgeMs) && apparentAgeMs >= -60_000 && apparentAgeMs <= 300_000 &&
    (ageHeader === null || (ageSeconds !== null && ageSeconds <= 300));
  return {
    data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    http: { url, requestedAtUtc, receivedAtUtc, status: response.status, date, ageSeconds, fresh },
  };
}

export async function inspectPlatform(fetchStatus: typeof fetch, now: () => Date, since: string): Promise<CommandReport> {
  const summaryResponse = await readStatus('summary', fetchStatus, now);
  const summary = z.object({ status: z.object({ indicator: z.string(), description: z.string() }),
    components: z.array(z.object({ name: z.string(), status: z.string() })), incidents: z.array(incidentSchema) }).parse(summaryResponse.data);
  const historyResponse = await readStatus('incidents', fetchStatus, now);
  const history = z.object({ incidents: z.array(incidentSchema) }).parse(historyResponse.data);
  const fresh = summaryResponse.http.fresh && historyResponse.http.fresh;
  return { exitCode: fresh ? 0 : 4, detail: {
    result: fresh ? 'PLATFORM_CHECKED' : 'PLATFORM_FRESHNESS_UNVERIFIED', since,
    summary: { http: summaryResponse.http, status: summary.status,
      actionsStatus: summary.components.find(component => component.name === 'Actions')?.status ?? null, incidents: summary.incidents },
    history: { http: historyResponse.http, returnedCount: history.incidents.length,
      incidents: history.incidents.filter(incident => Date.parse(incident.created_at) >= Date.parse(since)) },
    limitation: 'Public status and the returned recent incident window do not establish per-workflow scheduler health.',
  } };
}
