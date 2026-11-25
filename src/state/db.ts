// IndexedDB 持久化：病例（含序列化模型）与设置。浏览器环境使用。
import { CaseRecord, AppSettings, DEFAULT_SETTINGS } from '../core/types';

const DB_NAME = 'fibula-guide-db';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) db.createObjectStore(STORE_CASES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbListCases(): Promise<CaseRecord[]> {
  try {
    const all = await tx<CaseRecord[]>(STORE_CASES, 'readonly', (s) => s.getAll() as IDBRequest<CaseRecord[]>);
    return (all ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function idbPutCase(c: CaseRecord): Promise<IDBValidKey> {
  return tx(STORE_CASES, 'readwrite', (s) => s.put(c));
}

export function idbDeleteCase(id: string): Promise<undefined> {
  return tx(STORE_CASES, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbGetSettings(): Promise<AppSettings | null> {
  try {
    const v = await tx<AppSettings | undefined>(STORE_KV, 'readonly', (s) => s.get('settings') as IDBRequest<AppSettings | undefined>);
    return v ?? null;
  } catch {
    return null;
  }
}

export function idbPutSettings(s: AppSettings): Promise<IDBValidKey> {
  return tx(STORE_KV, 'readwrite', (st) => st.put(s, 'settings'));
}

export async function idbIsSeeded(): Promise<boolean> {
  const v = await tx<boolean | undefined>(STORE_KV, 'readonly', (s) => s.get('seeded') as IDBRequest<boolean | undefined>);
  return !!v;
}
export function idbMarkSeeded(): Promise<IDBValidKey> {
  return tx(STORE_KV, 'readwrite', (s) => s.put(true, 'seeded'));
}

export { DEFAULT_SETTINGS };
