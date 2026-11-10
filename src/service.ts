import { randomUUID } from 'node:crypto';
import { initialPersona, type Persona } from './character.js';
import {
  Problem, actionLabels, canAcceptInteraction, currentState, dateAt, day, expireMemories, expression, feedbackTags, firstGreeting, fresh, interaction, reactionExpressions, roomActions,
  invalidateContext, journalFor, object, retrieve, stage, text, timeZone, updateMemory, uuid, whole,
  type AppData, type Feedback, type InteractionReaction, type Journal, type Message, type RoomAction,
} from './domain.js';
import { cases, heldOut, testState, trialCheck, validatedPersona, type Studio, type Trial } from './evaluations.js';
import { promptFor, type Provider } from './provider.js';
import { change, digest, newToken, type Row, type Store } from './storage.js';
import { exported, importBackup } from './backup.js';
import { defaultDesign, designedPersona, designFormat, designTemplate, designVersion, validateDesign } from './design.js';
import { portraitInfo, roomScene, savePortraits, validatePortraitImage } from './portraits.js';

const newStudio = (): Studio => ({ active: initialPersona.config.version, personas: [initialPersona], runs: [] });
const pairingLifetime = 5 * 60_000;

function view(data: AppData, now: Date, revision: number) {
  const current = currentState(data, now);
  const today = dateAt(now, data.zone);
  const design = data.design ?? defaultDesign;
  const portraits = data.portraits?.map(portraitInfo) ?? null;
  const scene = roomScene(data, expression(current));
  return {
    revision, design, portraits, activePortraitId: scene.portrait?.id ?? null,
    designVersion: designVersion(design, portraits ?? undefined),
    nickname: data.nickname, meetDate: data.meetDate, zone: data.zone, state: current,
    expression: scene.expression, stage: stage(current, data.memories.filter(m => m.type === 'shared').length),
    today, context: data.context, todayCount: data.events.filter(event => event.date === today).length,
    messages: data.messages.slice(-180), events: data.events.slice(-80),
    memories: data.memories, feedbackIds: data.feedback.map(row => row.messageId),
    nativeWidgetEnabled: !!data.nativeWidgetHash, nativePairPending: !!data.nativePairHash && (data.nativePairUntil ?? 0) > now.getTime(),
  };
}

function feedbackFields(body: Record<string, unknown>) {
  if (!Array.isArray(body.tags) || body.tags.some(tag => typeof tag !== 'string' || !feedbackTags.includes(tag))) {
    throw new Problem(400, '評分標籤不正確。');
  }
  return { score: whole(body.score, 0, 5), tags: [...new Set(body.tags as string[])], suggestion: text(body.suggestion ?? '', 400, false) };
}

export class Service {
  constructor(
    private store: Store, private provider: (model?: string) => Provider, private dailyLimit: number,
    public adminModels: string[], private now = () => new Date(),
  ) {}

  private async mutate<R>(key: string, fn: (data: AppData, now: Date) => R) {
    const now = this.now();
    return change(this.store, key, () => fresh(now), data => {
      expireMemories(data, now);
      return fn(data, now);
    });
  }

  private async readRoom(key: string) {
    const now = this.now();
    const row = await this.store.get<AppData>(key);
    if (!row) return { data: fresh(now), revision: 0 };
    const today = dateAt(now, row.data.zone);
    if (row.data.memories.some(m => m.expiresOn && m.expiresOn < today)) {
      return this.mutate(key, () => {});
    }
    return row;
  }

  async read(key: string) { return (await this.readRoom(key)).data; }

  async session(key: string) {
    const { data, revision } = await this.readRoom(key);
    return view(data, this.now(), revision);
  }

  async update(key: string, body: Record<string, unknown>) {
    if (body.action === 'interaction') {
      const { data, revision } = await this.interact(key, body);
      return view(data, this.now(), revision);
    }
    let nativePairCode: string | undefined;
    const { data, revision } = await this.mutate(key, (data, now) => {
      switch (body.action) {
        case 'settings': {
          data.nickname = text(body.nickname, 24, false);
          data.meetDate = day(body.meetDate);
          data.zone = timeZone(body.zone);
          break;
        }
        case 'design': {
          const previous = data.design ?? defaultDesign;
          const currentVersion = designVersion(previous, data.portraits?.map(portraitInfo));
          if (body.expectedVersion !== currentVersion) {
            throw new Problem(409, '另一部裝置已更新角色。請關閉編輯器，重新讀取後再儲存。');
          }
          const next = body.design === null ? defaultDesign : validateDesign(body.design);
          if (body.portraits !== undefined) data.portraits = savePortraits(body.portraits, data.portraits ?? []);
          if (designVersion(previous) === designVersion(next)) break;
          data.design = body.design === null ? null : next;
          // Prior conversations and ratings remain private history, outside the new persona context.
          data.context++;
          const first = data.messages[0];
          if (data.messages.length === 1 && first.role === 'assistant' && !first.meta &&
              first.content === (previous.greeting || firstGreeting)) first.content = next.greeting || firstGreeting;
          break;
        }
        case 'memory':
          updateMemory(data, body, now);
          break;
        case 'deleteMemory': {
          const id = uuid(body.id);
          if (!data.memories.some(memory => memory.id === id)) throw new Problem(404, '找不到記憶。');
          data.memories = data.memories.filter(memory => memory.id !== id);
          data.memoryEvents.push({ id, at: now.toISOString(), action: 'delete' });
          invalidateContext(data, [id]);
          break;
        }
        case 'feedback': {
          const id = uuid(body.id);
          const answer = data.messages.find(message => message.id === id && message.role === 'assistant');
          const input = data.messages.find(message => message.turnId && message.turnId === answer?.turnId && message.role === 'user');
          if (!answer?.meta || !input || answer.context !== data.context) throw new Problem(409, '這則回覆目前無法評分。');
          if (body.consent !== true) throw new Problem(400, '請先確認同意保存此對話片段供自己回顧。');
          const fields = feedbackFields(body);
          const rating: Feedback = {
            messageId: id, input: input.content, reply: answer.content, model: answer.meta.model,
            version: answer.meta.version, state: answer.meta.state, memoryIds: answer.meta.memoryIds, ...fields, at: now.toISOString(),
          };
          data.feedback = [...data.feedback.filter(row => row.messageId !== id), rating];
          break;
        }
        case 'nativePair':
          nativePairCode = newToken();
          data.nativePairHash = digest(nativePairCode);
          data.nativePairUntil = now.getTime() + pairingLifetime;
          break;
        case 'revokeNativeWidget':
          data.nativeWidgetHash = null;
          data.nativePairHash = null;
          data.nativePairUntil = 0;
          break;
        case 'import':
          if (body.consent !== true) throw new Problem(400, '請先同意啟用備份中的記憶。');
          if (data.pending && data.pending.until > now.getTime()) throw new Problem(409, '請等目前生成結束。');
          importBackup(data, body.backup, now);
          break;
        case 'reset': {
          // Keep quota so clearing private data cannot bypass limits.
          const usage = data.usage;
          const context = data.context + 1;
          Object.assign(data, fresh(now), { usage, context });
          break;
        }
        default: throw new Problem(400, '未知的操作。');
      }
    });
    return { ...view(data, this.now(), revision), nativePairCode };
  }

  async studio() { return (await this.store.get<Studio>('persona'))?.data ?? newStudio(); }

  async saveStudio(body: Record<string, unknown>) {
    return (await change(this.store, 'persona', newStudio, studio => {
      if (body.action === 'publish') {
        let persona: Persona;
        try { persona = validatedPersona(body.config, body.examples, body.reason, this.now()); }
        catch (err) { throw new Problem(400, (err as Error).message); }
        if (studio.personas.some(p => p.config.version === persona.config.version)) throw new Problem(409, '此版本已存在。請輸入新版本名稱。');
        if (studio.personas.length >= 30) throw new Problem(409, '人格版本已達上限。');
        studio.personas.push(persona);
        if (body.activate === true) studio.active = persona.config.version;
      } else if (body.action === 'activate') {
        if (!studio.personas.some(p => p.config.version === body.version)) throw new Problem(404, '找不到版本。');
        studio.active = String(body.version);
      } else if (body.action === 'rate') {
        const trial = studio.runs.find(run => run.id === body.id);
        if (!trial) throw new Problem(404, '找不到評測紀錄。');
        const fields = feedbackFields(body);
        trial.score = fields.score;
        trial.tags = fields.tags;
        trial.notes = fields.suggestion;
      } else if (body.action === 'deleteRun') {
        studio.runs = studio.runs.filter(run => run.id !== body.id);
      } else throw new Problem(400, '未知的校調操作。');
    })).data;
  }

  private async reserve<T>(key: string, id: string, prepare: (data: AppData, now: Date) => T, nativeHash?: string) {
    return (await this.mutate(key, (data, now) => {
      checkNativeWidget(data, nativeHash);
      const prior = data.receipts.find(row => row.id === id);
      if (prior) return { prior };
      if (data.pending && data.pending.until > now.getTime()) throw new Problem(409, '已有生成請求，請稍候。');
      const today = now.toISOString().slice(0, 10);
      const count = data.usage.day === today ? data.usage.count : 0;
      if (count >= this.dailyLimit) throw new Problem(429, '已達今日生成上限。');
      if (now.getTime() - data.usage.lastAt < 800) throw new Problem(429, '請稍候再送出。');
      const prepared = prepare(data, now);
      data.usage = { day: today, count: count + 1, lastAt: now.getTime() };
      data.pending = { id, until: now.getTime() + 45_000 };
      return { prepared };
    })).result;
  }

  private async release(key: string, id: string) {
    await this.mutate(key, data => { if (data.pending?.id === id) data.pending = null; });
  }

  private async interact(key: string, body: Record<string, unknown>, nativeHash?: string) {
    const id = uuid(body.id);
    const action = roomActions.find(action => action === body.type);
    if (!action) throw new Problem(400, '請選擇摸頭、牽手、擁抱或唱歌。');
    const provider = this.provider();
    if (provider.model === 'mock') return this.finishInteraction(key, id, action, undefined, nativeHash);

    const studio = await this.studio();
    const baseline = studio.personas.find(p => p.config.version === studio.active)!;
    const prepare = (data: AppData, now: Date) => {
      if (data.events.length >= 3000) throw new Problem(409, '互動紀錄已達上限，請先備份。');
      const state = currentState(data, now);
      const mayAccept = canAcceptInteraction(action, state);
      const history = data.messages.filter(message => message.context === data.context).slice(-8)
        .map(({ role, content }) => ({ role, content }));
      const context = {
        nickname: data.nickname, state, stage: stage(state, data.memories.filter(m => m.type === 'shared').length),
        recent: data.events.filter(event => !event.legacy).slice(-4).map(event => ({
          action: actionLabels[event.type], accepted: event.accepted,
        })),
      };
      const persona = designedPersona(baseline, data.design ?? defaultDesign);
      const prompt = promptFor(persona, context, history, '使用者點了房間互動「' + actionLabels[action] + '」。', data.design ?? undefined);
      prompt.instructions += '\n\n本次是虛構房間互動。依角色設定、關係及情境回一句自然的繁體中文台詞。' +
        '你可以婉拒，保有自主；婉拒或想再等等時 accepted 是 false。' +
        (mayAccept ? '目前可自行選擇是否接受。' : '房間規則要求本次婉拒，accepted 必須是 false，台詞也須婉拒。') +
        '唱歌時以文字互動，不聲稱已播放音訊。請只回傳 JSON 物件 ' +
        '{"reply":"一句台詞","expression":"普通","accepted":false}。expression 只能是 ' + reactionExpressions.join('、') + '。';
      return { prompt, context: data.context };
    };
    let reserved;
    try { reserved = await this.reserve(key, id, prepare, nativeHash); }
    catch (error) {
      if (error instanceof Problem && error.status === 429) return this.finishInteraction(key, id, action, undefined, nativeHash);
      throw error;
    }
    if (reserved.prior) {
      if (reserved.prior.kind !== 'interaction') throw new Problem(409, '請求識別碼已使用。');
      const room = await this.readRoom(key);
      checkNativeWidget(room.data, nativeHash);
      return room;
    }

    const prepared = reserved.prepared!;
    try {
      let reaction;
      try { reaction = parseReaction(await provider.generate(prepared.prompt)); }
      catch { /* A safe built-in reaction is available if generation or validation fails. */ }
      return await this.finishInteraction(key, id, action, { reaction, context: prepared.context }, nativeHash);
    } catch (error) {
      await this.release(key, id).catch(() => {});
      throw error;
    }
  }

  private async finishInteraction(key: string, id: string, action: RoomAction, generation?: { context: number; reaction?: InteractionReaction }, nativeHash?: string) {
    return this.mutate(key, (data, now) => {
      checkNativeWidget(data, nativeHash);
      const prior = data.receipts.find(row => row.id === id);
      if (prior) {
        if (prior.kind !== 'interaction') throw new Problem(409, '請求識別碼已使用。');
        return;
      }
      if (generation && (data.pending?.id !== id || data.context !== generation.context)) {
        throw new Problem(409, '房間資料剛更新。請重新互動。');
      }
      if (!generation && data.pending && data.pending.until > now.getTime()) {
        throw new Problem(409, '已有生成請求，請稍候。');
      }
      if (data.events.length >= 3000) throw new Problem(409, '互動紀錄已達上限，請先備份。');
      const event = interaction(action, currentState(data, now), data.events, now, data.zone, generation?.reaction);
      data.events.push(event);
      data.lastActivity = 'interaction';
      data.state = event.after!;
      data.stateDate = event.date;
      if (generation) data.pending = null;
      record(data, { id, kind: 'interaction', targetId: event.id });
    });
  }

  async chat(key: string, body: Record<string, unknown>, delta?: (s: string) => void) {
    const id = uuid(body.id);
    const regen = body.regenerate ? uuid(body.regenerate) : null;
    const input = regen ? '' : text(body.message, 1800);
    const studio = await this.studio();
    const baseline = studio.personas.find(p => p.config.version === studio.active)!;
    const provider = this.provider();
    const reserved = await this.reserve(key, id, (data, now) => {
      if (data.messages.length >= 4999 && !regen) throw new Problem(409, '對話紀錄已達上限，請先備份。');
      const last = data.messages.at(-1);
      const original = data.messages.at(-2);
      if (regen && (last?.id !== regen || last.context !== data.context || original?.role !== 'user')) {
        throw new Problem(409, '只能重新生成目前有效的最後一則回覆。');
      }
      const message = regen ? original!.content : input;
      const history = (regen ? data.messages.slice(0, -2) : data.messages)
        .filter(m => m.context === data.context).slice(-12).map(({ role, content }) => ({ role, content }));
      const today = dateAt(now, data.zone);
      const memories = retrieve(data.memories, message, today);
      const state = currentState(data, now);
      const context = { nickname: data.nickname, state, stage: stage(state, data.memories.filter(m => m.type === 'shared').length),
        memories: memories.map(({ id, type, content }) => ({ id, type, content })) };
      const design = data.design ?? defaultDesign;
      const persona = designedPersona(baseline, design);
      const version = persona.config.version + (data.design ? '+' + designVersion(design) : '');
      return { contextId: data.context, state, memoryIds: memories.map(m => m.id), message, turnId: regen ? original!.turnId! : id,
        version, prompt: promptFor(persona, context, history, message, data.design ?? undefined) };
    });
    if (reserved.prior) {
      if (reserved.prior.kind !== 'chat') throw new Problem(409, '請求識別碼已使用。');
      return { ...await this.session(key), candidate: null };
    }
    const prepared = reserved.prepared!;
    try {
      let reply: string;
      try { reply = (await provider.generate(prepared.prompt, delta)).slice(0, 12_000); }
      catch { throw new Problem(502, '角色暫時無法回覆。請稍後重試。'); }
      const { data, revision } = await this.mutate(key, (data, now) => {
        if (data.pending?.id !== id || data.context !== prepared.contextId) {
          throw new Problem(409, '房間資料剛更新。請重新送出。');
        }
        const at = now.toISOString();
        const response: Message = { id: randomUUID(), role: 'assistant', content: reply, at, context: data.context, turnId: prepared.turnId,
          meta: { model: provider.model, version: prepared.version, state: prepared.state, memoryIds: prepared.memoryIds, expression: expression(prepared.state) } };
        if (regen) {
          data.messages.pop();
          data.feedback = data.feedback.filter(row => row.messageId !== regen);
        } else {
          data.messages.push({ id: randomUUID(), role: 'user', content: prepared.message, at, context: data.context, turnId: id });
        }
        data.messages.push(response);
        data.lastActivity = 'chat';
        data.pending = null;
        record(data, { id, kind: 'chat', targetId: response.id });
      });
      const candidate = !regen && prepared.message.match(/^請(?:幫我)?記住[：:\s]+(.{1,400})$/u)?.[1];
      return { ...view(data, this.now(), revision), candidate: candidate || null };
    } catch (error) {
      await this.release(key, id).catch(() => {});
      throw error;
    }
  }

  async diary(key: string, body: Record<string, unknown>) {
    const id = uuid(body.id);
    const date = day(body.date);
    const provider = this.provider();
    if (provider.model === 'mock') throw new Problem(409, 'Mock 模式可查看事件摘要。啟用 OpenAI 後才可生成日記。');
    const reserved = await this.reserve(key, id, data => {
      const events = data.events.filter(event => event.date === date && !event.legacy).slice(-30);
      if (!events.length) throw new Problem(409, '此日期沒有可用於 AI 日記的互動事件。');
      return events.map(event => ({ id: event.id, type: event.type, at: event.at }));
    });
    if (reserved.prior) return journalFor(await this.read(key), date);
    const events = reserved.prepared!;
    try {
      const reflections = ['這樣的交流，可以慢慢記下來。', '想給這個片刻留一點空間。', '回頭看，簡短的交流也值得留著。'];
      let content: string;
      let eventIds: string[];
      try {
        const raw = await provider.generate({
          instructions: '替房間角色選出一至三項有代表性的已保存互動，並從提供的 reflections 選一則結語。只回傳 JSON 物件，格式 {"ids":["事件 ID"],"reflection":0}。不輸出自由文字。',
          input: [{ role: 'user', content: JSON.stringify({ events, reflections }) }],
        });
        const choice = object(JSON.parse(raw));
        const ids = Array.isArray(choice.ids) ? [...new Set(choice.ids)] : [];
        const selected = events.filter(event => ids.includes(event.id));
        if (selected.length < 1 || selected.length > 3 || selected.length !== ids.length) throw new Error('日記事件不正確');
        const reflection = reflections[whole(choice.reflection, 0, reflections.length - 1)];
        content = '在房間裡，記下了' + selected.map(event => '「' + actionLabels[event.type] + '」').join('、') + '。' + reflection;
        eventIds = selected.map(event => event.id);
      } catch { throw new Problem(502, '日記生成失敗。你仍可查看事件摘要。'); }
      const journal: Journal = { date, kind: 'ai', content, eventIds, model: provider.model };
      await this.mutate(key, data => {
        if (data.pending?.id !== id) throw new Problem(409, '資料剛更新，請重新生成。');
        data.journals = [...data.journals.filter(row => row.date !== date), journal];
        data.pending = null;
        record(data, { id, kind: 'diary' });
      });
      return { ...journal, canGenerate: true };
    } catch (error) {
      await this.release(key, id).catch(() => {});
      throw error;
    }
  }

  async run(key: string, body: Record<string, unknown>) {
    const id = uuid(body.id);
    const studio = await this.studio();
    const persona = studio.personas.find(p => p.config.version === body.version);
    if (!persona) throw new Problem(404, '找不到指定的角色版本。');
    const model = text(body.model, 100);
    if (!this.adminModels.includes(model)) throw new Problem(400, '模型不在允許清單中。');
    const test = body.caseId ? [...cases, ...heldOut].find(test => test.id === body.caseId) : undefined;
    if (body.caseId && !test) throw new Problem(404, '找不到測試題目。');
    if (!test && body.synthetic !== true) throw new Problem(400, '自訂測試必須確認為合成資料。');
    const input = test?.input ?? text(body.input, 1800);
    const state = testState(body.state);
    const provider = this.provider(model);
    const existing = studio.runs.find(run => run.id === id);
    if (existing) return existing;
    await this.reserve(key, id, () => {});
    try {
      let reply: string;
      try { reply = await provider.generate(promptFor(persona, { state, fixture: test?.context }, heldOut.find(item => item.id === test?.id)?.history ?? [], input)); }
      catch { throw new Problem(502, '評測生成失敗。'); }
      const run: Trial = {
        id, caseId: test?.id ?? null, input, reply: reply.slice(0, 5000), version: persona.config.version,
        model: provider.model, state, memoryIds: [], at: this.now().toISOString(), check: trialCheck(test, reply), score: null, tags: [], notes: '',
      };
      return (await change(this.store, 'persona', newStudio, document => {
        const previous = document.runs.find(row => row.id === id);
        if (previous) return previous;
        if (document.runs.length >= 400) throw new Problem(409, '評測紀錄已達上限。請先下載及清理。');
        document.runs.push(run);
        return run;
      })).result;
    } finally { await this.release(key, id).catch(() => {}); }
  }

  async pairWidget(code: string) {
    const hash = digest(code);
    const room = await this.store.findRoom<AppData>('nativePairHash', hash);
    if (!room) throw new Problem(401, '配對碼已失效。請在網頁重新產生。');
    const token = newToken();
    await this.mutate(room.key, (data, now) => {
      if (data.nativePairHash !== hash || (data.nativePairUntil ?? 0) <= now.getTime()) {
        throw new Problem(401, '配對碼已失效。請在網頁重新產生。');
      }
      data.nativePairHash = null;
      data.nativePairUntil = 0;
      data.nativeWidgetHash = digest(token);
    });
    return { token };
  }

  async nativeWidget(token: string, action?: Record<string, unknown>) {
    const hash = digest(token);
    const room = await this.store.findRoom<AppData>('nativeWidgetHash', hash);
    if (!room) throw new Problem(401, '小工具憑證無效。請重新配對。');
    return this.nativeWidgetView(action ? await this.interact(room.key, action, hash) : room);
  }

  private nativeWidgetView({ data, revision }: Row<AppData>) {
    const now = this.now();
    const today = dateAt(now, data.zone);
    const hour = Number(new Intl.DateTimeFormat('en', { timeZone: data.zone, hour: '2-digit', hourCycle: 'h23' }).format(now));
    const anniversary = today > data.meetDate && today.slice(5) === data.meetDate.slice(5);
    const greeting = anniversary ? '今天是我們的相遇紀念日。' : hour < 6 ? '夜深了。早點休息吧。'
      : hour < 12 ? '早安。睡得還好嗎？' : hour < 18 ? '午安。記得休息一下。' : '晚安。今天辛苦了。';
    const scene = roomScene(data, expression(currentState(data, now)));
    const recent = data.events.findLast(event => !event.legacy);
    return {
      revision,
      name: (data.design ?? defaultDesign).name,
      greeting: anniversary ? greeting : data.design?.greeting || greeting,
      mood: scene.expression,
      todayCount: data.events.filter(event => event.date === today).length,
      portrait: scene.portrait?.image ?? null,
      interaction: recent ? { label: actionLabels[recent.type], reply: recent.reply, source: recent.reactionSource ?? null } : null,
    };
  }

  async portrait(key: string, id: unknown) {
    const target = uuid(id);
    const row = await this.store.get<AppData>(key);
    const item = row?.data.portraits?.find(portrait => portrait.id === target);
    if (!item) throw new Problem(404, '找不到這張立繪。');
    validatePortraitImage(item.image);
    return item.image;
  }

  async shareDesign(key: string) {
    const row = await this.store.get<AppData>(key);
    return designTemplate(row?.data.design ?? defaultDesign);
  }

  previewDesign(body: Record<string, unknown>) {
    if (body.format !== designFormat) throw new Problem(400, '請選擇 INORI 的角色範本檔案。');
    return designTemplate(body.design);
  }

  async export(key: string) { return exported(await this.read(key)); }
}

function checkNativeWidget(data: AppData, hash?: string) {
  if (hash && data.nativeWidgetHash !== hash) throw new Problem(401, '小工具憑證無效。請重新配對。');
}

function record(data: AppData, receipt: AppData['receipts'][number]) {
  data.receipts.push(receipt);
  data.receipts = data.receipts.slice(-160);
}

function parseReaction(raw: string): InteractionReaction {
  const clean = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  const value = object(JSON.parse(clean));
  const face = reactionExpressions.find(face => face === value.expression);
  if (!face || typeof value.accepted !== 'boolean') throw new Error('AI 互動回覆格式不正確');
  return { reply: text(value.reply, 200), expression: face, accepted: value.accepted };
}
