import {
  actionLabels, actions, dateAt, day, object, Problem, text, timeZone, updateMemory,
  type AppData, type Interaction, type Message,
} from './domain.js';
import { randomUUID } from 'node:crypto';
import { validateDesign } from './design.js';
import { savePortraits } from './portraits.js';

export function exported(data: AppData) {
  const { widgetHash, widgetDetails, pending, usage, receipts, ...profile } = data;
  return { format: 'inori-companion-v2', ...profile };
}

export function importBackup(data: AppData, value: unknown, now: Date) {
  const raw = object(value);
  if (!Array.isArray(raw.messages) || !Array.isArray(raw.memories)) throw new Problem(400, '備份格式不正確。');
  if (data.design || data.portraits?.length || data.messages.length > 1 ||
      data.messages.some(message => message.role === 'user' || message.at === null) || data.memories.length || data.events.length) {
    throw new Problem(409, '私人備份只能匯入空白房間。請先匯出現有資料再清除房間。');
  }
  if (raw.zone) data.zone = timeZone(raw.zone);
  data.nickname = typeof raw.nickname === 'string' ? text(raw.nickname.slice(0, 24), 24, false) : '';
  if (raw.meetDate) data.meetDate = day(raw.meetDate);
  const isV2 = raw.format === 'inori-companion-v2';
  if (isV2 && raw.design !== undefined) data.design = raw.design === null ? null : validateDesign(raw.design);
  if (Array.isArray(raw.portraits)) {
    data.portraits = savePortraits(raw.portraits.map(item => {
      const { id, ...portrait } = object(item);
      return portrait;
    }), []);
  }
  const restored = raw.messages.slice(-5000).flatMap((value): Message[] => {
    const row = object(value);
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    if (typeof row.content !== 'string' || !row.content.trim()) return [];
    const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toISOString() : null;
    return [{ id: randomUUID(), role: row.role, content: row.content.slice(0, 12_000), at }];
  });
  if (restored.length) data.messages = restored;
  const legacy = (type: unknown, date: string): Interaction[] => {
    const action = actions.find(action => action === type);
    return action ? [{
      id: randomUUID(), type: action, date, at: date + 'T12:00:00Z',
      reply: actionLabels[action] + '（備份紀錄）', before: null, after: null, meaningful: false, legacy: true,
    }] : [];
  };
  if (isV2 && Array.isArray(raw.events)) {
    data.events = raw.events.slice(-3000).flatMap(item => {
      const row = object(item);
      return legacy(row.type, day(row.date));
    });
  } else if (raw.interactions) {
    data.events = Object.entries(object(raw.interactions)).flatMap(([date, types]) =>
      Array.isArray(types) ? types.slice(0, 300).flatMap(type => legacy(type, day(date))) : [],
    ).slice(-3000);
  }
  const today = dateAt(now, data.zone);
  for (const item of raw.memories.slice(0, 150)) {
    const memory = typeof item === 'string' ? { type: 'core', content: item, importance: 3 } : object(item);
    if (memory.type === 'shared' || (typeof memory.expiresOn === 'string' && memory.expiresOn < today)) continue;
    const content = text(memory.content, 400);
    if (data.memories.some(entry => entry.content === content)) continue;
    updateMemory(data, { ...memory, id: undefined, consent: true }, now);
    data.memories.at(-1)!.source = isV2 ? 'backup-v2' : 'backup-v1';
  }
}
