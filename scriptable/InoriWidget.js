// 填入 Vercel 正式 HTTPS 網址及房間產生的 Widget 專用憑證，再選用中尺寸。
const CHAT_URL = 'https://example.com';
const WIDGET_TOKEN = '';
const CHARACTER_NAME = '楪祈'; // 離線時使用
const MEET_DATE = '2026-11-07'; // 離線時使用

const roomURL = CHAT_URL.trim().match(/^https:\/\/[a-z0-9.-]+(?::\d+)?(?=[/?#]|$)/i)?.[0];
const configured = Boolean(roomURL && roomURL.toLowerCase() !== 'https://example.com');

function localFallback() {
  const now = new Date();
  const hour = now.getHours();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(MEET_DATE)) / 86400000) + 1) || 1;
  const anniversary = days > 1 && today.slice(5) === MEET_DATE.slice(5);
  const greeting = anniversary ? '今天是我們的相遇紀念日。' : hour < 6 ? '夜深了。休息一下吧。'
    : hour < 12 ? '早安。' : hour < 18 ? '午安。記得休息一下。' : '晚安。今天辛苦了。';
  return { name: CHARACTER_NAME, greeting, days };
}

async function roomState() {
  const fallback = localFallback();
  if (!configured) return { ...fallback, status: '請設定正式網址' };
  const token = WIDGET_TOKEN.trim();
  if (!/^[\w-]{43}$/.test(token)) return { ...fallback, status: '請填 Widget 憑證' };

  const request = new Request(roomURL + '/api/widget');
  request.headers = { Authorization: 'Bearer ' + token };
  request.timeoutInterval = 8;
  request.onRedirect = () => null;
  let body;
  try { body = await request.loadString(); }
  catch {
    if (!request.response) return { ...fallback, status: '連線失敗・本機台詞' };
  }
  const status = request.response?.statusCode;
  if (status === 401 || status === 403) {
    let rejected;
    try { rejected = JSON.parse(body); } catch { /* A deployment protection page can return HTML. */ }
    return { ...fallback, status: typeof rejected?.error === 'string' && rejected.error.includes('小工具憑證') ? '憑證無效，請重新產生' : '部署存取受限' };
  }
  if (status === 404) return { ...fallback, status: '找不到 Widget API' };
  if (status >= 300 && status < 400) return { ...fallback, status: '網址有轉址，請用正式網址' };
  if (status !== 200) return { ...fallback, status: '房間暫時無法連線' };
  try {
    const result = JSON.parse(body);
    if (typeof result.greeting !== 'string' || typeof result.mood !== 'string' || !Number.isInteger(result.days)) {
      return { ...fallback, status: 'Widget API 回應格式不符' };
    }
    return { ...result, status: result.scene ? '已連線・' + result.mood : '已連線・僅問候' };
  } catch { return { ...fallback, status: '網址回傳網頁，請確認部署' }; }
}

function widgetPortrait(source) {
  const encoded = typeof source === 'string' && source.length <= 137_000
    ? source.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)?.[1] : null;
  if (encoded) {
    try {
      const data = Data.fromBase64String(encoded);
      const image = data && Image.fromData(data);
      if (image) return image;
    } catch { /* Use the optional local image. */ }
  }
  const fm = FileManager.local();
  const path = fm.joinPath(fm.documentsDirectory(), 'inori.png');
  try { return fm.fileExists(path) ? fm.readImage(path) : null; }
  catch { return null; }
}

const state = await roomState();
const picture = widgetPortrait(state.scene?.portrait);
const pink = new Color('#e8afc5');
const muted = new Color('#c8b3c7');
const widget = new ListWidget();
widget.backgroundColor = new Color('#1d1a2a');
widget.setPadding(12, 14, 12, 14);
if (configured) widget.url = roomURL;

const row = widget.addStack();
row.layoutHorizontally();
row.centerAlignContent();
if (picture) {
  const image = row.addImage(picture);
  image.imageSize = new Size(68, 68);
  image.cornerRadius = 12;
  image.applyFittingContentMode();
  row.addSpacer(11);
}
const text = row.addStack();
text.layoutVertically();
const title = text.addText('✦  ' + (state.name || CHARACTER_NAME));
title.font = Font.semiboldSystemFont(15);
title.textColor = pink;
title.lineLimit = 1;
text.addSpacer(4);
const greeting = text.addText('「' + state.greeting + '」');
greeting.font = Font.mediumSystemFont(13);
greeting.textColor = Color.white();
greeting.lineLimit = 2;
if (state.scene?.interaction) {
  text.addSpacer(3);
  const interaction = text.addText('最近互動 · ' + state.scene.interaction);
  interaction.font = Font.systemFont(10);
  interaction.textColor = muted;
  interaction.lineLimit = 1;
}

widget.addSpacer();
const footer = widget.addStack();
footer.layoutHorizontally();
footer.centerAlignContent();
const caption = !picture && state.scene
  ? state.scene.portrait ? '已連線・圖片無法顯示' : '已連線・目前無立繪'
  : state.status;
const status = footer.addText(caption + ' · 第 ' + state.days + ' 天');
status.font = Font.systemFont(10);
status.textColor = muted;
status.lineLimit = 1;
if (configured) {
  footer.addSpacer();
  const link = footer.addStack();
  link.url = roomURL + '/#interact';
  const tap = link.addText('互動 ↗');
  tap.font = Font.semiboldSystemFont(12);
  tap.textColor = pink;
  tap.lineLimit = 1;
}

widget.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000); // 更新時間由 iOS 決定
Script.setWidget(widget);
if (!config.runsInWidget) await widget.presentMedium();
Script.complete();
