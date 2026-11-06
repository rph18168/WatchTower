// Temporary, credential-free Actions probe. No model, Telegram or state writes.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { fetch as sourceFetch } from 'undici';
import { createSourceReader } from '../../src/adapters/source-reader.ts';

const targets = [
  { id: '50323848', url: 'https://github.com/l0ng-ai/openidea' },
  { id: '50327240', url: 'https://huggingface.co/burner22/numbat' },
  { id: '50366863', url: 'https://openai.com/index/openai-to-acquire-pierre/' },
];
const ranges = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 3, 'ipv6'], ['4000::', 2, 'ipv6'], ['8000::', 1, 'ipv6'], ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'], ['3fff::', 20, 'ipv6'],
].map(([address, prefix, family]) => {
  const block = new BlockList();
  block.addSubnet(address, prefix, family);
  return { name: address + '/' + prefix, block };
});
function describeUrl(value) {
  const u = new URL(value);
  return { host: u.hostname, scheme: u.protocol, length: value.length, normalizedLength: u.href.length,
    hasCredentials: Boolean(u.username || u.password), port: u.port };
}
function safeError(error) {
  return { name: ['TypeError', 'Error', 'SourceReadError'].includes(error?.name) ? error.name : 'other',
    code: /^[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : null,
    causeCode: /^[A-Z_]{1,64}$/.test(error?.cause?.code ?? '') ? error.cause.code : null };
}
const results = [];
for (const target of targets) {
  const trace = [];
  const reader = createSourceReader({
    lookup: async hostname => {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      trace.push({ phase: 'dns', hostname, addresses: addresses.map(({ address, family }) => {
        const blockedBy = ranges.filter(r => r.block.check(address, family === 6 ? 'ipv6' : 'ipv4')).map(r => r.name);
        return { address: blockedBy.length ? '<REDACTED>' : address, family, parsedFamily: isIP(address), blockedBy };
      }) });
      return addresses;
    },
    fetch: async (input, init) => {
      trace.push({ phase: 'request', ...describeUrl(String(input)) });
      try {
        const response = await sourceFetch(input, init);
        const location = response.headers.get('location');
        trace.push({ phase: 'response', status: response.status,
          redirect: location ? describeUrl(new URL(location, input).href) : null });
        return response;
      } catch (error) {
        trace.push({ phase: 'transport-error', ...safeError(error) });
        throw error;
      }
    },
  });
  const result = await reader.read({ candidateId: target.id, url: target.url });
  results.push({ candidateId: target.id, urlSha256: createHash('sha256').update(target.url).digest('hex'),
    initialUrl: describeUrl(target.url), trace, status: result.status,
    failureCode: result.failureCode ?? null, characters: result.text.length, truncated: result.truncated });
}
const verdict = results.some(r => r.failureCode === 'unsafe-url') ? 'FAIL_UNSAFE_PUBLIC_SOURCE'
  : results.some(r => r.status === 'read') ? 'PASS_SOURCE_ACCESS' : 'FAIL_NO_READABLE_SOURCE';
console.log('[DEBUG-news-source] ' + JSON.stringify({ checkedAtUtc: new Date().toISOString(),
  environment: { actions: process.env.GITHUB_ACTIONS === 'true', platform: process.platform,
    node: process.version, sha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null }, verdict, results }));
process.exitCode = verdict === 'PASS_SOURCE_ACCESS' ? 0 : 1;
