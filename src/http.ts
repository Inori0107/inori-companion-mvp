import type { IncomingMessage, ServerResponse } from 'node:http';
import { Auth } from './auth.js';
import { Problem, day, feedbackTags, journalFor, object } from './domain.js';
import { canonSource } from './character.js';
import { cases, heldOut, reportWeights } from './evaluations.js';
import { makeProvider } from './provider.js';
import { Service } from './service.js';
import { localStore, supabaseStore, type Store } from './storage.js';

const bodyLimit = 4_000_000;
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage & { body?: unknown }) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Problem(415, '需要 JSON 格式。');
  if (Number(req.headers['content-length']) > bodyLimit) throw new Problem(413, '資料超過大小限制。');
  if (req.body !== undefined && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) return object(req.body);
  let raw: string;
  if (req.body !== undefined) raw = req.body.toString();
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > bodyLimit) throw new Problem(413, '資料超過大小限制。');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > bodyLimit) throw new Problem(413, '資料超過大小限制。');
  try { return object(JSON.parse(raw)); }
  catch { throw new Problem(400, 'JSON 格式不正確。'); }
}

type Options = { env?: NodeJS.ProcessEnv; store?: Store; provider?: typeof makeProvider; now?: () => Date };
export function apiHandler({ env = process.env, store, provider = makeProvider, now = () => new Date() }: Options = {}) {
  const cloudValues = [env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY,
    env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY];
  const cloud = cloudValues.every(Boolean) ? { url: cloudValues[0]!.replace(/\/$/, ''), anon: cloudValues[1]!, service: cloudValues[2]! } : undefined;
  const emails = (value?: string) => (value ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  const allowed = emails(env.ALLOWED_EMAILS);
  const origin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN) : null;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if ((env.VERCEL || cloudValues.some(Boolean)) && !cloud) throw new Error('請設定完整的 Supabase 環境變數。');
  if (cloud && (!allowed.length || !origin || (env.VERCEL && origin.protocol !== 'https:'))) {
    throw new Error('雲端模式需設定 APP_ORIGIN 及 ALLOWED_EMAILS。');
  }
  if (!cloud && env.OPENAI_API_KEY && origin && !localHosts.has(origin.hostname)) throw new Error('外網 AI 模式需使用 Supabase Auth。');
  const auth = new Auth(cloud, allowed, emails(env.ADMIN_EMAILS), origin?.protocol === 'https:');
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  const models = [...new Set([model, 'mock', ...(env.ADMIN_MODELS ?? '').split(',').map(model => model.trim()).filter(Boolean)])];
  const limit = Math.max(1, Math.min(200, Number.parseInt(env.MAX_AI_PER_DAY ?? '', 10) || 60));
  const service = new Service(store ?? (cloud ? supabaseStore(cloud) : localStore(env.INORI_DATA_DIR || '.inori-data')),
    (name?: string) => name === 'mock' ? provider() : provider(env.OPENAI_API_KEY, name || model), limit, models, now);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let streaming = false;
    function frame(payload: unknown) {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(payload) + '\n');
    }
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      const route = url.pathname;
      const method = req.method;
      if (method === 'GET' && route === '/api/health') return send(res, 200, {
        ok: true, aiConfigured: Boolean(env.OPENAI_API_KEY), cloud: Boolean(cloud), portraitDelivery: 'session-json',
      });
      if (method === 'GET' && route === '/api/widget') {
        const token = req.headers.authorization?.match(/^Bearer ([\w-]{43})$/)?.[1];
        if (!token) throw new Problem(401, '需要有效的小工具憑證。');
        return send(res, 200, await service.widget(token));
      }
      if (method !== 'GET' && method !== 'POST') throw new Problem(405, '此方法不受支援。');

      let requestOrigin: URL;
      try { requestOrigin = new URL((origin?.protocol ?? 'http:') + '//' + req.headers.host); }
      catch { throw new Problem(403, '來源不正確。'); }
      const localAllowed = localHosts.has(requestOrigin.hostname) && (!env.OPENAI_API_KEY ||
        ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''));
      if (cloud ? requestOrigin.origin !== origin!.origin : (!localAllowed && requestOrigin.origin !== origin?.origin)) {
        throw new Problem(403, '來源不正確。');
      }
      if (!cloud && env.OPENAI_API_KEY && !localAllowed) throw new Problem(403, '本機 AI 僅接受此電腦的請求。');
      if (method === 'POST' && req.headers.origin !== requestOrigin.origin) throw new Problem(403, '來源不正確。');
      if (method === 'POST' && route === '/api/login') {
        const user = await auth.login(await readJson(req), res);
        return send(res, 200, { email: user.email, admin: user.admin });
      }
      const expectedAccount = req.headers['x-inori-account'];
      if (method === 'POST' && route === '/api/logout' && expectedAccount === undefined) {
        await auth.logout(req, res);
        return send(res, 200, { ok: true });
      }
      const user = await auth.user(req, res);
      const key = user.key;
      if (method === 'GET' && route === '/api/session') {
        return send(res, 200, { accountId: key, email: user.email, admin: user.admin, feedbackTags, ...await service.session(key) });
      }
      if (expectedAccount !== undefined && expectedAccount !== key) {
        throw new Problem(401, '此瀏覽器的登入帳號已切換。請重新開啟房間。');
      }
      if (method === 'POST' && route === '/api/logout') {
        await auth.logout(req, res);
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && route === '/api/portrait') {
        const image = await service.portrait(key, url.searchParams.get('id'));
        return send(res, 200, { image: 'data:' + image.mime + ';base64,' + image.bytes.toString('base64') });
      }
      if (method === 'GET' && route.startsWith('/api/portraits/')) {
        const image = await service.portrait(key, route.slice('/api/portraits/'.length));
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length });
        res.end(image.bytes);
        return;
      }
      if (method === 'GET' && route === '/api/design') return send(res, 200, await service.shareDesign(key));
      if (method === 'POST' && (route === '/api/design-preview' || route === '/api/design/preview')) return send(res, 200, service.previewDesign(await readJson(req)));
      if (method === 'GET' && route === '/api/export') return send(res, 200, await service.export(key));
      if (method === 'GET' && route === '/api/diary') return send(res, 200, journalFor(await service.read(key), day(url.searchParams.get('date'))));
      if (method === 'POST' && route === '/api/diary') return send(res, 200, await service.diary(key, await readJson(req)));
      if (method === 'POST' && route === '/api/state') return send(res, 200, await service.update(key, await readJson(req)));
      if (method === 'POST' && route === '/api/chat') {
        const input = await readJson(req);
        if (!req.headers.accept?.includes('application/x-ndjson')) return send(res, 200, await service.chat(key, input));
        const result = await service.chat(key, input, text => {
          if (!streaming) {
            streaming = true;
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          }
          frame({ delta: text });
        });
        if (!streaming) return send(res, 200, result);
        frame({ result });
        res.end();
        return;
      }
      if (route.startsWith('/api/studio')) {
        if (!user.admin) throw new Problem(403, '此頁面僅限管理者。');
        if (!cloud && !localAllowed) throw new Problem(403, '本機校調僅可在此電腦操作。');
        if (method === 'GET' && route === '/api/studio') {
          const studio = await service.studio();
          return send(res, 200, {
            ...studio, accountId: key, models, feedbackTags, source: canonSource, weights: reportWeights,
            cases: [...cases, ...heldOut].map(({ required, forbidden, ...item }) => item),
          });
        }
        if (method === 'POST' && route === '/api/studio') return send(res, 200, await service.saveStudio(await readJson(req)));
        if (method === 'POST' && (route === '/api/studio-run' || route === '/api/studio/run')) return send(res, 200, await service.run(key, await readJson(req)));
      }
      throw new Problem(404, '找不到此功能。');
    } catch (error) {
      const status = error instanceof Problem ? error.status : 503;
      const message = error instanceof Problem ? error.message : '服務暫時無法使用，請稍後再試。';
      if (res.destroyed || res.writableEnded) return;
      if (streaming) {
        frame({ error: message, status });
        res.end();
      } else send(res, status, { error: message });
    }
  };
}
