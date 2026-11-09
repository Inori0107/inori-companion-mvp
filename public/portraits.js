import { $, button, node, option } from './client.js';

const expressions = ['普通', '微笑', '難過', '困惑', '害羞', '疲憊', '平靜'];
const kinds = { expression: '表情', interaction: '互動動作', keyword: '對話關鍵字' };
const countLimit = 14;
const imageLimit = 100 * 1024;
const accepted = 'image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif';

export function portraitURL(id) { return '/api/portraits/' + encodeURIComponent(id); }

export function legacyImages(raw) {
  return Object.fromEntries(expressions.flatMap(value => {
    const image = raw?.[value];
    return typeof image === 'string' && image.length < 1_800_000 &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ? [[value, image]] : [];
  }));
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('讀取立繪失敗，請重新選擇圖片。'));
    reader.readAsDataURL(file);
  });
}

async function compressed(source) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('無法開啟這張圖片，請試用 PNG、JPG 或 WebP。'));
    image.src = source;
  });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器無法處理立繪。');
  for (const maxEdge of [1024, 800, 600, 420, 256]) {
    const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.84, 0.66]) {
      let data = canvas.toDataURL('image/webp', quality);
      if (!data.startsWith('data:image/webp') && data.length > imageLimit * 4 / 3) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#21192b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
        data = canvas.toDataURL('image/jpeg', quality);
      }
      if (data.startsWith('data:image/') && data.slice(data.indexOf(',') + 1).length <= Math.floor(imageLimit / 3) * 4) return data;
    }
  }
  throw new Error('無法壓縮這張立繪，請換一張較小的圖片。');
}

function label(title, field) {
  const wrapper = node('label', title);
  field.setAttribute('aria-label', title);
  wrapper.append(field);
  return wrapper;
}

export async function prepareLegacyPortraits(images) {
  return Promise.all(Object.entries(legacyImages(images)).map(async ([value, source]) => ({
    name: '', kind: 'expression', value, image: await compressed(source),
  })));
}

export function createPortraitEditor(actions, onChange) {
  const list = $('portraitRows');
  const add = $('addPortrait');
  let draft = [];
  let initialized = false;
  const options = { expression: expressions.map(value => [value, value]), interaction: Object.entries(actions) };

  function syncAdd() { add.disabled = draft.length >= countLimit; }

  function makeRow(item) {
    const row = node('article', undefined, 'portrait-row');
    const preview = node('img', undefined, 'portrait-thumb');
    preview.alt = '';
    preview.loading = 'lazy';
    const status = node('p', '', 'hint portrait-row-status');
    status.setAttribute('aria-live', 'polite');
    function showImage() {
      const src = item.image || item.legacy || (item.id ? portraitURL(item.id) : '');
      preview.hidden = !src;
      if (src) preview.src = src;
      else preview.removeAttribute('src');
      status.textContent = item.legacy ? '舊版立繪・儲存後同步' : item.image ? '圖片已加入草稿'
        : item.id ? '已儲存' : '尚未選擇圖片';
    }
    showImage();

    const name = node('input');
    name.maxLength = 32;
    name.value = item.name;
    name.placeholder = '選填';
    name.oninput = () => { item.name = name.value; onChange(); };
    const kind = node('select');
    kind.append(...Object.entries(kinds).map(([value, title]) => option(title, value)));
    kind.value = item.kind;
    const trigger = node('select');
    const keyword = node('input');
    keyword.maxLength = 40;
    keyword.placeholder = '例如：唱歌';
    const choiceField = label('對應表情或動作', trigger);
    const keywordField = label('對話關鍵字', keyword);
    function showTrigger() {
      keywordField.hidden = item.kind !== 'keyword';
      choiceField.hidden = !keywordField.hidden;
      if (item.kind === 'keyword') keyword.value = item.value;
      else {
        trigger.replaceChildren(...options[item.kind].map(([value, title]) => option(title, value)));
        trigger.value = item.value;
      }
    }
    showTrigger();
    kind.onchange = () => {
      item.kind = kind.value;
      item.value = options[item.kind]?.[0]?.[0] ?? '';
      showTrigger();
      onChange();
    };
    trigger.onchange = () => { item.value = trigger.value; onChange(); };
    keyword.oninput = () => { item.value = keyword.value; onChange(); };

    const file = node('input');
    file.type = 'file';
    file.accept = accepted;
    file.hidden = true;
    file.setAttribute('aria-label', '立繪檔案');
    const select = button('選擇圖片', () => file.click());
    const remove = button('移除', () => {
      draft = draft.filter(value => value !== item);
      row.remove();
      syncAdd();
      onChange();
    });
    file.onchange = async () => {
      const source = file.files[0];
      file.value = '';
      if (!source) return;
      if (source.size > 20_000_000 || source.type === 'image/svg+xml') {
        status.textContent = '請選擇 20 MB 以下的點陣圖片。';
        return;
      }
      status.textContent = '正在準備圖片……';
      onChange();
      select.disabled = true;
      item.pending = compressedFile(source);
      try {
        item.image = await item.pending;
        delete item.legacy;
        showImage();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        delete item.pending;
        select.disabled = false;
      }
    };
    const imageControls = node('div', undefined, 'portrait-image-controls');
    const controls = node('div', undefined, 'toolbar');
    controls.append(select, remove);
    imageControls.append(preview, status, controls, file);
    const fields = node('div', undefined, 'portrait-fields');
    fields.append(label('立繪名稱', name), label('觸發方式', kind), choiceField, keywordField);
    row.append(imageControls, fields);
    return row;
  }

  async function compressedFile(file) { return compressed(await readImageFile(file)); }

  add.onclick = () => {
    if (draft.length >= countLimit) return;
    const unused = kind => options[kind].find(([value]) => !draft.some(item => item.kind === kind && item.value === value))?.[0];
    const expression = unused('expression');
    const interaction = unused('interaction');
    const kind = expression ? 'expression' : interaction ? 'interaction' : 'keyword';
    const item = { name: '', kind, value: expression ?? interaction ?? '' };
    draft.push(item);
    onChange();
    const row = makeRow(item);
    list.append(row);
    syncAdd();
    row.querySelector('button').focus();
  };

  return {
    open(portraits, legacy) {
      initialized = Array.isArray(portraits);
      draft = initialized ? portraits.map(item => ({ ...item })) : Object.entries(legacyImages(legacy))
        .map(([value, image]) => ({ name: '', kind: 'expression', value, legacy: image }));
      initialized ||= draft.length > 0;
      list.replaceChildren(...draft.map(makeRow));
      syncAdd();
    },
    clear() {
      draft = [];
      list.replaceChildren();
    },
    async payload() {
      if (!initialized && !draft.length) return undefined;
      return Promise.all(draft.map(async item => {
        await item.pending;
        const { id, name, kind, value } = item;
        const image = item.image || (item.legacy ? await compressed(item.legacy) : undefined);
        if (!value.trim()) throw new Error('請填入每張立繪的觸發條件。');
        if (!id && !image) throw new Error('請為每張新增立繪選擇圖片。');
        return { id, name, kind, value, image };
      }));
    },
  };
}
