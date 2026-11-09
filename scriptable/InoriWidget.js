// 在 Scriptable 新建腳本、貼上內容，再指定此腳本為中尺寸主畫面小工具。
// 從房間設定產生專用唯讀憑證。請使用自己的 HTTPS 網址。
const CHAT_URL = 'https://example.com';
const WIDGET_TOKEN = '';
const CHARACTER_NAME = '楪祈'; // API 不可用時使用
const MEET_DATE = '2026-11-07'; // API 不可用時使用
const fm = FileManager.local();
const imagePath = fm.joinPath(fm.documentsDirectory(), 'inori.png');

function localFallback() {
  const now = new Date();
  const hour = now.getHours();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(MEET_DATE)) / 86400000) + 1) || 1;
  const anniversary = days > 1 && today.slice(5) === MEET_DATE.slice(5);
  const greeting = anniversary ? '今天是我們的相遇紀念日。' : hour < 6 ? '夜深了。休息一下吧。'
    : hour < 12 ? '早安。' : hour < 18 ? '午安。記得休息一下。' : '晚安。今天辛苦了。';
  return { name: CHARACTER_NAME, greeting, days, mood: '本機台詞' };
}

let state = localFallback();
if (/^https:\/\//i.test(CHAT_URL) && /^[\w-]{43}$/.test(WIDGET_TOKEN)) {
  try {
    const request = new Request(CHAT_URL.replace(/\/$/, '') + '/api/widget');
    request.headers = { Authorization: 'Bearer ' + WIDGET_TOKEN };
    request.timeoutInterval = 5;
    const result = await request.loadJSON();
    if (request.response?.statusCode === 200 && typeof result.greeting === 'string' &&
        typeof result.mood === 'string' && Number.isInteger(result.days)) state = result;
  } catch { /* 使用本機台詞。 */ }
}

const widget = new ListWidget();
widget.backgroundColor = new Color('#1d1a2a');
widget.setPadding(14, 15, 13, 15);
widget.url = CHAT_URL;
const title = widget.addText('✦  INORI   /   ' + (state.name || CHARACTER_NAME));
title.lineLimit = 1;
title.font = Font.semiboldSystemFont(12);
title.textColor = new Color('#e8afc5');
widget.addSpacer(6);
if (fm.fileExists(imagePath)) {
  try {
    const image = widget.addImage(fm.readImage(imagePath));
    image.imageSize = new Size(48, 48);
    image.cornerRadius = 12;
    widget.addSpacer(5);
  } catch { /* 遇到損毀的圖片時仍顯示文字。 */ }
}
const quote = widget.addText('「' + state.greeting + '」');
quote.font = Font.mediumSystemFont(14);
quote.textColor = Color.white();
quote.lineLimit = 2;
widget.addSpacer();
const foot = widget.addText('相遇第 ' + state.days + ' 天   ·   ' + state.mood);
foot.font = Font.systemFont(10);
foot.textColor = new Color('#c8b3c7');
widget.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000); // iOS 決定實際更新時間
Script.setWidget(widget);
if (!config.runsInWidget) await widget.presentMedium();
Script.complete();
