// 工作流页面共用：病例/方案上下文、方案切换器、空状态。
import { store } from '../state/store';
import { h, btn, selectInput } from '../ui/dom';
import { CaseRecord, PlanRecord } from '../core/types';
import { uid, createPlan } from '../state/seed';

export interface Ctx { case: CaseRecord; plan: PlanRecord }

export function requireCtx(root: HTMLElement): Ctx | null {
  const c = store.currentCase;
  if (!c) {
    root.append(h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      '请先选择或新建病例。', h('div', { class: 'mt8' }, btn('去病例列表', () => (location.hash = '#/cases'), { primary: true })))));
    return null;
  }
  const plan = store.activePlan ?? c.plans[0];
  if (!plan) {
    const p = createPlan('方案 A（默认）', c.side, store.settings);
    store.mutateCase(c.id, (cc) => { cc.plans.push(p); cc.activePlanId = p.id; }, true);
    return { case: c, plan: p };
  }
  if (c.activePlanId !== plan.id) {
    store.mutateCase(c.id, (cc) => { cc.activePlanId = plan.id; });
  }
  return { case: c, plan };
}

export function rerenderRoute(): void {
  (window as unknown as { __rerenderRoute?: () => void }).__rerenderRoute?.();
}

/** 顶部方案切换 + 新建 + 复制 */
export function planBar(c: CaseRecord): HTMLElement {
  const plan = store.activePlan ?? c.plans[0];
  const sel = selectInput(
    c.plans.map((p) => ({ value: p.id, label: p.name })),
    plan?.id ?? '',
    (id) => {
      store.mutateCase(c.id, (cc) => { cc.activePlanId = id; }, true);
      rerenderRoute();
    },
  );
  sel.style.width = '170px';
  return h('div', { class: 'row' },
    h('span', { class: 'muted' }, '规划方案'),
    sel,
    btn('＋新方案', () => {
      const p = createPlan(`方案 ${String.fromCharCode(65 + c.plans.length)}`, c.side, store.settings);
      store.mutateCase(c.id, (cc) => { cc.plans.push(p); cc.activePlanId = p.id; }, true);
      rerenderRoute();
    }, { small: true }),
    btn('复制', () => {
      const src = plan;
      if (!src) return;
      const copy: PlanRecord = JSON.parse(JSON.stringify(src));
      copy.id = uid('plan'); copy.name = `${src.name} 副本`;
      copy.createdAt = copy.updatedAt = Date.now();
      store.mutateCase(c.id, (cc) => { cc.plans.push(copy); cc.activePlanId = copy.id; }, true);
      rerenderRoute();
    }, { small: true }),
  );
}

/** 直接修改当前 plan 并防抖持久化（不触发整页重绘） */
export function commitPlan(caseId: string): void {
  const c = store.cases.find((x) => x.id === caseId);
  if (c) store.mutateCase(caseId, () => undefined);
}
