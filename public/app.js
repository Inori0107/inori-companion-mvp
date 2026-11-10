import { $, api, bindForm, button, download, node, option, requestId, useAccount } from './client.js';
import { createPortraitEditor, keepPortraits, legacyImages, loadPortrait, prepareLegacyPortraits } from './portraits.js';

const legacyKey = 'inori-companion-v1';
const designFormat = 'inori-character-design-v1';
const designInputs = { base: 'designBase', name: 'designName', greeting: 'designGreeting', world: 'designWorld',
  personality: 'designPersonality', voice: 'designVoice' };
const baseLabels = { inori: 'THE QUIET DIVERGENCE', original: 'ORIGINAL CHARACTER' };
const defaultDesign = { base: 'inori', name: '楪祈', greeting: '', world: '', personality: '', voice: '' };
const memoryLabels = { core: '核心', event: '事件', temporary: '短期', shared: '共同' };
const actionLabels = { hello: '打招呼', head: '摸頭', hand: '牽手', hug: '擁抱', sing: '唱歌', listen: '聽歌', feeling: '分享心情' };
const diaryLabels = { ai: 'AI 日記', summary: '事件摘要', example: '固定示範' };
let state;
let health;
let busy = false;
let sending = false;
let candidate;
let memoryDraft;
let ratedId;
let retry;
let interactionRetry;
let diarySequence = 0;
let sessionEpoch = 0;
let editingVersion;
let editInitial;
let portraitEdited = false;
const portraitEditor = createPortraitEditor(actionLabels, () => { portraitEdited = true; });
let refreshing = false;

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function portraitKey() { return 'inori-portrait:' + (state.email || 'local'); }

function clearLegacyPortraits() {
  try { localStorage.removeItem(portraitKey()); } catch { /* The server copy takes precedence. */ }
}

const hero = $('portraitImage');
let portraitTarget = null;
let portraitRequest = 0;
const portraitStatus = $('portraitStatus');

hero.onload = () => {
  if (!hero.getAttribute('src')) return;
  hero.hidden = false;
  $('portrait').classList.add('loaded');
};
hero.onerror = () => {
  showPortrait('');
  portraitStatus.textContent = '圖片無法解碼，請重新上傳 PNG 或 JPG。';
};

function showPortrait(source, id) {
  hero.dataset.portraitId = id ?? '';
  if ((hero.getAttribute('src') ?? '') === source) return;
  hero.hidden = true;
  $('portrait').classList.remove('loaded');
  if (source) hero.src = source;
  else hero.removeAttribute('src');
}

function renderPortrait() {
  const id = state.activePortraitId;
  const portraits = state.portraits ?? [];
  keepPortraits(portraits.map(item => item.id));
  const legacy = state.portraits == null ? legacyImages(readLocal(portraitKey())) : {};
  const fallback = legacy[state.expression] || legacy.普通 || '';
  const target = id || fallback;
  if (!target) portraitStatus.textContent = portraits.length || Object.keys(legacy).length
    ? '目前無符合立繪。可在「自訂角色」設定預設立繪。' : '可在「自訂角色」新增立繪';
  if (target === portraitTarget) return;
  portraitTarget = target;
  const request = ++portraitRequest;
  showPortrait(fallback);
  if (!id) return;
  portraitStatus.textContent = '正在載入立繪……';
  void loadPortrait(id).then(image => {
    if (request === portraitRequest) showPortrait(image, id);
  }).catch(error => {
    if (request !== portraitRequest) return;
    portraitTarget = null; // Allow retry on the next room refresh.
    portraitStatus.textContent = '立繪讀取失敗' + (error.status ? '（HTTP ' + error.status + '）' : '') + '。';
  });
}

function showLogin() {
  sessionEpoch++;
  diarySequence++;
  useAccount();
  document.title = 'INORI Companion';
  state = undefined;
  candidate = undefined;
  retry = undefined;
  interactionRetry = undefined;
  $('messages').replaceChildren();
  $('memoryList').replaceChildren();
  $('diaryText').textContent = '';
  $('diaryKind').textContent = '';
  $('diaryHint').textContent = '';
  $('diaryDate').value = '';
  $('messageInput').value = '';
  $('chatStatus').textContent = '';
  portraitTarget = null;
  portraitRequest++;
  keepPortraits([]);
  showPortrait('');
  portraitEditor.clear();
  $('settingsForm').reset();
  $('designForm').reset();
  $('memoryForm').reset();
  $('rateForm').reset();
  selectTab('chat');
  $('room').hidden = true;
  $('settingsBtn').hidden = true;
  $('designBtn').hidden = true;
  $('retryConnection').hidden = true;
  $('access').hidden = false;
  $('password').value = '';
  $('widgetToken').value = '';
  $('widgetLabel').hidden = true;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
}

function sessionError(error, target = 'notice') {
  if (error.status === 401 && health?.cloud) {
    showLogin();
    target = 'notice';
  }
  $(target).textContent = error.message;
}

function selectTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    const selected = btn.dataset.tab === tab;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === 'panel-' + tab));
  if (tab === 'diary') void loadDiary();
}

document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.onclick = () => {
    if (location.hash === '#interact' && btn.dataset.tab !== 'touch') history.replaceState(null, '', location.pathname + location.search);
    selectTab(btn.dataset.tab);
  };
});

function followWidgetLink() {
  if ($('room').hidden || location.hash !== '#interact') return;
  selectTab('touch');
  $('panel-touch').scrollIntoView({ block: 'start' });
}
window.addEventListener('hashchange', followWidgetLink);
document.querySelectorAll('[data-close]').forEach(btn => { btn.onclick = () => $(btn.dataset.close).close(); });

function renderHeader() {
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone: state.zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const days = Math.max(1, Math.round((Date.parse(state.today) - Date.parse(state.meetDate)) / 86_400_000) + 1);
  const anniversary = days > 1 && state.today.slice(5) === state.meetDate.slice(5);
  const greeting = anniversary ? '今天是我們的相遇紀念日。' : state.design.greeting ||
    (hour < 6 ? '夜深了。早點休息吧。' : hour < 12 ? '早安。睡得還好嗎？' : hour < 18 ? '午安。記得休息一下。' : '晚安。今天辛苦了。');
  $('greeting').textContent = '「' + greeting + '」';
  $('characterName').textContent = state.design.name;
  $('characterBase').textContent = baseLabels[state.design.base];
  document.title = state.design.name + '的房間 · INORI';
  $('days').textContent = '第 ' + days + ' 天';
  $('stage').textContent = state.stage;
  $('touchCount').textContent = state.todayCount + ' 次';
  $('moodText').textContent = state.expression;
  renderPortrait();
  $('portrait').dataset.expression = state.expression;
  $('portrait').setAttribute('aria-label', state.design.name + '的立繪');
}

function clock(at) {
  if (!at) return '匯入紀錄';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: state.zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(at));
}

function renderMessages(scroll = true) {
  const box = $('messages');
  const previous = box.scrollTop;
  box.replaceChildren();
  for (const msg of state.messages) {
    const bubble = node('article', undefined, 'bubble ' + (msg.role === 'user' ? 'user' : ''));
    bubble.append(node('div', msg.content));
    const meta = node('div', undefined, 'bubble-meta');
    meta.append(node('span', [clock(msg.at), msg.meta?.expression].filter(Boolean).join(' · ')));
    if (msg.meta && msg.context === state.context) {
      meta.append(button(state.feedbackIds.includes(msg.id) ? '已評分' : '評分', () => openRating(msg.id)));
      if (state.messages.at(-1)?.id === msg.id) meta.append(button('重新生成', () => sendChat({ regenerate: msg.id })));
    }
    bubble.append(meta);
    box.append(bubble);
  }
  box.scrollTop = scroll ? box.scrollHeight : previous;
}

function renderMemories() {
  const list = $('memoryList');
  list.replaceChildren();
  if (!state.memories.length) list.append(node('p', '目前沒有已保存的記憶。', 'hint'));
  for (const memory of state.memories) {
    const row = node('article', undefined, 'memory-item');
    const detail = node('div');
    const source = memory.source.startsWith('interaction:') ? '來自互動' : memory.source.startsWith('backup-') ? '備份匯入' : '手動新增';
    detail.append(node('p', memory.content), node('small', [
      memoryLabels[memory.type], '重要性 ' + memory.importance, source, memory.expiresOn ? '到期 ' + memory.expiresOn : '',
    ].filter(Boolean).join(' · ')));
    row.append(detail, button('編輯', () => openMemory(memory)), button('刪除', async () => {
      if (!confirm('刪除此記憶並停止後續召回？')) return;
      try { await update({ action: 'deleteMemory', id: memory.id }); }
      catch (error) { sessionError(error); }
    }));
    list.append(row);
  }
}

function renderInteraction() {
  const last = state.events.at(-1);
  $('reaction').textContent = last ? '「' + last.reply + '」' : '「……想做什麼？」';
  const hint = !health.aiConfigured ? '目前是示範模式，啟用 OpenAI 後會依關係與情境生成回應。'
    : last?.reactionSource === 'built-in' ? '這次使用備用回應。' : '';
  $('interactionMode').textContent = hint;
  $('interactionMode').hidden = !hint;
  $('saveShared').hidden = !last?.meaningful || state.memories.some(memory => memory.eventId === last.id);
}

function disableInteractions(disabled) {
  document.querySelectorAll('[data-touch]').forEach(btn => { btn.disabled = disabled; });
}

function render(scroll = true, previous) {
  renderHeader();
  const newRevision = !previous || state.revision === undefined || state.revision !== previous.revision;
  const changed = field => !previous || (newRevision && JSON.stringify(state[field]) !== JSON.stringify(previous[field]));
  if (changed('messages') || changed('feedbackIds') || changed('context') || changed('zone')) renderMessages(scroll);
  if (changed('memories')) renderMemories();
  renderInteraction();
  $('candidate').hidden = !candidate;
  $('revokeWidget').hidden = !state.widgetEnabled;
  $('widgetBtn').textContent = state.widgetEnabled ? '重新產生 Widget 憑證' : '產生 Widget 憑證';
  if (!$('diaryDate').value || (previous && $('diaryDate').value === previous.today)) $('diaryDate').value = state.today;
  if (previous && (changed('events') || state.today !== previous.today) && $('panel-diary').classList.contains('active')) void loadDiary();
}

function apply(result, scroll = true) {
  if (state && result.revision < state.revision) return;
  const previous = state;
  if (previous && result.context !== previous.context) candidate = undefined;
  const { widgetToken, candidate: offered, ...data } = result;
  state = { design: defaultDesign, ...previous, ...data };
  render(scroll, previous);
}

async function update(body) {
  const epoch = sessionEpoch;
  const result = await api('state', body);
  if (epoch === sessionEpoch) apply(result, false);
  return result;
}

async function refresh(initial = false) {
  if (refreshing || busy || sending || (!initial && (document.hidden || document.querySelector('dialog[open]')))) return;
  refreshing = true;
  const epoch = sessionEpoch;
  try {
    const result = await api('session');
    if (epoch !== sessionEpoch) return;
    if (state && result.accountId !== state.accountId) showLogin();
    const wasClosed = !state;
    if (!wasClosed && (busy || sending || document.querySelector('dialog[open]'))) return;
    useAccount(result.accountId);
    apply(result, wasClosed);
    $('settingsBtn').hidden = false;
    $('designBtn').hidden = !result.designVersion;
    $('retryConnection').hidden = true;
    $('access').hidden = true;
    $('room').hidden = false;
    if (wasClosed) followWidgetLink();
    $('notice').textContent = '';
    $('rateTags').replaceChildren(...state.feedbackTags.map(tag => option(tag)));
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    if (error.status === 401 && health?.cloud) showLogin();
    else if (error.status === 403 && health?.cloud) {
      showLogin();
      $('notice').textContent = error.message;
    } else {
      sessionError(error);
      $('retryConnection').hidden = Boolean(state);
    }
  } finally { refreshing = false; }
}

bindForm('loginForm', 'notice', async () => {
  await api('login', { email: $('email').value, password: $('password').value });
  $('password').value = '';
  await refresh(true);
});

function attempt(fields) {
  const signature = JSON.stringify(fields);
  if (retry?.signature !== signature) retry = { signature, id: requestId() };
  return { id: retry.id, ...fields };
}

async function sendChat(fields) {
  if (!state || sending || busy) return;
  sending = true;
  const epoch = sessionEpoch;
  $('chatForm').querySelector('button').disabled = true;
  disableInteractions(true);
  $('chatStatus').textContent = state.design.name + '正在回覆……';
  const messages = $('messages');
  if (fields.message) messages.append(node('div', fields.message, 'bubble user draft'));
  const draft = node('div', '', 'bubble draft');
  messages.append(draft);
  messages.scrollTop = messages.scrollHeight;
  try {
    const result = await api('chat', attempt(fields), delta => {
      draft.textContent += delta;
      messages.scrollTop = messages.scrollHeight;
    });
    if (epoch !== sessionEpoch) return;
    apply(result);
    if (fields.message === $('messageInput').value.trim()) $('messageInput').value = '';
    if (state?.revision === result.revision && result.candidate) {
      candidate = result.candidate;
      $('candidate').hidden = false;
    }
    retry = undefined;
    $('chatStatus').textContent = '';
  } catch (error) {
    sessionError(error, 'chatStatus');
  } finally {
    messages.querySelectorAll('.draft').forEach(item => item.remove());
    sending = false;
    disableInteractions(false);
    $('chatForm').querySelector('button').disabled = false;
  }
}

$('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  const message = $('messageInput').value.trim();
  if (message) void sendChat({ message });
});

async function interact(type) {
  if (busy || sending) return;
  busy = true;
  disableInteractions(true);
  if (interactionRetry?.type !== type) interactionRetry = { type, id: requestId() };
  $('reaction').textContent = state.design.name + '正在回應……';
  $('interactionMode').hidden = true;
  $('saveShared').hidden = true;
  try {
    await update({ action: 'interaction', ...interactionRetry });
    interactionRetry = undefined;
  } catch (error) { sessionError(error, 'reaction'); }
  finally {
    busy = false;
    disableInteractions(false);
  }
}

document.querySelectorAll('[data-touch]').forEach(btn => {
  btn.onclick = () => interact(btn.dataset.touch);
});

function openMemory(existing = {}) {
  memoryDraft = existing;
  const form = $('memoryForm');
  form.reset();
  $('memoryType').value = existing.type || 'core';
  $('memoryType').disabled = !!existing.eventId;
  $('memoryInput').value = existing.content || '';
  $('memoryInput').readOnly = !!existing.eventId;
  $('importance').value = existing.importance || 3;
  $('expiry').value = existing.expiresOn || '';
  $('expiry').min = state.today;
  $('expiry').required = $('memoryType').value === 'temporary';
  $('memoryStatus').textContent = '';
  $('memoryDialog').showModal();
}
$('memoryType').onchange = () => { $('expiry').required = $('memoryType').value === 'temporary'; };
$('newMemory').onclick = () => openMemory();
$('candidate').onclick = () => openMemory({ content: candidate });
$('saveShared').onclick = () => {
  const last = state.events.at(-1);
  openMemory({ type: 'shared', eventId: last.id, content: last.date + ' 共同互動：' + actionLabels[last.type] + '。' });
};

bindForm('memoryForm', 'memoryStatus', async () => {
  await update({
    action: 'memory', id: memoryDraft.id, eventId: memoryDraft.eventId, type: $('memoryType').value,
    content: $('memoryInput').value, importance: $('importance').valueAsNumber,
    expiresOn: $('expiry').value, consent: $('memoryConsent').checked,
  });
  if ($('memoryInput').value === candidate) {
    candidate = undefined;
    $('candidate').hidden = true;
  }
  $('memoryDialog').close();
}, error => { if (error.status === 401) sessionError(error); });

function openRating(id) {
  ratedId = id;
  $('rateForm').reset();
  $('rateStatus').textContent = '';
  $('rateDialog').showModal();
}

bindForm('rateForm', 'rateStatus', async () => {
  await update({
    action: 'feedback', id: ratedId, score: $('rating').valueAsNumber, suggestion: $('suggestion').value,
    tags: [...$('rateTags').selectedOptions].map(option => option.value), consent: $('rateConsent').checked,
  });
  $('rateDialog').close();
}, error => { if (error.status === 401) sessionError(error); });

async function loadDiary(generate = false) {
  const date = $('diaryDate').value;
  if (!state || !date) return;
  const seq = ++diarySequence;
  if ($('diaryText').dataset.date !== date) $('diaryText').textContent = '';
  $('generateDiary').disabled = true;
  let canGenerate = generate && $('diaryText').dataset.date === date;
  $('diaryKind').textContent = generate ? '生成中……' : '讀取中……';
  $('diaryHint').textContent = '';
  try {
    const diary = generate ? await api('diary', { date, id: requestId() }) : await api('diary?date=' + encodeURIComponent(date));
    if (seq !== diarySequence) return;
    $('diaryKind').textContent = diaryLabels[diary.kind] + ' · ' + date;
    $('diaryText').dataset.date = date;
    $('diaryText').textContent = diary.content;
    canGenerate = diary.canGenerate && health.aiConfigured;
    $('diaryHint').textContent = !health.aiConfigured ? '體驗模式可查看互動摘要。'
      : diary.canGenerate ? '' : '這天新增互動後，就可以生成 AI 日記。';
  } catch (error) {
    if (seq === diarySequence) sessionError(error, 'diaryKind');
  } finally {
    if (seq === diarySequence) $('generateDiary').disabled = !canGenerate;
  }
}
$('diaryDate').onchange = () => loadDiary();
$('generateDiary').onclick = () => loadDiary(true);

$('settingsBtn').onclick = () => {
  $('nickname').value = state.nickname;
  $('meetDate').value = state.meetDate;
  $('zone').value = state.zone;
  $('account').textContent = state.email || '此電腦的本機房間';
  $('logout').hidden = !health.cloud;
  $('studioLink').hidden = !state.admin;
  $('legacyBtn').hidden = health.cloud || !readLocal(legacyKey);
  $('widgetDetails').checked = state.widgetEnabled ? state.widgetDetails === true : true;
  $('settingsStatus').textContent = '';
  $('settings').showModal();
};

bindForm('settingsForm', 'settingsStatus', async () => {
  await update({ action: 'settings', nickname: $('nickname').value, meetDate: $('meetDate').value, zone: $('zone').value });
  $('settings').close();
}, error => { if (error.status === 401) sessionError(error); });

$('settings').addEventListener('close', () => {
  $('widgetToken').value = '';
  $('widgetLabel').hidden = true;
});

function designValues() {
  return Object.fromEntries(Object.entries(designInputs).map(([field, id]) => [field, $(id).value.trim()]));
}

function previewDesign() {
  const draft = designValues();
  $('previewBase').textContent = baseLabels[draft.base];
  $('previewName').textContent = draft.name || '未命名角色';
  $('previewGreeting').textContent = draft.greeting || '你好。今天想聊些什麼？';
}

function fillDesign(design) {
  for (const [field, id] of Object.entries(designInputs)) $(id).value = design[field];
  previewDesign();
}

function openDesign(imported) {
  editingVersion = state.designVersion;
  fillDesign(state.design);
  editInitial = JSON.stringify(designValues());
  portraitEdited = false;
  portraitEditor.open(state.portraits, state.portraits == null ? readLocal(portraitKey()) : null);
  $('designStatus').textContent = '';
  if (imported) {
    fillDesign(imported);
    $('designWriting').open = true;
    $('designStatus').textContent = '已載入範本草稿。檢查內容後，到最下方儲存角色。';
  }
  $('designDialog').showModal();
}

$('designBtn').onclick = () => openDesign();
function closeDesign(event) {
  if ($('saveDesign').disabled || ((portraitEdited || JSON.stringify(designValues()) !== editInitial) &&
      !confirm('關閉後會捨棄未儲存的角色變更。要關閉嗎？'))) {
    event.preventDefault();
    return;
  }
  $('designDialog').close();
}
document.querySelector('[data-close="designDialog"]').onclick = closeDesign;
$('designDialog').addEventListener('cancel', closeDesign);
$('designDialog').addEventListener('close', () => {
  if (!$('designDialog').open) portraitEditor.clear();
});
$('designForm').addEventListener('input', previewDesign);
$('restoreDesign').onclick = () => {
  fillDesign(defaultDesign);
  $('designStatus').textContent = '已載入預設文字。按「儲存角色」套用。';
};

bindForm('designForm', 'designStatus', async () => {
  const epoch = sessionEpoch;
  const design = designValues();
  const form = $('designForm');
  form.inert = true;
  try {
    const portraits = await portraitEditor.payload();
    if (epoch !== sessionEpoch) return;
    await update({ action: 'design', design, portraits, expectedVersion: editingVersion });
    if (epoch !== sessionEpoch) return;
    if (portraits !== undefined) clearLegacyPortraits();
    $('designDialog').close();
    $('notice').textContent = '角色已儲存。';
  } finally { form.inert = false; }
}, error => {
  if (error.status === 401) sessionError(error);
  if (error.status === 409) $('designDialog').addEventListener('close', () => { void refresh(); }, { once: true });
});

function settingsAction(id, handler) {
  $(id).onclick = async () => {
    if ($(id).disabled || busy || sending) return;
    busy = true;
    $(id).disabled = true;
    $('settingsStatus').textContent = '';
    try { await handler(); }
    catch (error) { sessionError(error, 'settingsStatus'); }
    finally { $(id).disabled = false; busy = false; }
  };
}

settingsAction('logout', async () => {
  await api('logout', {});
  showLogin();
});

settingsAction('shareDesign', async () => {
  const template = await api('design');
  download('inori-character.json', template);
  $('settingsStatus').textContent = '已匯出角色範本。';
});

settingsAction('exportBtn', async () => {
  const backup = await api('export');
  const images = backup.portraits == null ? legacyImages(readLocal(portraitKey())) : {};
  download('inori-backup-' + state.today + '.json', { ...backup, ...(Object.keys(images).length ? { portraits: images } : {}) });
  $('settingsStatus').textContent = '已匯出私人備份。';
});

async function restore(backup) {
  if (!Array.isArray(backup?.messages) || !Array.isArray(backup?.memories)) {
    throw new Error('請選擇 INORI 的角色範本或私人備份 JSON。');
  }
  if (!confirm('匯入私人備份至空白房間，並同意有效記憶可提供給模型？')) return;
  const epoch = sessionEpoch;
  const { portraits, portrait, ...data } = backup;
  const images = Array.isArray(portraits) ? portraits : await prepareLegacyPortraits(portraits ?? (portrait ? { 普通: portrait } : {}));
  if (epoch !== sessionEpoch || !$('settings').open) return;
  await update({ action: 'import', consent: true, backup: { ...data, portraits: images } });
  if (epoch !== sessionEpoch) return;
  clearLegacyPortraits();
  $('settingsStatus').textContent = '已匯入可遷移的房間資料。';
}

$('importData').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const input = $('importFile');
  const file = input.files[0];
  if (!file || busy || sending) return;
  const epoch = sessionEpoch;
  busy = true;
  $('importData').disabled = true;
  $('settingsStatus').textContent = '正在讀取檔案……';
  try {
    if (file.size > 15_000_000) throw new Error('匯入檔案過大。');
    const raw = JSON.parse(await file.text());
    if (epoch !== sessionEpoch) return;
    if (raw?.format === designFormat) {
      if (file.size > 16_000) throw new Error('角色範本檔案過大。');
      const design = Object.fromEntries(Object.keys(designInputs).map(field => [field, raw.design?.[field]]));
      const result = await api('design-preview', { format: designFormat, design });
      if (epoch !== sessionEpoch || !$('settings').open) return;
      $('settings').close();
      openDesign(result.design);
    } else {
      $('settingsStatus').textContent = '';
      await restore(raw);
    }
  } catch (error) { sessionError(error, 'settingsStatus'); }
  finally { busy = false; $('importData').disabled = false; input.value = ''; }
};

settingsAction('legacyBtn', async () => restore(readLocal(legacyKey)));
settingsAction('resetBtn', async () => {
  if (!confirm('確定清除房間的聊天、記憶、日記、互動、評分、設定、立繪和 Widget 憑證？')) return;
  await update({ action: 'reset' });
  clearLegacyPortraits();
  candidate = undefined;
  retry = undefined;
  interactionRetry = undefined;
  $('diaryDate').value = state.today;
  $('diaryText').textContent = '';
  $('diaryKind').textContent = '';
  $('settings').close();
  render();
  if ($('panel-diary').classList.contains('active')) void loadDiary();
});

settingsAction('widgetBtn', async () => {
  if (state.widgetEnabled && !confirm('重新產生後，原本的 Widget 憑證會失效。繼續嗎？')) return;
  const result = await update({ action: 'widget', enabled: true, details: $('widgetDetails').checked });
  $('widgetToken').value = result.widgetToken;
  $('widgetLabel').hidden = false;
  $('widgetToken').select();
});

$('copyWidget').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('widgetToken').value);
    $('settingsStatus').textContent = '已複製 Widget 憑證。';
  } catch {
    $('widgetToken').select();
    $('settingsStatus').textContent = '請長按已選取的憑證並複製。';
  }
};

settingsAction('revokeWidget', async () => {
  await update({ action: 'widget', enabled: false });
  $('widgetToken').value = '';
  $('widgetLabel').hidden = true;
  $('settingsStatus').textContent = '憑證已撤銷。';
});

async function start() {
  $('retryConnection').disabled = true;
  try {
    health = await api('health');
    $('modeHint').textContent = health.aiConfigured
      ? 'OpenAI 已啟用。近期對話及相關的已同意記憶會提供給模型。'
      : 'Mock 體驗模式 · 固定示範回覆。設定伺服器 OpenAI 金鑰後可啟用 AI。';
    await refresh(true);
  } catch (error) {
    sessionError(error);
    $('retryConnection').hidden = false;
  } finally { $('retryConnection').disabled = false; }
}
$('retryConnection').onclick = start;
setInterval(() => { if (state) void refresh(); }, 15_000);
window.addEventListener('focus', () => { if (state) void refresh(); });
void start();
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
