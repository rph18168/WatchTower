import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Parser } from 'htmlparser2';
import { Agent, fetch as sourceFetch } from 'undici';
import type { SourceEvidence, SourceReaderAdapter } from '../types.ts';

const MAX_BYTES = 1_048_576;
// Leave room for topics, metadata, instructions and schema under the 64k input default.
const MAX_TEXT = 12_000;
const MAX_TIME_MS = 12_000;
const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
// BlockList also matches IPv4 through ::ffff:0:0/96. A blanket ::/3 rule
// therefore rejects every IPv4 address. Leave that mapped interval to the
// IPv4 rules above, while denying the rest of the non-global IPv6 range.
denied.addRange('::', '::fffe:ffff:ffff', 'ipv6');
denied.addRange('::1:0:0:0', '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ipv6');
// Permit only global unicast native IPv6, excluding special/transition ranges.
for (const [address, prefix] of [
  ['4000::', 2], ['8000::', 1], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied.addSubnet(address, prefix, 'ipv6');

class SourceReadError extends Error {
  readonly code: NonNullable<SourceEvidence['failureCode']>;
  constructor(code: NonNullable<SourceEvidence['failureCode']>) {
    super('Bounded source read unavailable');
    this.code = code;
  }
}

function checkedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SourceReadError('unsafe-url'); }
  if (value.length > 2048 || url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new SourceReadError('unsafe-url');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new SourceReadError('unsafe-url');
  if (isIP(hostname) && denied.check(hostname, isIP(hostname) === 6 ? 'ipv6' : 'ipv4')) {
    throw new SourceReadError('unsafe-url');
  }
  url.hash = '';
  return url;
}

/** Limited to one stored candidate link and at most three redirects; no crawling. */
export function createSourceReader(options: {
  /** External DNS seam; every returned address is checked by the socket lookup. */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  /** External HTTP protocol seam. Production uses pinned Undici with the guarded Agent. */
  fetch?: typeof fetch;
  limits?: { maxBytes?: number; maxTextCharacters?: number; totalMs?: number };
} = {}): SourceReaderAdapter {
  const maxBytes = boundedLimit(options.limits?.maxBytes, MAX_BYTES);
  const maxText = boundedLimit(options.limits?.maxTextCharacters, MAX_TEXT);
  const totalMs = boundedLimit(options.limits?.totalMs, MAX_TIME_MS);
  const resolve = options.lookup ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  return {
    async read({ candidateId, url: originalUrl }) {
      const evidence: SourceEvidence = { id: `source:${candidateId}`, candidateId, originalUrl, status: 'unavailable', title: '', text: '', truncated: false };
      const controller = new AbortController();
      let deniedConnection = false;
      // The deadline covers headers AND every body chunk, shared by all redirects.
      const timer = setTimeout(() => controller.abort(), totalMs);
      const dispatcher = new Agent({
        connections: 1, pipelining: 1,
        headersTimeout: Math.min(4000, totalMs), bodyTimeout: Math.min(4000, totalMs), maxResponseSize: maxBytes,
        connect: {
          timeout: Math.min(3000, totalMs), blockList: denied,
          lookup(hostname, lookupOptions, callback) {
            // This result goes to the socket itself: there is no second DNS lookup.
            void resolve(hostname).then((addresses) => {
              if (addresses.length === 0 || addresses.some(({ address, family }) => ![4, 6].includes(family) || isIP(address) !== family || denied.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
                deniedConnection = true;
                callback(new SourceReadError('unsafe-url'), '', 4);
                return;
              }
              if (lookupOptions.all) callback(null, addresses);
              else {
                const address = addresses.find((address) => !lookupOptions.family || address.family === lookupOptions.family);
                if (!address) callback(new SourceReadError('unsafe-url'), '', 4);
                else callback(null, address.address, address.family);
              }
            }, () => callback(new SourceReadError('network'), '', 4));
          },
        },
      });
      try {
        let current = checkedUrl(originalUrl);
        const visited = new Set<string>();
        for (let redirects = 0; ; redirects++) {
          if (visited.has(current.href)) throw new SourceReadError('redirect');
          visited.add(current.href);
          evidence.finalUrl = current.href;
          const init = {
            method: 'GET' as const, redirect: 'manual' as const, signal: controller.signal, dispatcher,
            headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': 'WatchTower/0.1 bounded-source-reader' },
          };
          const response = options.fetch
            ? await abortable(options.fetch(current, init), controller.signal)
            : await abortable(sourceFetch(current, init), controller.signal);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await cancelBody(response, controller.signal);
            const location = response.headers.get('location');
            if (!location || redirects >= 3) throw new SourceReadError('redirect');
            try { current = checkedUrl(new URL(location, current).href); }
            catch (error) { throw error instanceof SourceReadError ? error : new SourceReadError('redirect'); }
            continue;
          }
          if (!response.ok) { await cancelBody(response, controller.signal); throw new SourceReadError('network'); }
          const contentType = response.headers.get('content-type') ?? '';
          const mime = contentType.split(';')[0]!.trim().toLowerCase();
          const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]?.toLowerCase();
          const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
          if (!['text/html', 'text/plain'].includes(mime) || (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) || (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding))) {
            await cancelBody(response, controller.signal);
            throw new SourceReadError('unsupported-content');
          }
          const declaredLength = Number(response.headers.get('content-length'));
          if (declaredLength > maxBytes) { await cancelBody(response, controller.signal); throw new SourceReadError('too-large'); }
          const body = await readBoundedBody(response, maxBytes, controller.signal);
          const extracted = mime === 'text/html' ? extractHtml(body, maxText) : { title: '', text: normalize(body).slice(0, maxText), truncated: normalize(body).length > maxText };
          if (!extracted.text) throw new SourceReadError('empty');
          return { ...evidence, ...extracted, finalUrl: current.href, status: 'read' };
        }
      } catch (error) {
        // Neither raw transport errors nor arbitrary source text enters diagnostics.
        return { ...evidence, failureCode: controller.signal.aborted ? 'timeout' : deniedConnection ? 'unsafe-url' : error instanceof SourceReadError ? error.code : 'network' };
      } finally {
        clearTimeout(timer);
        controller.abort();
        await dispatcher.destroy();
      }
    },
  };
}

async function cancelBody(response: { body: { cancel(): Promise<void> } | null }, signal: AbortSignal): Promise<void> {
  if (response.body) await abortable(response.body.cancel(), signal);
}

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('Invalid bounded source-reader limit');
  return value;
}

async function readBoundedBody(response: { body: { getReader(): {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
} } | null }, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new SourceReadError('empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      if (!result.value) throw new SourceReadError('network');
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new SourceReadError('too-large');
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SourceReadError('timeout'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function normalize(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function extractHtml(html: string, maxText: number): { title: string; text: string; truncated: boolean } {
  const excluded = new Set(['script', 'style', 'noscript', 'template']);
  let suppressed = 0;
  let inTitle = false;
  let title = '';
  let text = '';
  let truncated = false;
  const parser = new Parser({
    onopentag(name) {
      if (excluded.has(name)) suppressed++;
      if (name === 'title') inTitle = true;
      if (!suppressed && ['p', 'div', 'br', 'article', 'section', 'li', 'h1', 'h2', 'h3'].includes(name)) text += ' ';
    },
    ontext(value) {
      if (suppressed) return;
      if (inTitle) title = (title + value).slice(0, 256);
      const normalized = value.replace(/\s+/g, ' ');
      if (text.length + normalized.length > maxText) truncated = true;
      text += normalized.slice(0, Math.max(0, maxText + 1 - text.length));
    },
    onclosetag(name) {
      if (excluded.has(name)) suppressed = Math.max(0, suppressed - 1);
      if (name === 'title') inTitle = false;
      if (!suppressed) text += ' ';
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  return { title: normalize(title), text: normalize(text).slice(0, maxText), truncated: truncated || normalize(text).length > maxText };
}
