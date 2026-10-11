import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { AppError, JobStore, MAX_JOBS, assistantDraft, localDraft, validateDraft } from '../lib.js';
import { createApp } from '../server.js';

const draft = { name: 'Report', copies: 2, pages: 10, color: 'mono', paper: 'A4', duplex: true };
function directory(t) {
  // Keep all disposable fixtures inside the repository, never in shared OS temp directories.
  const dir = mkdtempSync(join(process.cwd(), '.test-data-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function app(t, options = {}) {
  const dataDir = directory(t);
  const server = createApp({ dataDir, apiKey: '', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { server, base, call, dataDir };
}
function providerResponse(value = draft, overrides = {}) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...overrides }],
  }));
}

test('draft schema accepts normalized valid settings and rejects malformed values', () => {
  assert.equal(validateDraft({ ...draft, name: ' Report ' }).name, 'Report');
  const bad = [
    null, [], {}, { ...draft, extra: true }, { ...draft, copies: '2' },
    { ...draft, copies: 0 }, { ...draft, copies: -1 }, { ...draft, copies: 1000 },
    { ...draft, pages: 1.5 }, { ...draft, pages: Infinity }, { ...draft, pages: 0 },
    { ...draft, color: 'rgb' }, { ...draft, paper: 'A3' }, { ...draft, duplex: 'true' },
    { ...draft, name: '' }, { ...draft, name: ' '.repeat(120) }, { ...draft, name: 'x'.repeat(121) },
    { ...draft, name: 'bad\nname' }, { ...draft, name: '\u0000' },
  ];
  for (const value of bad) assert.throws(() => validateDraft(value), AppError);
  assert.equal(validateDraft({ ...draft, copies: 999, pages: 999 }).copies, 999);
});

test('local rules parse only explicit settings and do not create jobs', () => {
  const result = localDraft('Print "Quarterly report", 3 copies, 12 pages, color, Letter, double-sided');
  assert.equal(result.mode, 'local');
  assert.deepEqual(result.draft, { name: 'Quarterly report', copies: 3, pages: 12, color: 'color', paper: 'Letter', duplex: true });
  assert.match(result.warnings[0], /not an LLM/);
  assert.deepEqual(localDraft('Print “Color Letter 50 pages”, 1 copies, 5 pages, no color, A4, no duplex').draft,
    { name: 'Color Letter 50 pages', copies: 1, pages: 5, color: 'mono', paper: 'A4', duplex: false });
  const defaults = localDraft('Print my report');
  assert.equal(defaults.draft.name, 'Untitled document');
  assert.equal(defaults.warnings.length, 7);
  assert.ok(localDraft('"Report" pages 1-5 landscape').warnings.some(value => value.includes('not supported')));
});

test('local rules reject ambiguity, unsupported numeric values and invalid prompts', () => {
  for (const prompt of [
    '"Report" 2 copies 3 copies', '"Report" mono color', '"Report" A4 Letter',
    '"Report" single-sided duplex', '"Report" 0 copies', '"Report" -1 pages',
    '"Report" 1.5 copies', '"Report" 1000 pages', '', '  ', 'x'.repeat(2001), '\u0000',
  ]) assert.throws(() => localDraft(prompt), AppError, prompt);
});

test('job storage persists validated transitions across reloads', t => {
  const dir = directory(t);
  const store = new JobStore(dir);
  const first = store.create(draft);
  const second = store.create({ ...draft, name: '<img src=x onerror=alert(1)>' });
  assert.equal(first.status, 'queued');
  assert.equal(store.list()[0].id, second.id);
  assert.equal(store.list('queued').length, 2);
  const copy = store.list()[0];
  copy.name = 'Changed';
  assert.notEqual(store.list()[0].name, copy.name);
  assert.throws(() => store.update(first.id, 'completed'), /Cannot change/);
  assert.throws(() => store.update(first.id, 'queued'), /Cannot change/);
  store.update(first.id, 'processing');
  store.update(first.id, 'completed');
  store.update(second.id, 'cancelled');
  assert.throws(() => store.update(first.id, 'processing'), /Cannot change/);
  assert.throws(() => store.update(second.id, 'queued'), /Cannot change/);
  assert.throws(() => store.update(first.id, '__proto__'), /Unknown status/);
  assert.throws(() => store.update('missing', 'cancelled'), /not found/);
  assert.deepEqual(new JobStore(dir).list(), store.list());
  assert.equal(JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')).version, 1);
  assert.deepEqual(readdirSync(dir), ['jobs.json']);
});

test('processing jobs can be cancelled and terminal jobs cannot be changed', t => {
  const store = new JobStore(directory(t));
  const job = store.create(draft);
  store.update(job.id, 'processing');
  store.update(job.id, 'cancelled');
  for (const status of ['queued', 'processing', 'completed', 'cancelled']) {
    assert.throws(() => store.update(job.id, status), AppError);
  }
});

test('failed atomic save does not update in-memory data or leave pending files', t => {
  const dir = directory(t);
  const store = new JobStore(dir);
  const before = store.create(draft);
  const original = readFileSync(join(dir, 'jobs.json'), 'utf8');
  store.file = join(dir, 'blocked');
  mkdirSync(store.file);
  assert.throws(() => store.update(before.id, 'processing'));
  assert.equal(store.list()[0].status, 'queued');
  assert.equal(readFileSync(join(dir, 'jobs.json'), 'utf8'), original);
  assert.ok(!readdirSync(dir).some(file => file.endsWith('.pending')));
});

test('invalid persisted data fails closed without overwriting it', t => {
  const dir = directory(t);
  const invalid = [
    'broken JSON', JSON.stringify([]), JSON.stringify({ version: 2, jobs: [] }),
    JSON.stringify({ version: 1, jobs: [draft] }),
    JSON.stringify({ version: 1, jobs: Array(MAX_JOBS + 1).fill(draft) }),
  ];
  for (const content of invalid) {
    writeFileSync(join(dir, 'jobs.json'), content);
    assert.throws(() => new JobStore(dir));
    assert.equal(readFileSync(join(dir, 'jobs.json'), 'utf8'), content);
  }
});

test('saved job identities, statuses, timestamps and draft fields are checked', t => {
  const dir = directory(t);
  const store = new JobStore(dir);
  const job = store.create(draft);
  const invalidJobs = [
    [{ ...job, id: '-'.repeat(36) }], [{ ...job, status: ['queued'] }],
    [{ ...job, status: 'unknown' }], [{ ...job, createdAt: 'yesterday' }],
    [{ ...job, duplex: 'true' }], [{ ...job, copies: 0 }], [job, job],
  ];
  for (const jobs of invalidJobs) {
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ version: 1, jobs }));
    assert.throws(() => new JobStore(dir));
  }
});

test('storage is bounded at 1000 jobs', t => {
  const dir = directory(t);
  const store = new JobStore(dir);
  const job = store.create(draft);
  const saved = Array.from({ length: MAX_JOBS }, (_, index) => ({ ...job, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ version: 1, jobs: saved }));
  const full = new JobStore(dir);
  assert.throws(() => full.create(draft), error => error.status === 409);
  assert.equal(full.list().length, MAX_JOBS);
});

test('API creates, lists, filters and updates jobs; assistant draft is not submitted', async t => {
  const { call, dataDir } = await app(t);
  assert.deepEqual((await call('/api/config')).body, { assistantMode: 'local', printingEnabled: false });
  assert.deepEqual((await call('/api/jobs')).body, { jobs: [] });
  const proposed = await call('/api/assistant', 'POST', { prompt: '"Report" 2 copies 10 pages duplex' });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.mode, 'local');
  assert.deepEqual((await call('/api/jobs')).body.jobs, []);
  const created = await call('/api/jobs', 'POST', proposed.body.draft);
  assert.equal(created.status, 201);
  const id = created.body.job.id;
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'completed' })).status, 409);
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'processing' })).status, 200);
  assert.equal((await call('/api/jobs?status=queued')).body.jobs.length, 0);
  assert.equal((await call('/api/jobs?status=processing')).body.jobs.length, 1);
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'completed' })).status, 200);
  assert.equal((await call(`/api/jobs/${id}/status`, 'PATCH', { status: 'cancelled' })).status, 409);
  assert.equal(new JobStore(dataDir).list()[0].status, 'completed');
});

test('API validates bodies, status filters, content types and methods', async t => {
  const { call, base } = await app(t);
  assert.equal((await call('/api/jobs', 'POST', { ...draft, extra: true })).status, 400);
  assert.equal((await call('/api/jobs', 'POST', { ...draft, duplex: 1 })).status, 400);
  assert.equal((await call('/api/assistant', 'POST', { prompt: 'Report', extra: true })).status, 400);
  assert.equal((await call('/api/assistant', 'POST', { prompt: 'x'.repeat(2001) })).status, 400);
  assert.equal((await call('/api/jobs?status=__proto__')).status, 400);
  assert.equal((await call('/api/jobs?status=')).status, 400);
  assert.equal((await call('/api/jobs', 'POST', draft, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await call('/api/jobs', 'POST', { name: 'x'.repeat(9000) })).status, 413);
  const missing = '/api/jobs/00000000-0000-4000-8000-000000000000/status';
  assert.equal((await call(missing, 'PATCH', { status: 'cancelled' })).status, 404);
  assert.equal((await call(missing, 'PATCH', { status: 'queued', extra: true })).status, 400);
  for (const [path, method] of [['/api/jobs', 'DELETE'], ['/api/config', 'POST'], ['/api/assistant', 'GET'], [missing, 'GET']]) {
    const result = await call(path, method);
    assert.equal(result.status, 405);
    assert.ok(result.headers.get('allow'));
  }
});

test('same-origin writes are allowed, foreign origins, fetch sites and hosts rejected', async t => {
  const { base, call } = await app(t);
  assert.equal((await call('/api/jobs', 'POST', draft, { Origin: base })).status, 201);
  for (const headers of [
    { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) assert.equal((await call('/api/jobs', 'POST', draft, headers)).status, 403, JSON.stringify(headers));
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(base + '/api/jobs', { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = request(base + '/api/jobs', { headers: { Host: '127.0.0.1:invalid-port' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(invalidHost, 400);
  assert.equal((await call('/api/jobs')).body.jobs.length, 1);
});

test('only known assets are served and security headers prohibit unsafe execution', async t => {
  const { base, call } = await app(t);
  for (const path of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.text()).length > 0);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await call(path, 'POST', {})).status, 405);
  }
  for (const path of ['/README.md', '/package.json', '/.env', '/data/jobs.json', '/%2e%2e/lib.js', '/public/app.js', '/favicon.ico']) {
    assert.equal((await call(path)).status, 404);
  }
  const script = await (await fetch(base + '/app.js')).text();
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
});

test('OpenAI integration uses server-side credentials and validates structured response', async () => {
  let invocation;
  const result = await assistantDraft('Print Report', {
    apiKey: 'test-provider-credential', model: 'test-model',
    fetchImpl: async (url, options) => { invocation = { url, options }; return providerResponse(); },
  });
  assert.equal(result.mode, 'openai');
  assert.deepEqual(result.draft, draft);
  assert.equal(invocation.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(invocation.options.headers.Authorization, 'Bearer ' + 'test-provider-credential');
  assert.ok(invocation.options.signal instanceof AbortSignal);
  const payload = JSON.parse(invocation.options.body);
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.response_format.json_schema.strict, true);
  assert.equal(payload.messages[1].content, 'Print Report');
  assert.ok(!JSON.stringify(result).includes('test-provider-credential'));
});

test('provider failure, refusal, invalid schema, oversize and malformed JSON fail safely', async () => {
  const failures = [
    () => new Response('credential secret error', { status: 401 }),
    () => new Response('not JSON'),
    () => new Response(JSON.stringify({ choices: [] })),
    () => providerResponse(draft, { finish_reason: 'length' }),
    () => providerResponse(draft, { message: { refusal: 'No' } }),
    () => providerResponse({ ...draft, copies: '2' }),
    () => providerResponse({ ...draft, extra: true }),
    () => new Response('x'.repeat(32001)),
    () => new Response('é'.repeat(16001)),
    () => new Response(null),
    () => { throw new Error('sensitive upstream error'); },
  ];
  for (const failure of failures) {
    await assert.rejects(assistantDraft('Print report', { apiKey: 'test-provider-credential', fetchImpl: async () => failure() }), error => {
      assert.equal(error.status, 502);
      assert.match(error.message, /No job was created/);
      assert.doesNotMatch(error.message, /credential|secret|sensitive/);
      return true;
    });
  }
});

test('provider timeout is bounded with an abort signal', async () => {
  const keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(assistantDraft('Print report', {
      apiKey: 'test-provider-credential', timeout: 10,
      fetchImpl: async (_, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }), error => error.status === 502);
  } finally {
    clearTimeout(keeper);
  }
});

test('provider API failure never leaks secrets or falls back pretending to succeed', async t => {
  const { call } = await app(t, {
    apiKey: 'test-provider-credential',
    fetchImpl: async () => new Response('secret-provider-details', { status: 500 }),
  });
  assert.equal((await call('/api/config')).body.assistantMode, 'openai');
  const result = await call('/api/assistant', 'POST', { prompt: 'Report' });
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /secret-provider|test-provider/);
  assert.deepEqual((await call('/api/jobs')).body.jobs, []);
});

test('one provider request at a time prevents unbounded upstream work', async t => {
  let release;
  const started = new Promise(resolve => {
    release = resolve;
  });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { call } = await app(t, {
    apiKey: 'test-provider-credential',
    fetchImpl: async () => { release(); await pending; return providerResponse(); },
  });
  const first = call('/api/assistant', 'POST', { prompt: 'Report' });
  await started;
  const second = await call('/api/assistant', 'POST', { prompt: 'Report' });
  assert.equal(second.status, 429);
  finish();
  assert.equal((await first).status, 200);
});

test('streamed request bodies are bounded even without Content-Length', async t => {
  const { base } = await app(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(base + '/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
    req.write('{"name":"' + 'x'.repeat(9000));
    req.end('"}');
  });
  assert.equal(status, 413);
});
