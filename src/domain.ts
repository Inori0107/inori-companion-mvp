import { randomUUID } from 'node:crypto';
import type { Design } from './design.js';
import type { Portrait } from './portraits.js';

export const firstGreeting = '……你來了。今天過得好嗎？';

export class Problem extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Problem(400, '資料格式不正確。');
  return value as Record<string, unknown>;
}

export function text(value: unknown, max: number, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new Problem(400, '請檢查文字長度與必填欄位。');
  }
  return value.trim();
}

export function whole(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Problem(400, '數值超出範圍。');
  }
  return value;
}

export function day(value: unknown) {
  const date = text(value, 10);
  const time = Date.parse(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new Problem(400, '日期不正確。');
  }
  return date;
}

export function uuid(value: unknown) {
  const id = text(value, 36);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Problem(400, '識別碼不正確。');
  return id;
}

export function timeZone(value: unknown) {
  const zone = text(value, 100);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); }
  catch { throw new Problem(400, '時區不正確。'); }
  return zone;
}

export function dateAt(now: Date, zone = 'Asia/Taipei') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const initialState = { trust: 10, familiarity: 8, mood: 0, energy: 70, comfort: 18 };
export type CharacterState = typeof initialState;
export const actions = ['hello', 'head', 'hand', 'hug', 'sing', 'listen', 'feeling'] as const;
export type InteractionType = typeof actions[number];
export const feelings = ['good', 'tired', 'down'] as const;
type Feeling = typeof feelings[number];
const tiredBelow = 48;
const feelingReply: Record<Feeling, { reply: string; mood: number }> = {
  good: { reply: '聽你這麼說，我也有點開心。', mood: 5 },
  tired: { reply: '辛苦了。要不要先歇一會兒？', mood: -2 },
  down: { reply: '嗯。我可以陪你安靜一會兒。', mood: -8 },
};
export const actionLabels = {
  hello: '打招呼', head: '摸頭', hand: '牽手', hug: '擁抱',
  sing: '一起唱歌', listen: '聽歌', feeling: '分享心情',
};

export type Interaction = {
  id: string; date: string; at: string; type: InteractionType; reply: string;
  before: CharacterState | null; after: CharacterState | null; meaningful: boolean; legacy?: boolean; feeling?: Feeling;
};
export function stage(state: CharacterState, sharedCount: number) {
  if (state.trust >= 70 && state.comfort >= 65 && sharedCount >= 5) return '深厚陪伴';
  if (state.trust >= 42 && state.familiarity >= 32 && sharedCount >= 2) return '信任';
  if (state.familiarity >= 20 && state.comfort >= 24) return '熟悉';
  return '初識';
}

export function expression(state: CharacterState) {
  if (state.energy < tiredBelow) return '疲憊';
  if (state.mood <= -8) return '難過';
  if (state.mood >= 24) return '微笑';
  if (state.comfort < 12) return '困惑';
  if (state.comfort < 29 && state.mood >= 12) return '害羞';
  return state.familiarity < 20 ? '普通' : '平靜';
}

export function interaction(type: InteractionType, before: CharacterState, recent: Interaction[], at: Date, zone: string, feeling?: Feeling): Interaction {
  const physical = type === 'head' || type === 'hand' || type === 'hug';
  const welcome = !physical || (before.comfort >= (type === 'hug' ? 38 : 27) && before.energy >= 30);
  const date = dateAt(at, zone);
  const todayEvents = recent.filter(event => event.date === date && !event.legacy);
  const repeated = todayEvents.some(event => event.type === type);
  const meaningful = !repeated && (type === 'feeling' || type === 'listen' || type === 'sing') && before.energy >= 30;
  const tired = before.energy < tiredBelow;
  const reaction = type === 'feeling' && feeling ? feelingReply[feeling] : undefined;
  const lines: Record<InteractionType, string> = {
    hello: before.familiarity < 20 ? '你好。……今天過得怎麼樣？' : '你來了。今天想聊點什麼？',
    head: '嗯……輕一點就好。',
    hand: '嗯。慢慢來就好。',
    hug: '可以。就安靜地待一會兒。',
    sing: tired ? '今天有點累。可以先聽一會兒嗎？' : '從你熟悉的旋律開始吧。',
    listen: '好。這首歌，有哪一段你特別喜歡？',
    feeling: reaction?.reply ?? '嗯。你想說多少都可以。',
  };
  const reply = !welcome ? '我想先保持一點距離。坐在這裡聊聊，可以嗎？'
    : type === 'hand' && todayEvents.filter(event => event.type === 'hand').length === 2
      ? '第三次了。……我有留意。'
      : type === 'hug' && todayEvents.at(-1)?.type === 'head'
        ? '剛剛才摸了頭。……這次可以。'
        : before.mood <= -18 && type === 'hello' ? '你好。今天想安靜一點，可以嗎？' : lines[type];
  const clamp = (value: number, min = 0) => Math.max(min, Math.min(100, value));
  const after = {
    trust: clamp(before.trust + (meaningful ? 3 : welcome && !physical && !repeated ? 1 : 0)),
    familiarity: clamp(before.familiarity + (welcome && !repeated ? 2 : 0)),
    mood: clamp(before.mood + (!repeated ? reaction?.mood ?? (welcome ? meaningful ? 4 : 2 : -3) : 0), -100),
    energy: clamp(before.energy + (tired && !physical ? 5 : !repeated && welcome ? type === 'sing' ? -8 : -3 : 0)),
    comfort: clamp(before.comfort + (welcome ? repeated ? 0 : meaningful ? 3 : 2 : repeated ? 0 : -1)),
  };
  return { id: randomUUID(), date, at: at.toISOString(), type, reply, before, after, meaningful, feeling };
}

export const memoryTypes = ['core', 'event', 'shared', 'temporary'] as const;
export type Memory = {
  id: string; type: typeof memoryTypes[number]; content: string; source: string; eventId?: string;
  confidence: number; importance: number; createdAt: string; updatedAt: string;
  lastConfirmedAt: string; expiresOn: string | null; consent: true; status: 'active';
};
export type MemoryChange = { id: string; at: string; action: 'create' | 'update' | 'delete' | 'expire' };
export const feedbackTags = ['符合角色', '語氣不自然', '太熱情', '太冷淡', '太冗長', '過度使用省略號', '原作設定錯誤', '記憶錯誤', '回答不切題', '關係發展不自然', '其他問題'];
export type Message = {
  id: string; role: 'user' | 'assistant'; content: string; at: string | null; turnId?: string;
  context?: number; meta?: { model: string; version: string; state: CharacterState; memoryIds: string[]; expression: string };
};
export type Feedback = {
  messageId: string; input: string; reply: string; model: string; version: string;
  state: CharacterState; memoryIds: string[]; score: number; tags: string[]; suggestion: string; at: string;
};
export type Journal = { date: string; kind: 'ai' | 'summary' | 'example'; content: string; eventIds: string[]; model?: string };
export type AppData = {
  design?: Design | null;
  portraits?: Portrait[] | null;
  lastActivity?: 'chat' | 'interaction' | null;
  nickname: string; meetDate: string; zone: string; state: CharacterState; stateDate: string; context: number;
  memories: Memory[]; memoryEvents: MemoryChange[]; messages: Message[]; events: Interaction[];
  feedback: Feedback[]; journals: Journal[]; widgetHash: string | null; widgetDetails?: boolean;
  usage: { day: string; count: number; lastAt: number };
  pending: { id: string; until: number } | null;
  receipts: { id: string; kind: 'chat' | 'diary' | 'interaction'; targetId?: string }[];
};

export function fresh(now = new Date()): AppData {
  return {
    design: null, portraits: null, lastActivity: null, nickname: '', meetDate: dateAt(now), zone: 'Asia/Taipei', state: { ...initialState }, stateDate: dateAt(now), context: 0,
    memories: [], memoryEvents: [], messages: [{ id: randomUUID(), role: 'assistant', content: firstGreeting, at: now.toISOString() }],
    events: [], feedback: [], journals: [], widgetHash: null, widgetDetails: false, usage: { day: '', count: 0, lastAt: 0 }, pending: null, receipts: [],
  };
}

export function currentState(data: AppData, now: Date) {
  const state = { ...data.state };
  if (dateAt(now, data.zone) > data.stateDate) {
    state.energy = Math.max(70, state.energy);
    state.mood = Math.trunc(state.mood / 2);
  }
  return state;
}

export function invalidateContext(data: AppData, ids: string[]) {
  const affected = new Set([data.context++]);
  for (const message of data.messages) {
    if (message.context !== undefined && message.meta?.memoryIds.some(id => ids.includes(id))) affected.add(message.context);
  }
  const copies = new Set(data.messages.filter(message => message.context !== undefined && affected.has(message.context)).map(message => message.id));
  data.feedback = data.feedback.filter(row => !copies.has(row.messageId) && !row.memoryIds.some(id => ids.includes(id)));
}

export function expireMemories(data: AppData, now: Date) {
  const today = dateAt(now, data.zone);
  const expired = data.memories.filter(memory => memory.expiresOn !== null && memory.expiresOn < today);
  if (!expired.length) return;
  const ids = expired.map(memory => memory.id);
  data.memories = data.memories.filter(memory => !ids.includes(memory.id));
  data.memoryEvents.push(...ids.map(id => ({ id, at: now.toISOString(), action: 'expire' as const })));
  invalidateContext(data, ids);
}

function normalized(text: string) {
  return text.normalize('NFKC').toLocaleLowerCase().match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? [];
}

function terms(input: string) {
  const result = new Set<string>();
  for (const segment of normalized(input)) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const chars = [...segment];
      for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
    } else if (segment.length >= 2) result.add(segment);
  }
  return result;
}

export function retrieve(memories: Memory[], input: string, today: string) {
  const query = terms(input);
  return memories.flatMap(memory => {
    if (!memory.consent || memory.status !== 'active' || (memory.expiresOn && memory.expiresOn < today)) return [];
    const words = terms(memory.content);
    const matches = [...query].filter(term => words.has(term)).length;
    const typeBonus = memory.type === 'event' && /何時|日期|幾號|哪天|when/i.test(input) ? 2
      : memory.type === 'shared' && /我們|一起|共同/.test(input) ? 2 : 0;
    const date = input.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const dateBonus = date && memory.content.includes(date) ? 5 : 0;
    if (!matches && !dateBonus) return [];
    return [{ memory, rank: matches * 8 + memory.importance + typeBonus + dateBonus }];
  }).sort((a, b) => b.rank - a.rank || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
    .slice(0, 6).map(({ memory }) => memory);
}

export function updateMemory(data: AppData, input: Record<string, unknown>, now: Date) {
  if (input.consent !== true) throw new Problem(400, '請確認同意保存並提供給 AI 作為參考。');
  const old = input.id ? data.memories.find(m => m.id === uuid(input.id)) : undefined;
  if (input.id && !old) throw new Problem(404, '找不到記憶。');
  if (!old && data.memories.length >= 150) throw new Problem(409, '記憶本已滿，請先清理舊記憶。');
  const type = memoryTypes.find(type => type === input.type);
  if (!type) throw new Problem(400, '請選擇記憶類型。');
  const expiry = input.expiresOn ? day(input.expiresOn) : null;
  if ((type === 'temporary' && !expiry) || (expiry && expiry < dateAt(now, data.zone))) {
    throw new Problem(400, '短期記憶需要有效的到期日。');
  }
  const eventId = type === 'shared' && input.eventId ? uuid(input.eventId) : undefined;
  const event = data.events.find(event => event.id === eventId && !event.legacy);
  if (type === 'shared' && !event?.meaningful) throw new Problem(400, '共同記憶必須連結可保存的互動。');
  if (event && data.memories.some(m => m.eventId === event.id && m.id !== old?.id)) throw new Problem(409, '此互動已經保存。');
  const content = event ? `${event.date} 共同互動：${actionLabels[event.type]}。` : text(input.content, 400);
  const at = now.toISOString();
  const memory: Memory = {
    id: old?.id ?? randomUUID(), type, content, eventId,
    source: event ? 'interaction:' + event.id : old?.source.startsWith('interaction:') ? 'manual' : old?.source ?? 'manual',
    confidence: 1, importance: whole(input.importance, 1, 5), consent: true, status: 'active',
    createdAt: old?.createdAt ?? at, updatedAt: at, lastConfirmedAt: at, expiresOn: expiry,
  };
  if (old) {
    data.memories = data.memories.map(entry => entry.id === old.id ? memory : entry);
    if (old.content !== content || old.type !== type) invalidateContext(data, [old.id]);
  } else data.memories.push(memory);
  data.memoryEvents.push({ id: memory.id, at, action: old ? 'update' : 'create' });
}

export function journalFor(data: AppData, date: string): Journal & { canGenerate: boolean } {
  const events = data.events.filter(event => event.date === date);
  const canGenerate = events.some(event => !event.legacy);
  const generated = data.journals.find(item => item.date === date);
  if (generated) return { ...generated, canGenerate };
  if (events.length) return { date, kind: 'summary', canGenerate, content: events.map(event => actionLabels[event.type]).join('、') + '。', eventIds: events.map(event => event.id) };
  const samples = ['想把今天的旋律留在這裡。', '安靜的時候，反而聽得清楚。', '平凡的日子，也可以慢慢記下來。'];
  return { date, kind: 'example', canGenerate, content: samples[Number(date.slice(-2)) % samples.length], eventIds: [] };
}
