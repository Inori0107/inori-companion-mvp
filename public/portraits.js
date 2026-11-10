import { $, api, button, node } from './client.js';

const expressions = ['普通', '微笑', '難過', '困惑', '害羞', '疲憊', '平靜'];
const countLimit = 14;
const imageLimit = 100 * 1024;
const accepted = 'image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif';

const raster = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const saved = new Map();

export function keepPortraits(ids) {
  const allowed = new Set(ids);
  for (const id of saved.keys()) if (!allowed.has(id)) saved.delete(id);
}

export function loadPortrait(id) {
  if (!saved.has(id)) {
    const request = api('portrait?id=' + encodeURIComponent(id)).then(({ image }) => {
      if (typeof image !== 'string' || !raster.test(image)) throw new Error('伺服器未回傳立繪。');
      return image;
    }).catch(error => {
      if (saved.get(id) === request) saved.delete(id);
      throw error;
    });
    saved.set(id, request);
  }
  return saved.get(id);
}

export function legacyImages(raw) {
  return Object.fromEntries(expressions.flatMap(value => {
    const image = raw?.[value];
    return typeof image === 'string' && image.length < 1_800_000 &&
      raster.test(image) ? [[value, image]] : [];
  }));
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = String(reader.result);
      const appleFormat = file.name.match(/\.(heic|heif)$/i)?.[1]?.toLowerCase();
      resolve(appleFormat ? image.replace(/^data:(?:application\/octet-stream|);/, 'data:image/' + appleFormat + ';') : image);
    };
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
  const maxEncoded = Math.floor(imageLimit / 3) * 4;
  for (const maxEdge of [1024, 800, 600, 420, 256]) {
    const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    if (raster.test(png) && png.slice(png.indexOf(',') + 1).length <= maxEncoded) return png;
    // Keep transparency on artwork. Use JPEG for large photos or if a small PNG still exceeds the limit.
    if (maxEdge > 420 && !/^data:image\/(?:jpeg|heic|heif);/i.test(source)) continue;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#21192b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    for (const quality of [0.85, 0.66]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (raster.test(jpeg) && jpeg.slice(jpeg.indexOf(',') + 1).length <= maxEncoded) return jpeg;
    }
  }
  throw new Error('無法壓縮這張立繪，請換一張較小的圖片。');
}

export async function prepareLegacyPortraits(images) {
  return Promise.all(Object.entries(legacyImages(images)).map(async ([value, source]) => ({
    name: '', kind: 'expression', value, image: await compressed(source),
  })));
}

export function createPortraitEditor(actions, onChange) {
  const defaultSlot = { kind: 'expression', value: '普通', title: '預設立繪' };
  const faces = [
    { kind: 'expression', value: '微笑', title: '微笑' },
    { kind: 'expression', value: '害羞', title: '害羞' },
    { kind: 'expression', value: '難過', title: '低落' },
  ];
  const gestures = ['head', 'hand', 'hug', 'sing'].map(value => ({ kind: 'interaction', value, title: actions[value] }));
  const groups = [
    [$('portraitRows'), [defaultSlot]], [$('portraitExpressions'), faces], [$('portraitActions'), gestures],
  ];
  const legacyList = $('portraitLegacyRows');
  const legacyPanel = $('portraitLegacy');
  let draft = [];
  let initialized = false;
  const hasImage = item => Boolean(item.id || item.image || item.legacy || item.pending);

  function makeRow(item, title, retired = false) {
    const row = node('article', undefined, 'portrait-row portrait-slot');
    row.setAttribute('aria-label', title);
    const preview = node('img', undefined, 'portrait-thumb');
    preview.alt = '';
    const status = node('p', '', 'hint portrait-row-status');
    status.setAttribute('aria-live', 'polite');
    let previewVersion = 0;
    const file = node('input');
    file.type = 'file';
    file.accept = accepted;
    file.hidden = true;
    file.setAttribute('aria-label', title + '檔案');
    const select = button('選擇圖片', () => file.click());
    select.setAttribute('aria-label', title + '・選擇圖片');
    select.hidden = retired;
    const remove = button('移除', () => {
      if (retired) {
        draft = draft.filter(value => value !== item);
        row.remove();
        legacyPanel.hidden = !legacyList.children.length;
      } else {
        delete item.id;
        delete item.image;
        delete item.legacy;
        showImage();
      }
      onChange();
    });
    remove.setAttribute('aria-label', title + '・移除');
    preview.onerror = () => {
      preview.hidden = true;
      status.textContent = '圖片無法解碼，請重新選擇 PNG 或 JPG。';
    };

    function showImage() {
      const version = ++previewVersion;
      const src = item.image || item.legacy;
      preview.hidden = !src;
      remove.hidden = !hasImage(item);
      select.textContent = hasImage(item) ? '更換圖片' : '選擇圖片';
      if (src) preview.src = src;
      else preview.removeAttribute('src');
      status.textContent = item.legacy ? '舊版立繪・儲存後同步' : item.image ? '圖片已加入草稿'
        : item.id ? '已儲存，載入圖片中……' : '尚未選擇圖片';
      if (item.id && !src) void loadPortrait(item.id).then(image => {
        if (version !== previewVersion) return;
        preview.src = image;
        preview.hidden = false;
        status.textContent = '已儲存';
      }).catch(error => {
        if (version !== previewVersion) return;
        status.textContent = '圖片讀取失敗' + (error.status ? '（HTTP ' + error.status + '）' : '') + '。' +
          (error.status === 404 ? ' 請重新整理房間，或更換這張圖片。' : '');
      });
    }
    showImage();

    file.onchange = async () => {
      const source = file.files[0];
      file.value = '';
      if (!source) return;
      if (source.size > 20_000_000 || source.type === 'image/svg+xml') {
        status.textContent = '請選擇 20 MB 以下的點陣圖片。';
        return;
      }
      previewVersion++;
      status.textContent = '正在準備圖片……';
      onChange();
      select.disabled = true;
      remove.disabled = true;
      item.pending = readImageFile(source).then(compressed);
      try {
        item.image = await item.pending;
        delete item.legacy;
        showImage();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        delete item.pending;
        select.disabled = false;
        remove.disabled = false;
      }
    };
    const controls = node('div', undefined, 'toolbar');
    controls.append(select, remove);
    const content = node('div', undefined, 'portrait-slot-content');
    content.append(node('strong', title), status, controls, file);
    row.append(preview, content);
    return row;
  }

  function clear() {
    draft = [];
    for (const [list] of groups) list.replaceChildren();
    legacyList.replaceChildren();
    legacyPanel.hidden = true;
  }

  return {
    open(portraits, legacy) {
      clear();
      const stored = Array.isArray(portraits) ? portraits.map(item => ({ ...item })) : Object.entries(legacyImages(legacy))
        .map(([value, image]) => ({ name: '', kind: 'expression', value, legacy: image }));
      initialized = Array.isArray(portraits) || stored.length > 0;
      for (const [list, slots] of groups) {
        for (const slot of slots) {
          const index = stored.findIndex(item => item.kind === slot.kind && item.value === slot.value);
          const item = index < 0 ? { kind: slot.kind, value: slot.value, name: '' } : stored.splice(index, 1)[0];
          draft.push(item);
          list.append(makeRow(item, slot.title));
        }
      }
      draft.push(...stored);
      legacyList.replaceChildren(...stored.map(item => makeRow(item, item.name || actions[item.value] || item.value, true)));
      legacyPanel.hidden = !stored.length;
    },
    clear,
    async payload() {
      const filled = draft.filter(hasImage);
      if (!initialized && !filled.length) return undefined;
      if (filled.length > countLimit) throw new Error('最多可儲存 14 張立繪。請先移除不用的舊圖。');
      return Promise.all(filled.map(async item => {
        await item.pending;
        const { id, name, kind, value } = item;
        const image = item.image || (item.legacy ? await compressed(item.legacy) : undefined);
        if (!id && !image) throw new Error('請為這個位置選擇圖片。');
        return { id, name, kind, value, image };
      }));
    },
  };
}
