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
  assert.deepEqual(await page.locator('[data-touch] span').allTextContents(), ['摸頭', '牽手', '擁抱', '唱歌']);
  await page.getByRole('button', { name: '唱歌' }).click();
  await page.locator('#saveShared').click();
  await page.locator('#memoryConsent').check();
  await page.getByRole('button', { name: '保存記憶' }).click();
  await page.getByRole('button', { name: '擁抱' }).click();
  await page.getByText('「我想先保持一點距離。坐在這裡聊聊，可以嗎？」', { exact: true }).waitFor();
  await page.locator('[data-tab="diary"]').click();
  await page.getByText('唱歌、擁抱。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '生成 AI 日記' }).isDisabled(), true);

  const editor = page.locator('#designDialog');
  const upload = { name: 'portrait.png', mimeType: 'image/png',
    buffer: await readFile(new URL('../public/icon-192.png', import.meta.url)) };
  async function addPortrait(title) {
    const row = editor.getByRole('article', { name: title, exact: true });
    await row.getByLabel(title + '檔案', { exact: true }).setInputFiles(upload);
    await row.getByText('圖片已加入草稿').waitFor();
  }
  await page.getByRole('button', { name: '自訂角色' }).click();
  await addPortrait('預設立繪');
  await editor.getByRole('button', { name: '關閉' }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '自訂角色' }).click();
  assert.equal(await editor.getByText('圖片已加入草稿').count(), 0);
  assert.equal(await editor.getByText('觸發方式', { exact: true }).count(), 0);
  await page.getByLabel('角色基礎').selectOption('original');
  await page.getByLabel('角色名稱').fill('小澄');
  await page.getByLabel('問候語').fill('一起看星星吧。');
  await page.getByText('個性與世界觀', { exact: true }).click();
  await page.getByLabel('世界觀').fill('在海邊守望星空。');
  assert.equal(await page.locator('#previewName').textContent(), '小澄');
  await addPortrait('預設立繪');
  await editor.getByText('其他表情（選填）', { exact: true }).click();
  await addPortrait('微笑');
  await editor.getByText('動作專用圖（選填）', { exact: true }).click();
  await addPortrait('摸頭');
  assert.equal(await page.locator('#designForm').evaluate(form => form.lastElementChild.id), 'saveDesign');
  await page.getByRole('button', { name: '儲存角色' }).click();
  await page.getByRole('heading', { name: '小澄' }).waitFor();
  const state = await (await context.request.get(url + '/api/session')).json();
  const [ordinary, smile, head] = state.portraits;
  assert.equal(smile.value, '微笑');
  const hero = page.locator('#portraitImage');
  await hero.waitFor();
  assert.equal(await hero.getAttribute('data-portrait-id'), ordinary.id);
  await page.locator('[data-tab="touch"]').click();
  await page.locator('[data-touch="head"]').click();
  await page.waitForFunction(id => document.querySelector('#portraitImage').dataset.portraitId === id, head.id);
  await page.locator('[data-tab="chat"]').click();
  await page.locator('#messageInput').fill('一起看月亮。');
  await page.getByRole('button', { name: '送出' }).click();
  await page.waitForFunction(id => document.querySelector('#portraitImage').dataset.portraitId === id, ordinary.id);
  await page.route('**/api/portrait?id=*', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: '測試暫停' }),
  }), { times: 1 });
  await page.reload();
  await page.getByRole('heading', { name: '小澄' }).waitFor();
  await page.getByText('立繪讀取失敗（HTTP 503）。').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await hero.waitFor();
  assert.equal(await hero.getAttribute('data-portrait-id'), ordinary.id);
  assert.match(await hero.getAttribute('src'), /^data:image\/png/);

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
  assert.equal(await editor.locator('.portrait-row').count(), 8);
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
  const widgetData = await widget.json();
  assert.equal(widgetData.name, '霧島');
  assert.match(widgetData.scene.portrait, /^data:image\/png/);
  assert.equal(widgetData.scene.interaction, '摸頭');
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
  // Chat and evaluation share the same generation cooldown.
  await new Promise(resolve => setTimeout(resolve, 850));
  const trial = page.waitForResponse(response => response.url().endsWith('/api/studio-run'));
  await page.getByRole('button', { name: '執行所選測試' }).click();
  const trialResponse = await trial;
  assert.equal(trialResponse.status(), 200, await trialResponse.text());
  await page.getByText('測試已完成。 本次 1 筆。').waitFor();
  await page.locator('#compare').getByRole('button', { name: '人工評分' }).click();
  await page.getByRole('button', { name: '保存評分' }).click();
  await page.locator('#results').getByText(/5 \/ 5/).waitFor();
  await page.goto(url + '/#interact');
  await page.locator('#room').waitFor();
  await page.getByRole('heading', { name: '霧島' }).waitFor();
  await page.locator('#panel-touch').waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!(await caches.match('/icon-192.png'))) throw new Error('missing PWA icon');
    if (await caches.match('/api/session')) throw new Error('personal API response was cached');
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
  await page.waitForFunction(() => Boolean(document.querySelector('#portraitImage').dataset.portraitId));
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
  console.log('Mobile Chromium smoke passed: reconnect, chat, feedback, memory CRUD, interaction, diary, fixed portrait slots, accepted action portraits, unified sharing/import, widget rotation, backup, studio, layout, PWA cache.');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'exit');
    server.kill();
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
}
