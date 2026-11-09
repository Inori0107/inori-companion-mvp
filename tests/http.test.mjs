import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { apiHandler } from '../dist/http.js';
import { localStore } from '../dist/storage.js';

const fakeOrigin = 'http://127.0.0.1:3000';
function call(handler, url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    url, method: body === undefined ? 'GET' : 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3000', origin: fakeOrigin, 'content-type': 'application/json', ...headers },
  });
  const result = { status: 200, headers: {}, frames: '' };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); },
    write(chunk) { result.frames += chunk; },
    end(chunk = '') {
      if (Buffer.isBuffer(chunk)) result.image = chunk;
      else result.frames += chunk;
    },
  };
  return handler(req, res).then(() => {
    if (result.image) return result;
    const json = result.headers['Content-Type']?.includes('ndjson')
      ? result.frames.trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(result.frames);
    return { ...result, json };
  });
}

test('Mock HTTP 路徑支援串流、再生成、備份與最小權限 Widget', async () => {
  let now = new Date('2026-11-09T06:00:00Z');
  const handler = apiHandler({ env: {}, store: localStore(), now: () => now });
  assert.equal((await call(handler, '/api/health')).json.aiConfigured, false);
  assert.equal((await call(handler, '/api/chat', { id: randomUUID(), message: '早安' }, { origin: 'http://wrong.test' })).status, 403);
  const first = await call(handler, '/api/chat', { id: randomUUID(), message: '早安，祈' }, { accept: 'application/x-ndjson' });
  assert.equal(first.status, 200);
  assert.match(first.json[0].delta, /早安/);
  const original = first.json.at(-1).result.messages.at(-1);
  now = new Date(now.getTime() + 1000);
  const regenerated = await call(handler, '/api/chat', { id: randomUUID(), regenerate: original.id });
  assert.equal(regenerated.json.messages.length, 3);
  assert.notEqual(regenerated.json.messages.at(-1).id, original.id);
  const widget = await call(handler, '/api/state', { action: 'widget', enabled: true });
  const authorization = 'Bearer ' + widget.json.widgetToken;
  const read = await call(handler, '/api/widget', undefined, { authorization });
  assert.deepEqual(Object.keys(read.json).sort(), ['anniversary', 'days', 'greeting', 'mood', 'name']);
  const backup = await call(handler, '/api/export');
  assert.equal(backup.json.widgetHash, undefined);
  assert.equal(backup.json.messages.length, 3);
  await call(handler, '/api/state', { action: 'reset' });
  assert.equal((await call(handler, '/api/widget', undefined, { authorization })).status, 401);
  const restored = await call(handler, '/api/state', {
    action: 'import', consent: true, backup: { nickname: '澄', meetDate: '2026-10-01',
      messages: [{ role: 'user', content: '舊紀錄' }], memories: ['我喜歡合唱'], interactions: { '2026-10-02': ['sing'] } },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.memories[0].source, 'backup-v1');
  assert.equal(restored.json.events[0].legacy, true);
  assert.equal(restored.json.messages[0].content, '舊紀錄');
});

test('Supabase Auth / PostgREST 模擬整合，隔離帳號、重新登入、保護校調資料', async context => {
  const emails = ['admin@example.test', 'reader@example.test'];
  const people = emails.map(email => ({ id: randomUUID(), email, email_confirmed_at: '2026-01-01' }));
  const rows = new Map();
  const env = {
    SUPABASE_URL: 'https://project.supabase.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test',
    APP_ORIGIN: fakeOrigin, ALLOWED_EMAILS: emails.join(','), ADMIN_EMAILS: emails[0],
  };
  context.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.pathname.startsWith('/auth/')) {
      assert.equal(init.headers.apikey, 'sb_publishable_test');
      if (url.pathname.endsWith('/token')) {
        const user = people.find(row => row.email === body.email || 'refresh-' + row.id === body.refresh_token);
        if (!user) return Response.json({}, { status: 400 });
        if (body.email) assert.equal(body.password, ' p ass ');
        return Response.json({ access_token: 'access-' + user.id, refresh_token: 'refresh-' + user.id, expires_in: 3600, user });
      }
      if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
      const user = people.find(row => init.headers.Authorization === 'Bearer access-' + row.id);
      return user ? Response.json(user) : Response.json({}, { status: 401 });
    }
    assert.equal(init.headers.apikey, 'sb_secret_test');
    assert.equal(init.headers.Authorization, undefined);
    const key = url.searchParams.get('key')?.slice(3) ?? body?.key;
    const row = rows.get(key);
    if (init.method === 'POST') {
      if (row) return Response.json([]);
      rows.set(key, body);
      return Response.json([body]);
    }
    if (init.method === 'PATCH') {
      if ('eq.' + row?.revision !== url.searchParams.get('revision')) return Response.json([]);
      rows.set(key, { ...row, ...body });
      return Response.json([rows.get(key)]);
    }
    return Response.json(row ? [row] : []);
  });

  let handler = apiHandler({ env });
  assert.equal((await call(handler, '/api/session')).status, 401);
  async function signIn(email) {
    const res = await call(handler, '/api/login', { email, password: ' p ass ' });
    assert.equal(res.status, 200);
    const list = res.headers['Set-Cookie'];
    assert.ok(list.every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict')));
    return list.map(cookie => cookie.split(';')[0]);
  }
  const admin = await signIn(emails[0]);
  const reader = await signIn(emails[1]);
  const auth = values => ({ cookie: values.join('; ') });
  const create = await call(handler, '/api/state', { action: 'memory', type: 'core', content: '私有資料測試', importance: 4, consent: true }, auth(admin));
  assert.equal(create.status, 200);
  handler = apiHandler({ env });
  const otherDevice = await call(handler, '/api/session', undefined, auth([admin[1]]));
  assert.equal(otherDevice.json.memories[0].content, '私有資料測試');
  assert.ok(otherDevice.headers['Set-Cookie']);
  const otherUser = await call(handler, '/api/session', undefined, auth(reader));
  assert.deepEqual(otherUser.json.memories, []);
  assert.equal(otherUser.json.design.name, '楪祈');
  const draft = { base: 'original', name: '練習角色', greeting: '歡迎來到書房。' };
  const save = await call(handler, '/api/state', {
    action: 'design', expectedVersion: otherUser.json.designVersion, design: draft,
  }, { ...auth(reader), 'x-inori-account': otherUser.json.accountId });
  assert.equal(save.status, 200);
  assert.equal(save.json.design.name, draft.name);
  const png = await readFile(new URL('../public/icon-192.png', import.meta.url));
  const uploaded = await call(handler, '/api/state', {
    action: 'design', expectedVersion: save.json.designVersion, design: save.json.design,
    portraits: [{ name: '普通', kind: 'expression', value: '普通', image: 'data:image/png;base64,' + png.toString('base64') }],
  }, auth(reader));
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.json.context, save.json.context);
  const path = '/api/portraits/' + uploaded.json.portraits[0].id;
  const response = await call(handler, path, undefined, auth(reader));
  assert.equal(response.headers['Content-Type'], 'image/png');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.image, png);
  assert.equal((await call(handler, path, undefined, auth(admin))).status, 404);
  assert.equal((await call(handler, path)).status, 401);
  assert.equal((await call(handler, '/api/state', { action: 'reset' }, {
    ...auth(admin), 'x-inori-account': otherUser.json.accountId,
  })).status, 401);
  assert.equal((await call(handler, '/api/design', undefined, auth(admin))).json.design.name, '楪祈');
  assert.equal((await call(handler, '/api/design', undefined, auth(reader))).json.design.name, draft.name);
  assert.equal((await call(handler, '/api/session', undefined, auth(admin))).json.memories.length, 1);
  assert.equal((await call(handler, '/api/studio', undefined, auth(reader))).status, 403);
  assert.equal((await call(handler, '/api/studio', undefined, auth(admin))).json.cases.length, 52);
  const trial = await call(handler, '/api/studio/run', { id: randomUUID(), version: 'inori-character-v1.0', model: 'mock', caseId: 'P01' }, auth(admin));
  assert.equal(trial.status, 200);
  assert.doesNotMatch(JSON.stringify(trial.json), /私有資料測試/);
  const rated = await call(handler, '/api/studio', { action: 'rate', id: trial.json.id, score: 4, tags: [], suggestion: '合成評分' }, auth(admin));
  assert.equal(rated.json.runs[0].score, 4);
});
