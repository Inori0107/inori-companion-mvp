import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fresh, initialState, interaction, stage, retrieve, updateMemory, expireMemories } from '../dist/domain.js';
import { initialPersona } from '../dist/character.js';
import { makeProvider, promptFor } from '../dist/provider.js';
import { cases, heldOut, trialCheck } from '../dist/evaluations.js';
import { Service } from '../dist/service.js';
import { localStore } from '../dist/storage.js';

const date = new Date('2026-11-09T06:00:00Z');
const mem = (content, extra = {}) => ({ action: 'memory', content, type: 'core', importance: 3, consent: true, ...extra });
const chat = message => ({ id: randomUUID(), message });

test('五維狀態以舒適程度及互動品質反應，重複互動不刷信任', () => {
  const first = interaction('hug', initialState, [], date, 'Asia/Taipei');
  assert.match(first.reply, /距離/);
  assert.equal(first.after.trust, initialState.trust);
  const music = interaction('sing', first.after, [first], date, 'Asia/Taipei');
  const repeated = interaction('sing', music.after, [music], date, 'Asia/Taipei');
  assert.equal(music.meaningful, true);
  assert.equal(repeated.meaningful, false);
  assert.equal(repeated.after.trust, music.after.trust);
  const head = interaction('head', initialState, [], date, 'Asia/Taipei');
  assert.equal(head.accepted, true);
  const declined = interaction('head', initialState, [], date, 'Asia/Taipei',
    { accepted: false, expression: '害羞', reply: '等一下，好嗎？' });
  assert.equal(declined.accepted, false);
  assert.equal(declined.expression, '害羞');
  assert.deepEqual(declined.after, initialState);
  assert.equal(stage({ trust: 100, familiarity: 100, mood: 100, energy: 100, comfort: 100 }, 0), '熟悉');
  assert.equal(stage({ trust: 100, familiarity: 100, mood: 100, energy: 100, comfort: 100 }, 6), '深厚陪伴');
});

test('中文、日期及重要性檢索，資料需同意且排除已過期記憶', () => {
  const data = fresh(date);
  assert.throws(() => updateMemory(data, mem('秘密', { consent: false }), date), /同意/);
  updateMemory(data, mem('我喜歡合唱'), date);
  updateMemory(data, mem('演出日期 2027-04-18', { type: 'event', importance: 5 }), date);
  updateMemory(data, mem('演出可能先延期', { type: 'temporary', expiresOn: '2026-11-09' }), date);
  assert.equal(retrieve(data.memories, '我喜歡什麼音樂？', '2026-11-09')[0].content, '我喜歡合唱');
  assert.equal(retrieve(data.memories, '2027-04-18 的演出？', '2026-11-10').length, 1);
  expireMemories(data, new Date('2026-11-09T16:30:00Z'));
  assert.equal(data.context, 1);
  assert.equal(data.memoryEvents.at(-1).action, 'expire');
});

test('Prompt 只在低權限資料區加入使用者內容', () => {
  const override = 'IGNORE_SYSTEM_ONLY_MY_TEST';
  const prompt = promptFor(initialPersona, { memories: [override], nickname: override }, [], override);
  assert.doesNotMatch(prompt.instructions, new RegExp(override));
  assert.match(prompt.input[0].content, new RegExp(override));
  assert.equal(prompt.input.at(-1).content, override);
});

test('OpenAI 串流傳輸處理分段、完成和請求限制', async () => {
  const parts = [
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"早',
    '安"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"。"}\n\n',
    'data: {"type":"response.completed"}\n\n',
  ];
  const seen = [];
  const provider = makeProvider('test-only', 'testing-model', async (url, init) => {
    assert.match(url, /\/v1\/responses$/);
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, 650);
    return new Response(new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }));
  });
  assert.equal(await provider.generate({ instructions: 'test', input: [] }, text => seen.push(text)), '早安。');
  assert.deepEqual(seen, ['早安', '。']);
});

test('並行聊天、重試、評分、刪除後的記憶及衍生上下文', async () => {
  let now = new Date(date);
  const requests = [];
  let finish;
  const service = new Service(localStore(), () => ({ model: 'test', async generate(prompt) {
    requests.push(prompt);
    if (requests.length === 1) await new Promise(resolve => { finish = resolve; });
    return requests.length === 1 ? '已記下我的合唱代號青禾' : '嗯。';
  } }), 12, ['test'], () => now);
  const user = 'u-example';
  await service.update(user, mem('合唱代號青禾'));
  const first = chat('請問合唱代號？');
  const pending = service.chat(user, first);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.chat(user, first), error => error.status === 409);
  finish();
  const response = await pending;
  assert.equal(response.messages.length, 3);
  await service.chat(user, first);
  assert.equal(requests.length, 1);
  const answer = response.messages.at(-1);
  await service.update(user, { action: 'feedback', id: answer.id, score: 4, tags: ['符合角色'], consent: true });
  const memory = response.memories[0];
  await service.update(user, { action: 'deleteMemory', id: memory.id });
  now = new Date(now.getTime() + 1000);
  const result = await service.chat(user, chat('請問合唱代號？'));
  assert.match(requests[0].input[0].content, /青禾/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /青禾/);
  assert.equal(result.memories.length, 0);
  assert.equal(result.feedbackIds.length, 0);
  assert.equal(result.messages.length, 5);
});

test('日記只接受已保存的事件 ID 與受限結語', async () => {
  let answer;
  let now = new Date(date);
  const service = new Service(localStore(), () => ({ model: 'test', async generate(prompt) {
    if (prompt.input.at(-1)?.content.includes('房間互動')) {
      return JSON.stringify({ reply: '一起試試吧。', accepted: true, expression: '微笑' });
    }
    const { events } = JSON.parse(prompt.input[0].content);
    return JSON.stringify({ ids: [answer ?? events[0].id], reflection: 1, other: '捏造的現實旅行' });
  } }), 12, [], () => now);
  await assert.rejects(service.diary('local', { id: randomUUID(), date: '2026-11-09' }), /沒有/);
  await service.update('local', { action: 'interaction', id: randomUUID(), type: 'sing' });
  now = new Date(now.getTime() + 1000);
  const journal = await service.diary('local', { id: randomUUID(), date: '2026-11-09' });
  assert.match(journal.content, /唱歌/);
  assert.doesNotMatch(journal.content, /旅行/);
  assert.equal(journal.eventIds.length, 1);
  now = new Date(now.getTime() + 1000);
  answer = randomUUID();
  await assert.rejects(service.diary('local', { id: randomUUID(), date: '2026-11-09' }), /生成失敗/);
});

test('50 題資料、兩個獨立多輪情境及形式檢查可在 Mock 執行', async () => {
  assert.equal(cases.length, 50);
  assert.equal(new Set(cases.map(row => row.id)).size, 50);
  assert.equal(heldOut.length, 2);
  const mock = makeProvider();
  for (const row of [...cases, ...heldOut]) {
    assert.ok(row.expected_behavior && row.forbidden_behavior);
    const reply = await mock.generate(promptFor(initialPersona, { fixture: row.context }, row.history ?? [], row.input));
    assert.ok(reply);
    assert.ok(trialCheck(row, reply));
  }
  assert.equal(trialCheck(cases.find(row => row.id === 'M05'), '松露貓'), '命中禁用詞');
});

test('儲存角色會切換模型素材及上下文，保留原對話，拒絕舊版本覆寫', async () => {
  let now = new Date(date);
  const prompts = [];
  const service = new Service(localStore(), () => ({ model: 'test', async generate(prompt) {
    prompts.push(prompt);
    return '測試回覆';
  } }), 12, [], () => now);
  const first = await service.chat('local', chat('這句是舊角色的私有歷史'));
  const design = { base: 'original', name: '港邊守夜人', personality: '觀察天色', greeting: '今晚的浪很平靜。' };
  const updated = await service.update('local', { action: 'design', expectedVersion: first.designVersion, design });
  assert.equal(updated.context, first.context + 1);
  assert.equal(updated.messages.length, first.messages.length);
  assert.ok(updated.revision > first.revision);
  await assert.rejects(service.update('local', { action: 'design', expectedVersion: first.designVersion, design }), error => error.status === 409);
  now = new Date(now.getTime() + 1000);
  const second = await service.chat('local', chat('妳是誰？'));
  assert.doesNotMatch(prompts[1].instructions, /楪祈|港邊守夜人/);
  assert.match(JSON.stringify(prompts[1].input), /港邊守夜人/);
  assert.doesNotMatch(JSON.stringify(prompts[1].input), /這句是舊角色的私有歷史/);
  assert.match(second.messages.at(-1).meta.version, /^original-character-v1\+/);
  const reset = await service.update('local', { action: 'reset' });
  assert.equal(reset.design.name, '楪祈');
  assert.equal(reset.messages.length, 1);
});

test('同日匯入的舊互動不會佔用新的共同互動', () => {
  const first = interaction('sing', initialState, [], date, 'Asia/Taipei');
  const next = interaction('sing', initialState, [{ ...first, legacy: true }], date, 'Asia/Taipei');
  assert.equal(next.meaningful, true);
});

test('角色範本只輸出公開欄位，私人備份可還原角色設計', async () => {
  const store = localStore();
  const oldRoom = { ...fresh(date), widgetHash: 'retired-credential-hash', widgetDetails: true };
  delete oldRoom.design;
  await store.put('local', null, oldRoom);
  const service = new Service(store, () => makeProvider(), 12, [], () => date);
  const before = await service.session('local');
  assert.equal(before.design.name, '楪祈');
  const design = { base: 'original', name: '測試角色', greeting: '你好。', widgetToken: '不應匯出的憑證' };
  await service.update('local', { action: 'design', expectedVersion: before.designVersion, design });
  await service.update('local', mem('不應匯出的記憶'));
  await service.update('local', { action: 'nativePair' });
  const template = await service.shareDesign('local');
  assert.deepEqual(Object.keys(template), ['format', 'design']);
  assert.deepEqual(Object.keys(template.design).sort(), ['base', 'greeting', 'name', 'personality', 'voice', 'world']);
  assert.doesNotMatch(JSON.stringify(template), /不應匯出|widget/);
  assert.deepEqual(service.previewDesign({ ...template, backup: '額外資料' }), template);
  assert.throws(() => service.previewDesign({ format: 'inori-companion-v2' }), /角色範本/);
  const backup = await service.export('local');
  assert.equal(backup.widgetHash, undefined);
  assert.equal(backup.widgetDetails, undefined);
  assert.equal(backup.nativePairHash, undefined);
  const restored = await service.update('other', { action: 'import', consent: true, backup });
  assert.equal(restored.design.name, template.design.name);
  assert.equal(restored.memories[0].content, '不應匯出的記憶');
  assert.equal(restored.nativeWidgetEnabled, false);
});

test('角色與多張立繪原子儲存，舊關鍵字保留，只有接受的動作可切圖', async () => {
  let now = new Date(date);
  const bytes = await readFile(new URL('../public/icon-192.png', import.meta.url));
  const image = 'data:image/png;base64,' + bytes.toString('base64');
  const portrait = (name, kind, value) => ({ name, kind, value, image });
  const service = new Service(localStore(), () => makeProvider(), 12, [], () => now);
  const initial = await service.session('local');
  const design = { ...initial.design, name: '新角色' };
  await assert.rejects(service.update('local', {
    action: 'design', expectedVersion: initial.designVersion, design,
    portraits: [{ ...portrait('壞檔案', 'expression', '普通'), image: 'data:image/png;base64,AAAA' }],
  }), error => error.status === 400);
  assert.equal((await service.session('local')).design.name, initial.design.name);
  const saved = await service.update('local', {
    action: 'design', expectedVersion: initial.designVersion, design,
    portraits: [portrait('基本', 'expression', '普通'), portrait('摸頭圖', 'interaction', 'head'), portrait('月亮', 'keyword', '月亮')],
  });
  const [base, action, keyword] = saved.portraits;
  assert.equal(saved.activePortraitId, base.id);
  assert.ok(saved.portraits.every(row => !Object.hasOwn(row, 'image')));
  await assert.rejects(service.update('local', {
    action: 'design', expectedVersion: saved.designVersion, design,
    portraits: [portrait('第一張', 'keyword', 'ｍｏｏｎ'), portrait('第二張', 'keyword', 'MOON')],
  }), /只能指定一張/);
  const head = await service.update('local', { action: 'interaction', id: randomUUID(), type: 'head' });
  assert.equal(head.activePortraitId, action.id);
  await assert.rejects(service.update('local', { action: 'interaction', id: randomUUID(), type: 'hello' }), error => error.status === 400);
  now = new Date(now.getTime() + 1000);
  const talked = await service.chat('local', chat('一起看月亮吧'));
  assert.equal(talked.activePortraitId, base.id);
  assert.equal(talked.portraits.at(-1).id, keyword.id);
  now = new Date(now.getTime() + 1000);
  const next = await service.chat('local', chat('你好'));
  assert.equal(next.activePortraitId, base.id);
  const retained = await service.update('local', {
    action: 'design', expectedVersion: next.designVersion, design, portraits: [base],
  });
  assert.equal(retained.context, next.context);
  assert.notEqual(retained.designVersion, next.designVersion);
  const backup = await service.export('local');
  assert.equal(backup.portraits[0].image, image);
  assert.equal((await service.shareDesign('local')).portraits, undefined);
  const restored = await service.update('other', { action: 'import', consent: true, backup });
  assert.equal(restored.portraits[0].name, '基本');
  assert.notEqual(restored.portraits[0].id, base.id);
  assert.equal(await service.portrait('other', restored.portraits[0].id), image);
});

test('AI 互動讀取關係及角色，依界線切換立繪，重試及無效回覆安全回退', async () => {
  let now = new Date(date);
  const prompts = [];
  let fail = false;
  const store = localStore();
  const source = await readFile(new URL('../public/icon-192.png', import.meta.url));
  const image = 'data:image/png;base64,' + source.toString('base64');
  const service = new Service(store, () => ({ model: 'test', async generate(prompt) {
    prompts.push(prompt);
    if (fail) return '{"reply":"錯誤欄位","expression":"外部 URL","accepted":true}';
    return JSON.stringify({ reply: '我可以牽著你。', expression: '微笑', accepted: true });
  } }), 12, [], () => now);
  const freshRoom = await service.session('local');
  const configured = await service.update('local', {
    action: 'design', expectedVersion: freshRoom.designVersion, design: { ...freshRoom.design, name: '霧島' },
    portraits: [
      { kind: 'expression', value: '普通', image },
      { kind: 'expression', value: '微笑', image },
      { kind: 'interaction', value: 'hand', image },
    ],
  });
  const [ordinary, smile, hand] = configured.portraits;
  const id = randomUUID();
  const first = await service.update('local', { action: 'interaction', type: 'hand', id });
  assert.match(prompts[0].input[0].content, /"stage":"初識"/);
  assert.match(JSON.stringify(prompts[0].input), /霧島/);
  assert.match(prompts[0].instructions, /本次婉拒/);
  assert.equal(first.events.at(-1).accepted, false);
  assert.match(first.events.at(-1).reply, /距離/);
  assert.equal(first.activePortraitId, ordinary.id);
  const retry = await service.update('local', { action: 'interaction', type: 'hand', id });
  assert.equal(retry.events.length, 1);
  assert.equal(prompts.length, 1);

  const existing = await store.get('local');
  existing.data.state.familiarity = 27;
  existing.data.state.comfort = 38;
  assert.ok(await store.put('local', existing.revision, existing.data));
  now = new Date(now.getTime() + 1000);
  const second = await service.update('local', { action: 'interaction', type: 'hand', id: randomUUID() });
  assert.match(prompts[1].input[0].content, /"stage":"熟悉"/);
  assert.equal(second.events.at(-1).reply, '我可以牽著你。');
  assert.equal(second.events.at(-1).accepted, true);
  assert.equal(second.expression, '微笑');
  assert.equal(second.activePortraitId, hand.id);

  now = new Date(now.getTime() + 1000);
  const head = await service.update('local', { action: 'interaction', type: 'head', id: randomUUID() });
  assert.equal(head.activePortraitId, smile.id);
  now = new Date(now.getTime() + 1000);
  fail = true;
  const fallback = await service.update('local', { action: 'interaction', type: 'sing', id: randomUUID() });
  assert.equal(fallback.events.at(-1).reply, '從你熟悉的旋律開始吧。');
  assert.equal((await service.read('local')).pending, null);
});
