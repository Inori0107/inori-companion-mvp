import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../scriptable/InoriWidget.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const token = 'a'.repeat(43);

async function preview({ url = 'https://room.example.test', key = token, code = 200, response }) {
  const items = [];
  const requests = [];
  class Stack {
    layoutHorizontally() {}
    layoutVertically() {}
    centerAlignContent() {}
    setPadding() {}
    addSpacer() {}
    addStack() { const stack = new Stack(); items.push(stack); return stack; }
    addText(text) { items.push(text); return {}; }
    addImage(image) { items.push(image); return { applyFittingContentMode() {} }; }
  }
  class Request {
    constructor(url) { this.url = url; requests.push(this); }
    async loadString() { this.response = { statusCode: code }; return JSON.stringify(response); }
  }
  class Color { static white() { return ''; } }
  const bindings = {
    Request, ListWidget: Stack, Color, Size: class {}, config: { runsInWidget: true },
    Font: { semiboldSystemFont() {}, mediumSystemFont() {}, systemFont() {} },
    FileManager: { local: () => ({ joinPath() {}, documentsDirectory() {}, fileExists: () => false }) },
    Data: { fromBase64String: input => Buffer.from(input, 'base64') },
    Image: { fromData: input => ({ picture: input.toString() }) },
    Script: { setWidget() {}, complete() {} },
  };
  const source = script.replace("'https://example.com';", JSON.stringify(url) + ';')
    .replace("const WIDGET_TOKEN = '';", 'const WIDGET_TOKEN = ' + JSON.stringify(key) + ';');
  await new AsyncFunction(...Object.keys(bindings), source)(...Object.values(bindings));
  return { items, requests };
}

test('Scriptable 顯示連線狀態、角色圖與最近互動，互動入口只開啟房間', async () => {
  const { items, requests } = await preview({
    url: 'https://room.example.test/#interact',
    response: { name: '霧島', mood: '微笑', days: 3, greeting: '早安。',
      scene: { portrait: 'data:image/png;base64,cG9ydHJhaXQ=', interaction: '打招呼' } },
  });
  assert.equal(requests[0].url, 'https://room.example.test/api/widget');
  assert.equal(requests[0].headers.Authorization, 'Bearer ' + token);
  assert.equal(requests[0].onRedirect(), null);
  assert.ok(items.some(item => item?.picture === 'portrait'));
  assert.ok(items.includes('最近互動 · 打招呼'));
  assert.ok(items.includes('已連線・微笑 · 第 3 天'));
  assert.ok(items.some(item => item?.url === 'https://room.example.test/#interact'));
});

test('Scriptable 區分缺少憑證、失效憑證、與 Vercel 部署保護', async () => {
  const missing = await preview({ key: '' });
  assert.equal(missing.requests.length, 0);
  assert.ok(missing.items.some(item => typeof item === 'string' && item.startsWith('請填 Widget 憑證')));
  const rejected = await preview({ code: 401, response: { error: '小工具憑證無效。' } });
  assert.ok(rejected.items.some(item => typeof item === 'string' && item.startsWith('憑證無效')));
  const protectedDeployment = await preview({ code: 403, response: {} });
  assert.ok(protectedDeployment.items.some(item => typeof item === 'string' && item.startsWith('部署存取受限')));
});
