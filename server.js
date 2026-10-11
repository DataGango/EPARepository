import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppError, JobStore, assistantDraft, exactObject, transitions } from './lib.js';

const BODY_LIMIT = 8192;
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
].map(([url, [file, type]]) => [url, { body: readFileSync(new URL(file, import.meta.url)), type }]));

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AppError('Content-Type must be application/json.', 415);
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw new AppError('Request body too large.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AppError('Request body too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('Invalid JSON body.');
  }
}

export function createApp({ dataDir = process.env.DATA_DIR || './data', apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL || 'gpt-4o-mini', fetchImpl = fetch, timeout = 15000,
  host = process.env.HOST || '127.0.0.1' } = {}) {
  const store = new JobStore(dataDir);
  let providerBusy = false;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      let base;
      try {
        base = new URL(`http://${req.headers.host}`);
      } catch {
        throw new AppError('Invalid Host header.');
      }
      const allowed = new Set(['localhost', '127.0.0.1', '[::1]', host === '::1' ? '[::1]' : host]);
      if (!allowed.has(base.hostname) || base.username || base.password) throw new AppError('Host not allowed.', 403);
      const url = new URL(req.url, base);
      if (url.origin !== base.origin) throw new AppError('Invalid request target.');
      const path = url.pathname;
      if (['POST', 'PATCH'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== base.origin) throw new AppError('Cross-origin writes are not allowed.', 403);
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw new AppError('Cross-origin writes are not allowed.', 403);
        }
      }
      if (assets.has(path)) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD');
          throw new AppError('Method not allowed.', 405);
        }
        const asset = assets.get(path);
        res.writeHead(200, { 'Content-Type': asset.type });
        return res.end(req.method === 'HEAD' ? undefined : asset.body);
      }
      if (path === '/api/config') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new AppError('Method not allowed.', 405);
        }
        return send(200, { assistantMode: apiKey ? 'openai' : 'local', printingEnabled: false });
      }
      if (path === '/api/jobs') {
        if (req.method === 'GET') {
          const status = url.searchParams.get('status');
          if (status !== null && !Object.hasOwn(transitions, status)) throw new AppError('Unknown status filter.');
          return send(200, { jobs: store.list(status) });
        }
        if (req.method === 'POST') return send(201, { job: store.create(await jsonBody(req)) });
        res.setHeader('Allow', 'GET, POST');
        throw new AppError('Method not allowed.', 405);
      }
      const jobRoute = path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/status$/i);
      if (jobRoute) {
        if (req.method !== 'PATCH') {
          res.setHeader('Allow', 'PATCH');
          throw new AppError('Method not allowed.', 405);
        }
        const body = await jsonBody(req);
        if (!exactObject(body, ['status'])) throw new AppError('Provide exactly one status field.');
        return send(200, { job: store.update(jobRoute[1], body.status) });
      }
      if (path === '/api/assistant') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          throw new AppError('Method not allowed.', 405);
        }
        const body = await jsonBody(req);
        if (!exactObject(body, ['prompt'])) throw new AppError('Provide exactly one prompt field.');
        if (providerBusy) throw new AppError('Assistant is busy. Try again shortly.', 429);
        providerBusy = true;
        try {
          return send(200, await assistantDraft(body.prompt, { apiKey, model, fetchImpl, timeout }));
        } finally {
          providerBusy = false;
        }
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (!res.destroyed) send(error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'The request could not be completed.',
      });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.timeout = 25000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer from 1 to 65535.');
    process.exitCode = 1;
  } else {
    try {
      const server = createApp({ host });
      server.on('error', () => { console.error('Server could not start. Check host, port and data directory.'); process.exitCode = 1; });
      server.listen(port, host, () => {
        console.log(`Print Desk: http://${host.includes(':') ? `[${host}]` : host}:${port}`);
        console.log('Planning only — no documents are uploaded and no physical printing occurs.');
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) console.warn('Warning: no authentication. Do not expose this app to a network.');
      });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
    } catch {
      console.error('Could not load the job store. Check DATA_DIR and jobs.json; existing data was not overwritten.');
      process.exitCode = 1;
    }
  }
}
