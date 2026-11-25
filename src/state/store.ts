// 全局应用状态：病例列表、当前病例/方案、设置；负责 IndexedDB 持久化与网格反序列化缓存。
import { CaseRecord, AppSettings, PlanRecord, DEFAULT_SETTINGS } from '../core/types';
import { MeshData, meshFromJSON } from '../core/mesh';
import * as db from './db';
import { buildSeedCases } from './seed';

type Listener = () => void;

class Store {
  cases: CaseRecord[] = [];
  settings: AppSettings = { ...DEFAULT_SETTINGS };
  currentCaseId: string | null = null;
  booted = false;
  private listeners = new Set<Listener>();
  private meshCache = new Map<string, MeshData>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }

  async boot(): Promise<void> {
    const s = await db.idbGetSettings();
    if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
    this.cases = await db.idbListCases();
    if (!(await db.idbIsSeeded()) || this.cases.length === 0) {
      this.cases = buildSeedCases(this.settings);
      for (const c of this.cases) await db.idbPutCase(c);
      await db.idbMarkSeeded();
    }
    if (!this.currentCaseId && this.cases[0]) this.currentCaseId = this.cases[0].id;
    this.booted = true;
    this.emit();
  }

  get currentCase(): CaseRecord | null {
    return this.cases.find((c) => c.id === this.currentCaseId) ?? null;
  }

  get activePlan(): PlanRecord | null {
    const c = this.currentCase;
    if (!c) return null;
    return c.plans.find((p) => p.id === c.activePlanId) ?? c.plans[0] ?? null;
  }

  selectCase(id: string): void {
    this.currentCaseId = id;
    this.meshCache.clear();
    this.emit();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await db.idbPutSettings(this.settings);
    this.emit();
  }

  /** 更新当前病例并防抖持久化 */
  mutateCase(id: string, fn: (c: CaseRecord) => void, immediate = false): void {
    const c = this.cases.find((x) => x.id === id);
    if (!c) return;
    fn(c);
    c.updatedAt = Date.now();
    this.emit();
    if (immediate) {
      void db.idbPutCase(structuredCloneSafe(c));
      return;
    }
    const old = this.saveTimers.get(id);
    if (old) clearTimeout(old);
    this.saveTimers.set(id, setTimeout(() => {
      void db.idbPutCase(structuredCloneSafe(c));
    }, 350));
  }

  async saveCaseNow(id: string): Promise<void> {
    const c = this.cases.find((x) => x.id === id);
    if (c) await db.idbPutCase(structuredCloneSafe(c));
  }

  async deleteCase(id: string): Promise<void> {
    await db.idbDeleteCase(id);
    this.cases = this.cases.filter((c) => c.id !== id);
    if (this.currentCaseId === id) this.currentCaseId = this.cases[0]?.id ?? null;
    this.emit();
  }

  async addCase(c: CaseRecord): Promise<void> {
    this.cases.unshift(c);
    this.currentCaseId = c.id;
    await db.idbPutCase(c);
    this.emit();
  }

  /** 取得某病例某类模型（反序列化并缓存） */
  getMesh(caseId: string, kind: string): MeshData | null {
    const key = `${caseId}:${kind}`;
    const hit = this.meshCache.get(key);
    if (hit) return hit;
    const c = this.cases.find((x) => x.id === caseId);
    const sm = (c?.models as Record<string, unknown> | undefined)?.[kind];
    if (!sm || typeof sm !== 'object') return null;
    try {
      const m = meshFromJSON(sm as Parameters<typeof meshFromJSON>[0]);
      this.meshCache.set(key, m);
      return m;
    } catch {
      return null;
    }
  }

  /** 导入/替换模型后写回并清缓存 */
  setMesh(caseId: string, kind: string, serialized: CaseRecord['models'][keyof CaseRecord['models']]): void {
    const c = this.cases.find((x) => x.id === caseId);
    if (!c) return;
    (c.models as Record<string, unknown>)[kind] = serialized;
    this.meshCache.delete(`${caseId}:${kind}`);
    this.mutateCase(caseId, () => undefined, true);
  }

  invalidateMesh(caseId: string, kind: string): void {
    this.meshCache.delete(`${caseId}:${kind}`);
  }
}

/** IndexedDB 可结构化克隆；这里数据本身就是 ArrayBuffer/普通对象 */
function structuredCloneSafe<T>(v: T): T {
  return v;
}

export const store = new Store();
