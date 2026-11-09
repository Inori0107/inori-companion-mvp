import { randomUUID } from 'node:crypto';
import { actions, object, Problem, text, uuid, type AppData } from './domain.js';

export const portraitLimit = 14;
const imageLimit = 100 * 1024;
export const expressions = ['普通', '微笑', '難過', '困惑', '害羞', '疲憊', '平靜'];
const triggerKinds = ['expression', 'interaction', 'keyword'] as const;

export type PortraitInfo = {
  id: string;
  name: string;
  kind: typeof triggerKinds[number];
  value: string;
};
export type Portrait = PortraitInfo & { image: string };

export function portraitInfo({ id, name, kind, value }: Portrait): PortraitInfo {
  return { id, name, kind, value };
}

export function portraitImage(value: unknown) {
  if (typeof value !== 'string' || value.length > Math.ceil(imageLimit / 3) * 4 + 30) {
    throw new Problem(400, '每張立繪壓縮後須小於 100 KB。');
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Problem(400, '立繪格式不正確。');
  const [, format, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  const valid = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length > imageLimit || bytes.toString('base64') !== encoded) throw new Problem(400, '立繪檔案不正確或超過大小限制。');
  return { mime: 'image/' + format, bytes };
}

function normalized(value: string) { return value.normalize('NFKC').toLowerCase(); }

export function savePortraits(raw: unknown, existing: Portrait[]) {
  if (!Array.isArray(raw) || raw.length > portraitLimit) throw new Problem(400, '最多可儲存 14 張立繪。');
  const triggers = new Set<string>();
  const ids = new Set<string>();
  return raw.map(entry => {
    const row = object(entry);
    const kind = triggerKinds.find(kind => kind === row.kind);
    if (!kind) throw new Problem(400, '請選擇立繪觸發類型。');
    const value = text(row.value, 40);
    if ((kind === 'expression' && !expressions.includes(value)) || (kind === 'interaction' && !actions.some(action => action === value))) {
      throw new Problem(400, '請選擇有效的表情或動作。');
    }
    const trigger = kind + ':' + normalized(value);
    if (triggers.has(trigger)) throw new Problem(400, '每個觸發條件只能指定一張立繪。');
    triggers.add(trigger);
    const name = text(row.name ?? '', 32, false);
    const old = row.id ? existing.find(item => item.id === uuid(row.id)) : undefined;
    if (row.id && (!old || ids.has(old.id))) throw new Problem(400, '找不到這張立繪，請重新開啟表單。');
    if (old) ids.add(old.id);
    if (row.image !== undefined) {
      portraitImage(row.image);
      return { id: randomUUID(), name, kind, value, image: row.image as string };
    }
    if (!old) throw new Problem(400, '請為每張新增立繪選擇圖片。');
    return { id: old.id, name, kind, value, image: old.image };
  });
}

export function activePortrait(data: AppData, expression: string) {
  const portraits = data.portraits ?? [];
  const interaction = data.events.findLast(event => !event.legacy);
  const reply = data.messages.at(-1);
  const user = data.messages.at(-2);
  const hasTurn = reply?.role === 'assistant' && reply.meta && reply.context === data.context && reply.turnId &&
    user?.role === 'user' && user.turnId === reply.turnId;
  const interactionIsLatest = interaction && (data.lastActivity === 'interaction' ||
    (!data.lastActivity && (!reply?.meta || (reply.at ?? '') < interaction.at)));
  if (interactionIsLatest) {
    const action = portraits.find(p => p.kind === 'interaction' && p.value === interaction.type);
    if (action) return action.id;
  } else if (hasTurn) {
    const lines = [normalized(user.content), normalized(reply.content)];
    const keyword = portraits.filter(p => p.kind === 'keyword' && lines.some(line => line.includes(normalized(p.value))))
      .sort((a, b) => b.value.length - a.value.length)[0];
    if (keyword) return keyword.id;
  }
  return (portraits.find(p => p.kind === 'expression' && p.value === expression)
    ?? portraits.find(p => p.kind === 'expression' && p.value === '普通'))?.id ?? null;
}
