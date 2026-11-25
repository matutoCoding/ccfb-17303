import { store } from '../state/store';
import { h, btn, badge, modal, toast, ElChild } from '../ui/dom';
import { uid, createPlan } from '../state/seed';
import { CaseRecord, TUMOR_STAGES, BROWN_CLASSES, PEDICLE_DIRS, Side } from '../core/types';
import { measureDefect, recomputeLayout } from '../core/fibulaPlan';

export function renderCasesPage(root: HTMLElement): () => void {
  const wrap = h('div', {});
  const head = h('div', { class: 'page-head' },
    h('h2', {}, '病例列表'),
    h('span', { class: 'desc' }, '肿瘤分期 · Brown 缺损分类 · 腓骨侧别与血管蒂 · 每病例可挂多套规划方案并排比较'),
    h('div', { class: 'actions' },
      btn('＋ 新建病例', () => openCreateModal(), { primary: true }),
    ),
  );
  const grid = h('div', { class: 'case-grid' });
  wrap.append(head, grid);
  root.append(wrap);

  function draw(): void {
    grid.replaceChildren();
    if (!store.cases.length) {
      grid.append(h('div', { class: 'panel' }, h('div', { class: 'panel-body muted' }, '还没有病例，点击右上角新建。')));
      return;
    }
    for (const c of store.cases) grid.append(caseCard(c));
  }
  draw();
  return store.subscribe(draw);
}

function caseCard(c: CaseRecord): HTMLElement {
  const open = (hash: string) => { store.selectCase(c.id); location.hash = hash; };
  const planCount = c.plans.length;
  return h('article', { class: 'case-card' },
    h('div', { class: 'row1' },
      h('div', { class: 'logo-mark', style: 'width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#0d9488);color:#fff;font-weight:800' }, c.side === 'left' ? '左' : '右'),
      h('div', {},
        h('h3', {}, c.name),
        h('div', { class: 'muted', style: 'font-size:12px' }, `${c.patientId} · ${new Date(c.createdAt).toLocaleDateString('zh-CN')}`),
      ),
      h('div', { style: 'margin-left:auto' }, badge(c.side === 'left' ? '左侧病例' : '右侧病例', 'info')),
    ),
    h('dl', { class: 'case-meta' },
      h('dt', {}, '肿瘤分期'), h('dd', {}, c.tumorStage),
      h('dt', {}, 'Brown 分类'), h('dd', {}, c.brownClass),
      h('dt', {}, '取腓骨'), h('dd', {}, `${c.fibulaSide === 'left' ? '左' : '右'}侧 · 血管蒂${c.pedicleDir}`),
      h('dt', {}, '规划方案'), h('dd', {}, `${planCount} 套`),
    ),
    h('div', { class: 'plan-pills' },
      ...c.plans.map((p) => h('span', { class: 'plan-pill' }, p.name)),
    ),
    h('div', { class: 'actions' },
      btn('进入规划', () => open('#/resection'), { primary: true, small: true }),
      btn('模型', () => open('#/import'), { small: true }),
      btn('＋方案', () => {
        const p = createPlan(`方案 ${String.fromCharCode(65 + c.plans.length)}`, c.side, store.settings);
        store.mutateCase(c.id, (cc) => { cc.plans.push(p); cc.activePlanId = p.id; }, true);
        toast('已添加方案，可在各页顶部切换并并排比较', 'ok');
      }, { small: true }),
      btn('并排比较', () => openCompare(c), { small: true, disabled: c.plans.length < 2 }),
      btn('删除', () => {
        if (confirm(`确定删除病例「${c.name}」及其全部方案与模型？`)) void store.deleteCase(c.id);
      }, { small: true, danger: true }),
    ),
  );
}

function openCreateModal(): void {
  let side: Side = 'left';
  const nameInp = h('input', { class: 'input', value: '' }) as HTMLInputElement;
  const pidInp = h('input', { class: 'input', value: `P-2026-${String(Math.floor(Math.random() * 900) + 100)}` }) as HTMLInputElement;
  const stageSel = select(TUMOR_STAGES, TUMOR_STAGES[4]);
  const brownSel = select(BROWN_CLASSES, BROWN_CLASSES[1]);
  const fibSideSel = select([{ value: 'left', label: '左腓骨' }, { value: 'right', label: '右腓骨' }], 'right');
  const pedSel = select(PEDICLE_DIRS, PEDICLE_DIRS[1]);
  const sideSel = select([{ value: 'left', label: '左侧下颌（默认肿瘤在左体部）' }, { value: 'right', label: '右侧下颌（默认肿瘤在右体部）' }], 'left', (v) => { side = v as Side; fibSideSel.value = side === 'left' ? 'right' : 'left'; });

  const content = h('div', {},
    field2('病例名称', nameInp, '例如：张某·左下颌骨成釉细胞瘤'),
    h('div', { class: 'field-row' }, field2('住院/影像号', pidInp), field2('患侧', sideSel)),
    field2('肿瘤分期', stageSel),
    field2('Brown 缺损分类', brownSel),
    h('div', { class: 'field-row' }, field2('取腓骨侧别', fibSideSel), field2('血管蒂朝向', pedSel)),
    h('p', { class: 'muted', style: 'font-size:12px' }, '新建后会自动挂载程序化演示模型（下颌骨/腓骨/肿瘤/神经管），可在“模型导入”页替换为真实 STL/PLY。'),
  );
  const m = modal('新建病例', content, [
    btn('取消', () => m.close()),
    btn('创建并进入', () => {
      const now = Date.now();
      const plan = createPlan('方案 A（默认）', side, store.settings);
      const c: CaseRecord = {
        id: uid('case'), name: nameInp.value.trim() || `未命名病例 ${pidInp.value}`,
        side, patientName: nameInp.value.trim(), patientId: pidInp.value,
        tumorStage: stageSel.value, brownClass: brownSel.value,
        fibulaSide: fibSideSel.value as Side, pedicleDir: pedSel.value, note: '',
        createdAt: now, updatedAt: now, models: { reports: {} }, plans: [plan], activePlanId: plan.id,
      };
      void store.addCase(c).then(() => { m.close(); location.hash = '#/import'; });
    }, { primary: true }),
  ]);
}

function select(options: string[] | { value: string; label: string }[], value: string, onChange?: (v: string) => void): HTMLSelectElement {
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const sel = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const o of norm) {
    const op = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) op.selected = true;
    sel.append(op);
  }
  sel.addEventListener('change', () => onChange?.(sel.value));
  return sel;
}
function field2(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

function openCompare(c: CaseRecord): void {
  const rows = c.plans.map((p) => {
    const defect = measureDefect(p.planes);
    const layout = defect ? recomputeLayout(p.segments, defect, null) : null;
    return { p, len: defect?.lengthMm ?? 0, layout };
  });
  const metricRow = (label: string, get: (r: (typeof rows)[number]) => string) =>
    h('tr', {}, h('th', {}, label), ...rows.map((r) => h('td', { class: 'num' }, get(r))));
  const table = h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, '指标'), ...rows.map((r) => h('th', {}, r.p.name)))),
    h('tbody', {},
      metricRow('截骨平面数', (r) => String(r.p.planes.length)),
      metricRow('缺损弧长 mm', (r) => r.len.toFixed(1)),
      metricRow('腓骨段数', (r) => String(r.p.segments.length)),
      metricRow('各段长度 mm', (r) => r.p.segments.map((s) => s.lengthMm.toFixed(1)).join(' / ')),
      metricRow('楔形角 °', (r) => r.p.segments.map((s) => `${s.wedgeProxDeg.toFixed(1)}/${s.wedgeDistDeg.toFixed(1)}`).join('  ')),
      metricRow('最大接缝 mm', (r) => (r.layout ? Math.max(0, ...r.layout.gaps.map((g) => g.maxGapMm)).toFixed(2) : '0.00')),
      metricRow('颏部偏 mm', (r) => r.layout?.metrics.chinDevMm.toFixed(2) ?? '0.00'),
      metricRow('下颌角偏 L/R mm', (r) => `${r.layout?.metrics.leftAngleDevMm.toFixed(1) ?? 0} / ${r.layout?.metrics.rightAngleDevMm.toFixed(1) ?? 0}`),
      metricRow('轮廓 RMS mm', (r) => r.layout?.metrics.rmsMm.toFixed(2) ?? '0.00'),
    ),
  );
  const content = h('div', {},
    h('p', { class: 'muted' }, `病例「${c.name}」多方案指标并排；在各功能页顶部可切换当前方案继续编辑。`),
    table,
  );
  const m = modal(`方案并排比较（${c.plans.length} 套）`, content, [btn('关闭', () => m.close(), { primary: true })]);
}
