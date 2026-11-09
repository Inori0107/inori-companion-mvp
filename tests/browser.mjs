import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const url = 'http://127.0.0.1:' + port;
const directory = await mkdtemp(join(tmpdir(), 'inori-browser-'));
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, VERCEL: '', OPENAI_API_KEY: '', APP_ORIGIN: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', PORT: String(port), HOST: '127.0.0.1', INORI_DATA_DIR: directory },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await fetch(url + '/api/health')).ok; } catch { /* still starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Mock server did not start');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/health', route => route.abort(), { times: 1 });
  await page.goto(url);
  await page.getByRole('button', { name: '重新連線' }).click();
  await page.locator('#room').waitFor();
  await page.locator('#messageInput').fill('早安，祈。');
  await page.getByRole('button', { name: '送出' }).click();
  await page.getByText('早安。睡得還好嗎？', { exact: true }).last().waitFor();
  await page.getByRole('button', { name: '評分', exact: true }).click();
  await page.locator('#rateConsent').check();
  await page.getByRole('button', { name: '保存評分' }).click();
  await page.getByRole('button', { name: '已評分' }).waitFor();
  await page.locator('[data-tab="memory"]').click();
  await page.getByRole('button', { name: '新增記憶' }).click();
  await page.locator('#memoryInput').fill('我喜歡合唱。');
  await page.locator('#memoryConsent').check();
  await page.getByRole('button', { name: '保存記憶' }).click();
  await page.getByText('我喜歡合唱。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '編輯' }).click();
  await page.locator('#memoryInput').fill('我喜歡和聲。');
  await page.locator('#memoryConsent').check();
  await page.getByRole('button', { name: '保存記憶' }).click();
  await page.getByText('我喜歡和聲。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '刪除', exact: true }).click();
  await page.getByText('目前沒有已保存的記憶。').waitFor();
  await page.locator('[data-tab="touch"]').click();
  await page.getByRole('button', { name: '一起唱歌' }).click();
  await page.locator('#saveShared').click();
  await page.locator('#memoryConsent').check();
  await page.getByRole('button', { name: '保存記憶' }).click();
  await page.getByRole('button', { name: '分享心情' }).click();
  await page.getByRole('button', { name: '有點低落' }).click();
  await page.getByText('「嗯。我可以陪你安靜一會兒。」', { exact: true }).waitFor();
  await page.locator('[data-tab="diary"]').click();
  await page.getByText('一起唱歌、分享心情。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '生成 AI 日記' }).isDisabled(), true);

  const editor = page.locator('#designDialog');
  const upload = { name: 'portrait.png', mimeType: 'image/png',
    buffer: await readFile(new URL('../public/icon-192.png', import.meta.url)) };
  async function addPortrait(name, kind, value) {
    await editor.getByRole('button', { name: /新增一張立繪/ }).click();
    const row = editor.locator('.portrait-row').last();
    await row.getByLabel('立繪名稱').fill(name);
    await row.getByLabel('觸發方式').selectOption(kind);
    if (kind === 'keyword') await row.getByRole('textbox', { name: '對話關鍵字', exact: true }).fill(value);
    else await row.getByLabel('對應表情或動作').selectOption(value);
    await row.getByLabel('立繪檔案').setInputFiles(upload);
    await row.getByText('圖片已加入草稿').waitFor();
  }
  await page.getByRole('button', { name: '自訂角色' }).click();
  await addPortrait('未儲存的立繪', 'expression', '普通');
  await editor.getByRole('button', { name: '關閉' }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '自訂角色' }).click();
  assert.equal(await editor.locator('.portrait-row').count(), 0);
  await page.getByLabel('角色基礎').selectOption('original');
  await page.getByLabel('角色名稱').fill('小澄');
  await page.getByLabel('問候語').fill('一起看星星吧。');
  await page.getByText('個性與世界觀', { exact: true }).click();
  await page.getByLabel('世界觀').fill('在海邊守望星空。');
  assert.equal(await page.locator('#previewName').textContent(), '小澄');
  await addPortrait('日常', 'expression', '普通');
  await addPortrait('招手', 'interaction', 'hello');
  await addPortrait('月亮', 'keyword', '月亮');
  assert.equal(await page.locator('#designForm').evaluate(form => form.lastElementChild.id), 'saveDesign');
  await page.getByRole('button', { name: '儲存角色' }).click();
  await page.getByRole('heading', { name: '小澄' }).waitFor();
  const state = await (await context.request.get(url + '/api/session')).json();
  const [ordinary, hello, moon] = state.portraits;
  const hero = page.locator('#portraitImage');
  await hero.waitFor();
  assert.match(await hero.getAttribute('src'), new RegExp(ordinary.id));
  await page.locator('[data-tab="touch"]').click();
  await page.locator('[data-touch="hello"]').click();
  await page.waitForFunction(id => document.querySelector('#portraitImage').getAttribute('src')?.endsWith(id), hello.id);
  await page.locator('[data-tab="chat"]').click();
  await page.locator('#messageInput').fill('一起看月亮。');
  await page.getByRole('button', { name: '送出' }).click();
  await page.waitForFunction(id => document.querySelector('#portraitImage').getAttribute('src')?.endsWith(id), moon.id);
  await page.reload();
  await page.getByRole('heading', { name: '小澄' }).waitFor();
  await hero.waitFor();
  assert.match(await hero.getAttribute('src'), new RegExp(moon.id));

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByText('資料與分享', { exact: true }).click();
  const share = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出角色範本' }).click();
  const template = JSON.parse(await readFile(await (await share).path(), 'utf8'));
  assert.equal(template.format, 'inori-character-design-v1');
  assert.equal(template.design.name, '小澄');
  assert.equal(template.design.world, '在海邊守望星空。');
  assert.deepEqual(Object.keys(template).sort(), ['design', 'format']);

  await page.locator('#importFile').setInputFiles({
    name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from('{}'),
  });
  await page.getByText('請選擇 INORI 的角色範本或私人備份 JSON。').waitFor();
  await page.locator('#importFile').setInputFiles({
    name: 'friend.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...template, design: { ...template.design, name: '霧島' } })),
  });
  await page.getByText('已載入範本草稿。檢查內容後，到最下方儲存角色。').waitFor();
  assert.equal(await page.locator('#previewName').textContent(), '霧島');
  assert.equal(await page.locator('#characterName').textContent(), '小澄');
  assert.equal(await editor.locator('.portrait-row').count(), 3);
  await page.getByRole('button', { name: '儲存角色' }).click();
  await page.getByRole('heading', { name: '霧島' }).waitFor();

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByText('主畫面小工具', { exact: true }).click();
  await page.getByRole('button', { name: '產生 Widget 憑證' }).click();
  await page.locator('#widgetLabel').waitFor();
  const token = await page.locator('#widgetToken').inputValue();
  assert.equal(token.length, 43);
  const widget = await context.request.get(url + '/api/widget', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(widget.status(), 200);
  assert.equal((await widget.json()).name, '霧島');
  await page.getByRole('button', { name: '撤銷 Widget 憑證' }).click();
  await page.getByText('憑證已撤銷。', { exact: true }).waitFor();
  assert.equal((await context.request.get(url + '/api/widget', { headers: { Authorization: 'Bearer ' + token } })).status(), 401);
  if (!(await page.locator('#exportBtn').isVisible())) await page.getByText('資料與分享', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出私人備份' }).click();
  const backupFile = await download;
  assert.match(backupFile.suggestedFilename(), /^inori-backup/);
  const backup = JSON.parse(await readFile(await backupFile.path(), 'utf8'));
  assert.equal(backup.portraits.length, 3);
  assert.match(backup.portraits[0].image, /^data:image\//);
  await page.getByRole('link', { name: '人格校調後台' }).click();
  await page.locator('#studio').waitFor();
  await page.getByRole('button', { name: '執行所選測試' }).click();
  await page.getByText('測試已完成。 本次 1 筆。').waitFor();
  await page.locator('#compare').getByRole('button', { name: '人工評分' }).click();
  await page.getByRole('button', { name: '保存評分' }).click();
  await page.locator('#results').getByText(/5 \/ 5/).waitFor();
  await page.goto(url);
  await page.locator('#room').waitFor();
  await page.getByRole('heading', { name: '霧島' }).waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const cache = await caches.open('inori-shell-v3');
    if (!(await cache.match('/icon-192.png'))) throw new Error('missing PWA icon');
    if (await cache.match('/api/session')) throw new Error('personal API response was cached');
  });
  async function openDataSettings() {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    if (!(await page.locator('#importData').isVisible())) await page.getByText('資料與分享', { exact: true }).click();
  }
  await openDataSettings();
  await page.getByRole('button', { name: '清除房間資料' }).click();
  await page.getByRole('heading', { name: '楪祈' }).waitFor();
  await page.evaluate(data => localStorage.setItem('inori-portrait:local', JSON.stringify({ 普通: data })),
    'data:image/png;base64,' + upload.buffer.toString('base64'));
  await page.reload();
  await hero.waitFor();
  assert.match(await hero.getAttribute('src'), /^data:image/);
  await page.getByRole('button', { name: '自訂角色' }).click();
  await editor.getByText('舊版立繪・儲存後同步').waitFor();
  await page.getByRole('button', { name: '儲存角色' }).click();
  await page.waitForFunction(() => document.querySelector('#portraitImage').getAttribute('src')?.startsWith('/api/portraits/'));
  assert.equal(await page.evaluate(() => localStorage.getItem('inori-portrait:local')), null);

  await openDataSettings();
  await page.getByRole('button', { name: '清除房間資料' }).click();
  await hero.waitFor({ state: 'hidden' });
  await openDataSettings();
  await page.locator('#importFile').setInputFiles({
    name: 'private-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByText('已匯入可遷移的房間資料。').waitFor();
  const afterImport = await (await context.request.get(url + '/api/session')).json();
  assert.equal(afterImport.design.name, '霧島');
  assert.equal(afterImport.portraits.length, 3);
  assert.deepEqual(problems, []);
  console.log('Mobile Chromium smoke passed: reconnect, chat, feedback, memory CRUD, interaction, diary, atomic portrait editor, action/keyword portraits, unified sharing/import, widget rotation, backup, studio, layout, PWA cache.');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'exit');
    server.kill();
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
}
