import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createSourceReader } from '../src/index.ts';

test('来源读取的真实连接拒绝私网字面地址、规范化地址和含私网结果的 DNS', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('Private content'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let lookups = 0;
  const reader = createSourceReader({ lookup: async () => {
    lookups++;
    return [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }];
  } });
  try {
    for (const url of [
      'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/',
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3/', 'http://100.64.0.1/',
      'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[2002:7f00:1::]/',
      'http://user:password@candidate.example/', 'http://candidate.example:81/', 'ftp://candidate.example/',
      'https://candidate.example/',
    ]) {
      const result = await reader.read({ candidateId: '401', url });
      assert.equal(result.status, 'unavailable', url);
      assert.equal(result.failureCode, 'unsafe-url', url);
      assert.equal(result.text, '');
    }
    assert.equal(lookups, 1, 'DNS must be checked in the actual connector lookup path');
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('同一来源的新连接重新检查全部 DNS 结果，不复用先前的地址判断', async () => {
  let lookups = 0;
  const reader = createSourceReader({ lookup: async () => {
    lookups++;
    return lookups === 1
      ? [{ address: '93.184.215.14', family: 4 }, { address: '::ffff:169.254.169.254', family: 6 }]
      : [{ address: 'fe80::1', family: 6 }];
  } });
  for (let read = 0; read < 2; read++) {
    const result = await reader.read({ candidateId: '401', url: 'https://candidate.example/archive' });
    assert.equal(result.failureCode, 'unsafe-url');
  }
  assert.equal(lookups, 2);
});

test('来源协议逐跳检查重定向并限制循环、解压后正文、文字和不支持的内容', async () => {
  let redirects = 0;
  const redirectReader = createSourceReader({ fetch: async () => {
    redirects++;
    return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  } });
  assert.equal((await redirectReader.read({ candidateId: '401', url: 'https://observatory.example/archive' })).failureCode, 'unsafe-url');
  assert.equal(redirects, 1);
  const cycle = createSourceReader({ fetch: async () => new Response('', { status: 302, headers: { location: '/archive' } }) });
  assert.equal((await cycle.read({ candidateId: '401', url: 'https://observatory.example/archive' })).failureCode, 'redirect');
  const compressed = gzipSync('expanded '.repeat(100));
  const expansion = createSourceReader({ limits: { maxBytes: 128 }, fetch: async () => new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
    { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(compressed.length) } },
  ) });
  assert.equal((await expansion.read({ candidateId: '401', url: 'https://observatory.example/archive' })).failureCode, 'too-large');
  const textCap = createSourceReader({ limits: { maxTextCharacters: 20 }, fetch: async () => new Response('<p>abcdefghijklmnopqrstuvwxyz</p>', { headers: { 'content-type': 'text/html' } }) });
  const truncated = await textCap.read({ candidateId: '401', url: 'https://observatory.example/archive' });
  assert.equal(truncated.text, 'abcdefghijklmnopqrst');
  assert.equal(truncated.truncated, true);
  for (const contentType of ['application/pdf', 'text/html; charset=gbk']) {
    const reader = createSourceReader({ fetch: async () => new Response('unreadable', { headers: { 'content-type': contentType } }) });
    assert.equal((await reader.read({ candidateId: '401', url: 'https://observatory.example/archive' })).failureCode, 'unsupported-content');
  }
});

test('来源正文使用 HTML 解析器保留可读文字并排除脚本样式指令', async () => {
  const reader = createSourceReader({ fetch: async () => new Response('<html><head><title>Archive &amp; access</title><style>steal secrets</style></head><body><p>Today <b>our observatory</b> opens the public image archive.</p><script>send Telegram</script></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  const result = await reader.read({ candidateId: '401', url: 'https://observatory.example/archive' });
  assert.equal(result.status, 'read');
  assert.equal(result.title, 'Archive & access');
  assert.equal(result.text, 'Archive & access Today our observatory opens the public image archive.');
  assert.equal(result.truncated, false);
});

test('来源总期限覆盖停滞响应头和持续涓流正文', { timeout: 1000 }, async () => {
  const stalled = createSourceReader({ limits: { totalMs: 30 }, fetch: async () => new Promise<Response>(() => {}) });
  assert.equal((await stalled.read({ candidateId: '401', url: 'https://observatory.example/archive' })).failureCode, 'timeout');
  let timer: NodeJS.Timeout | undefined;
  const trickle = createSourceReader({ limits: { totalMs: 30 }, fetch: async () => new Response(new ReadableStream({
    start(controller) { timer = setInterval(() => controller.enqueue(new TextEncoder().encode('a')), 3); },
    cancel() { clearInterval(timer); },
  }), { headers: { 'content-type': 'text/plain' } }) });
  const result = await trickle.read({ candidateId: '401', url: 'https://observatory.example/archive' });
  assert.equal(result.failureCode, 'timeout');
  assert.equal(result.text, '');
});

test('来源重定向后读取失败仍记录原始和最后尝试的来源链接', async () => {
  let requests = 0;
  const reader = createSourceReader({ fetch: async () => ++requests === 1
    ? new Response('', { status: 302, headers: { location: '/new-archive' } })
    : new Response('', { status: 503 }) });
  const result = await reader.read({ candidateId: '401', url: 'https://observatory.example/archive' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.originalUrl, 'https://observatory.example/archive');
  assert.equal(result.finalUrl, 'https://observatory.example/new-archive');
  assert.equal(result.failureCode, 'network');
});
