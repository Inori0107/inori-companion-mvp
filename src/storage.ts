import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Problem } from './domain.js';

export type Row<T> = { revision: number; data: T };
type WidgetHashField = 'nativeWidgetHash' | 'nativePairHash';
export interface Store {
  get<T>(key: string): Promise<Row<T> | null>;
  put<T>(key: string, expected: number | null, data: T): Promise<boolean>;
  findRoom<T>(field: WidgetHashField, hash: string): Promise<(Row<T> & { key: string }) | null>;
}

export function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function newToken() { return randomBytes(32).toString('base64url'); }

export function localStore(directory?: string): Store {
  const rows = new Map<string, Row<unknown>>();
  let writes = Promise.resolve<unknown>(undefined);
  async function get<T>(key: string): Promise<Row<T> | null> {
    if (!directory) return structuredClone(rows.get(key) as Row<T> | undefined) ?? null;
    try { return JSON.parse(await readFile(join(directory, key + '.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    get,
    put<T>(key: string, expected: number | null, data: T) {
      const operation = writes.then(async () => {
        const row = await get(key);
        if ((row?.revision ?? null) !== expected) return false;
        const next = { revision: (expected ?? 0) + 1, data };
        if (!directory) rows.set(key, structuredClone(next));
        else {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const target = join(directory, key + '.json');
          await writeFile(target + '.tmp', JSON.stringify(next), { mode: 0o600 });
          await rename(target + '.tmp', target);
        }
        return true;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async findRoom<T>(field: WidgetHashField, hash: string) {
      const row = await get<T & Partial<Record<WidgetHashField, string>>>('local');
      return row?.data[field] === hash ? { key: 'local', ...row } : null;
    },
  };
}

export type Cloud = { url: string; anon: string; service: string };
export function supabaseStore(cloud: Cloud): Store {
  const endpoint = cloud.url + '/rest/v1/inori_documents';
  async function request(params: URLSearchParams, init?: RequestInit) {
    const response = await fetch(endpoint + '?' + params, {
      ...init,
      headers: {
        apikey: cloud.service, 'Content-Type': 'application/json',
        ...(cloud.service.startsWith('sb_secret_') ? {} : { Authorization: 'Bearer ' + cloud.service }),
        Prefer: 'return=representation,resolution=ignore-duplicates',
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Problem(503, '雲端資料庫暫時無法使用。');
    return response.json();
  }
  return {
    async get<T>(key: string) {
      const rows: Row<T>[] = await request(new URLSearchParams({ key: 'eq.' + key, select: 'revision,data' }));
      return rows[0] ?? null;
    },
    async put(key, expected, data) {
      const record = { revision: (expected ?? 0) + 1, data };
      const rows: unknown[] = expected === null
        ? await request(new URLSearchParams({ select: 'revision', on_conflict: 'key' }), {
          method: 'POST', body: JSON.stringify({ ...record, key }),
        })
        : await request(new URLSearchParams({ select: 'revision', key: 'eq.' + key, revision: 'eq.' + expected }), {
          method: 'PATCH', body: JSON.stringify(record),
        });
      return rows.length === 1;
    },
    async findRoom<T>(field: WidgetHashField, hash: string) {
      const rows: (Row<T> & { key: string })[] = await request(new URLSearchParams({
        ['data->>' + field]: 'eq.' + hash, select: 'key,revision,data', limit: '1',
      }));
      return rows[0] ?? null;
    },
  };
}

export async function change<T, R>(store: Store, key: string, initial: () => T, mutate: (data: T) => R) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await store.get<T>(key);
    const data = row?.data ?? initial();
    const result = mutate(data);
    if (Buffer.byteLength(JSON.stringify(data)) > 3_000_000) {
      throw new Problem(409, '資料已達容量上限，請先匯出並清理。');
    }
    if (await store.put(key, row?.revision ?? null, data)) return { data, result, revision: (row?.revision ?? 0) + 1 };
  }
  throw new Problem(409, '另一部裝置剛更新了資料，請再試一次。');
}
