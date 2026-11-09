import { createHash } from 'node:crypto';
import type { Persona } from './character.js';
import type { PortraitInfo } from './portraits.js';
import { object, Problem, text } from './domain.js';

export type Design = {
  base: 'inori' | 'original';
  name: string;
  world: string;
  personality: string;
  voice: string;
  greeting: string;
};

export const defaultDesign: Design = {
  base: 'inori',
  name: '楪祈',
  world: '',
  personality: '',
  voice: '',
  greeting: '',
};

export const designFormat = 'inori-character-design-v1';

export function validateDesign(raw: unknown): Design {
  const value = object(raw);
  if (value.base !== 'inori' && value.base !== 'original') throw new Problem(400, '請選擇角色基礎。');
  const clean = (field: keyof Design, label: string, max: number, required = false) => {
    try { return text(value[field] ?? '', max, required); }
    catch { throw new Problem(400, label + '需為' + (required ? ' 1–' : '最多 ') + max + ' 字。'); }
  };
  const name = clean('name', '角色名稱', 24, true);
  if (/[\r\n]/u.test(name)) throw new Problem(400, '角色名稱請使用單行文字。');
  return {
    base: value.base, name,
    world: clean('world', '世界觀', 500),
    personality: clean('personality', '個性', 400),
    voice: clean('voice', '說話方式', 300),
    greeting: clean('greeting', '問候語', 120),
  };
}

export function designVersion(design: Design, portraits?: PortraitInfo[]) {
  const fields = [design.base, design.name, design.world, design.personality, design.voice, design.greeting];
  return createHash('sha256').update(JSON.stringify([fields, portraits])).digest('hex').slice(0, 16);
}

export function designTemplate(design: unknown) {
  return { format: designFormat, design: validateDesign(design) };
}

export function designedPersona(baseline: Persona, design: Design): Persona {
  if (design.base === 'inori') return baseline;
  return {
    ...baseline,
    config: {
      version: 'original-character-v1',
      character_bible: '你在私人房間扮演一位原創虛構角色。以創作素材中的角色名稱、背景和說話方式維持一致。沒有背景時保留彈性，使用自然繁體中文。',
      canon_knowledge: [],
      canon_sources: [],
      interpretation: '自然回應，有自己的偏好與界線。使用者可以逐步認識角色。',
      if_world: '角色與使用者在虛構房間交流。',
      voice_rules: '日常對話自然簡潔。實用或技術問題可清楚詳細回答。',
      behavior_rules: '保持自主及適當界線。尊重使用者與其現實人際關係。維持非性化陪伴。',
    },
    examples: [],
  };
}
