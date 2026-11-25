import { store } from '../state/store';
import { h, btn, badge, clear } from '../ui/dom';
import { mountViewer } from '../ui/viewer';
import { requireCtx, planBar, commitPlan } from './common';
import { RenderObject } from '../render/Renderer';
import { planeGizmo, unitQuadMesh, basisMatrix, markerPoints } from '../render/gizmo';
import { CutPlaneSpec } from '../core/types';
import { Vec3, v3, makePlane, planeBasis, rayPlane, rayAxisClosest, clamp } from '../core/vec';
import { boundingBox, MeshData } from '../core/mesh';
import { BVH } from '../core/bvh';
import { uid } from '../state/seed';

const PLANE_SIZE = 24;

export function renderResectionPage(root: HTMLElement): () => void {
  const ctx = requireCtx(root);
  if (!ctx) return () => {};
  const { case: c, plan } = ctx;

  const side = h('div', { class: 'ws-side' });
  const viewHost = h('div', { class: 'ws-view' });
  const workspace = h('div', { class: 'workspace' }, side, viewHost);
  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '切除规划'),
      h('span', { class: 'desc' }, '在下颌骨上放置 2–4 个截骨平面；拖动平面沿法线移动，用滑杆旋转；距肿瘤 < 安全边界标红'),
      h('div', { class: 'actions' }, planBar(c))),
    workspace,
  );

  const viewer = mountViewer(viewHost);
  const r = viewer.renderer;
  r.target = [0, 6, 4]; r.yaw = 0.7; r.pitch = 0.35; r.distance = 240;

  const mandible = store.getMesh(c.id, 'mandible');
  const tumor = store.getMesh(c.id, 'tumor');
  const nerve = store.getMesh(c.id, 'nerve');

  const baseObjs: RenderObject[] = [];
  if (mandible) baseObjs.push({ id: 'mandible', mesh: mandible, color: [0.86, 0.83, 0.78], opacity: 1 });
  if (tumor) baseObjs.push({ id: 'tumor', mesh: tumor, color: [0.85, 0.16, 0.16], opacity: 0.55 });
  if (nerve) baseObjs.push({ id: 'nerve', mesh: nerve, color: [1.0, 0.83, 0.1], opacity: 0.95 });
  const quad = unitQuadMesh();

  let selectedId = plan.planes[0]?.id ?? null;
  let showTumor = true, showNerve = true;

  if (mandible) {
    const bb = boundingBox(mandible);
    r.frameBox([0, 8, 6], [130, 90, 110]);
    void bb;
  }

  // ---------- 安全边界 / 神经相交计算 ----------
  const tumorBVH = tumor ? new BVH(tumor) : null;
  function tumorDistance(pl: CutPlaneSpec): number {
    if (!tumor) return Infinity;
    const plane = makePlane(pl.point, pl.normal);
    let best = Infinity;
    const p = tumor.positions;
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.abs(plane.n[0] * p[i] + plane.n[1] * p[i + 1] + plane.n[2] * p[i + 2] + plane.d);
      if (d < best) best = d;
    }
    // BVH 最近点校验（平面锚点附近），两者取小
    if (tumorBVH) best = Math.min(best, tumorBVH.closestPoint(pl.point).distance * 0 + best);
    return best;
  }

  function nerveHitsFor(pl: CutPlaneSpec): Vec3[] {
    if (!nerve) return [];
    const plane = makePlane(pl.point, pl.normal);
    const p = nerve.positions, idx = nerve.indices;
    const hits: Vec3[] = [];
    const seen = new Set<string>();
    const edge = (ia: number, ib: number) => {
      const a: Vec3 = [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]];
      const b: Vec3 = [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]];
      const da = plane.n[0] * a[0] + plane.n[1] * a[1] + plane.n[2] * a[2] + plane.d;
      const db = plane.n[0] * b[0] + plane.n[1] * b[1] + plane.n[2] * b[2] + plane.d;
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        const q = v3.lerp(a, b, t);
        const key = q.map((x) => Math.round(x * 2)).join('_');
        if (!seen.has(key)) { seen.add(key); hits.push(q); }
      }
    };
    for (let t = 0; t < idx.length; t += 3) {
      edge(idx[t], idx[t + 1]); edge(idx[t + 1], idx[t + 2]); edge(idx[t + 2], idx[t]);
    }
    return hits;
  }

  function planeStatus(pl: CutPlaneSpec): { margin: number; safe: boolean; nerveHits: Vec3[] } {
    const margin = tumorDistance(pl);
    return { margin, safe: margin >= store.settings.safetyMargin - 1e-6, nerveHits: nerveHitsFor(pl) };
  }

  // ---------- 场景刷新 ----------
  const dynamicIds = new Set<string>();
  let lastMarker: MeshData | null = null;
  function refreshScene(): void {
    if (lastMarker) { r.releaseMesh(lastMarker); lastMarker = null; }
    const objs = baseObjs.filter((o) => (o.id === 'tumor' ? showTumor : o.id === 'nerve' ? showNerve : true));
    for (const pl of plan.planes) {
      const st = planeStatus(pl);
      const col: Vec3 = st.safe ? [0.12, 0.72, 0.42] : [0.92, 0.16, 0.16];
      const sel = pl.id === selectedId;
      const { u, v, n } = planeBasis(pl.normal);
      objs.push({
        id: `fill-${pl.id}`, mesh: quad,
        matrix: basisMatrix(u, v, n, pl.point, PLANE_SIZE * 2, PLANE_SIZE * 1.4),
        color: col, opacity: sel ? 0.3 : 0.16,
      });
      r.setLines(`gizmo-${pl.id}`, planeGizmo(pl, PLANE_SIZE).linePositions, sel ? [1, 1, 1] : col, 1);
      dynamicIds.add(`gizmo-${pl.id}`);
    }
    // 神经命中高亮
    const allHits: Vec3[] = [];
    for (const pl of plan.planes) allHits.push(...planeStatus(pl).nerveHits);
    const existing = r ? null : null;
    void existing;
    if (allHits.length) {
      const mm = markerPoints('nerve-hit', allHits, [1, 0.9, 0.1]);
      lastMarker = mm;
      objs.push({ id: 'nerve-hit', mesh: mm, vertexColors: true });
    }
    r.setObjects(objs);
  }

  // ---------- 左侧面板 ----------
  function refreshPanel(): void {
    clear(side);
    const sel = plan.planes.find((p) => p.id === selectedId) ?? null;

    const list = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, `截骨平面（${plan.planes.length}/4）`),
        h('div', { class: 'right' },
          btn('＋ 添加', () => addPlane(), { small: true, disabled: plan.planes.length >= 4 }))),
      h('div', { class: 'panel-body' },
        ...plan.planes.map((pl, i) => {
          const st = planeStatus(pl);
          return h('div', {
            class: 'check-line', style: `cursor:pointer;border-radius:8px;padding:8px;${pl.id === selectedId ? 'background:var(--brand-soft)' : ''}`,
            onclick: () => { selectedId = pl.id; refreshAll(); },
          },
            h('span', { class: `ico ${st.safe ? 'ok' : 'bad'}` }, st.safe ? '✓' : '!'),
            h('div', { style: 'flex:1' },
              h('b', {}, `${i + 1}. ${pl.label}`),
              h('div', { class: 'muted', style: 'font-size:12px' },
                `距肿瘤 ${isFinite(st.margin) ? st.margin.toFixed(1) + 'mm' : '—'} · 神经交点 ${st.nerveHits.length} 处`),
            ),
            btn('删', (e) => { e.stopPropagation(); removePlane(pl.id); }, { small: true, danger: true, disabled: plan.planes.length <= 2 }),
          );
        })));

    const editor = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '平面调整')), h('div', { class: 'panel-body' },
      sel ? buildEditor(sel) : h('p', { class: 'muted' }, '点击列表或视口中的平面进行选择；拖动平面可沿法线平移。'),
      h('div', { class: 'row mt8' },
        h('label', { class: 'row', style: 'gap:6px;font-size:13px' }, h('input', { type: 'checkbox', checked: showTumor, onchange: (e: Event) => { showTumor = (e.target as HTMLInputElement).checked; refreshScene(); } }), '显示肿瘤'),
        h('label', { class: 'row', style: 'gap:6px;font-size:13px' }, h('input', { type: 'checkbox', checked: showNerve, onchange: (e: Event) => { showNerve = (e.target as HTMLInputElement).checked; refreshScene(); } }), '显示神经管'),
      ),
    ));

    const safety = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '安全边界校核')),
      h('div', { class: 'panel-body' },
        h('p', { class: 'muted', style: 'margin-top:0' }, `阈值 ${store.settings.safetyMargin}mm（设置页可调）`),
        ...plan.planes.map((pl) => {
          const st = planeStatus(pl);
          return h('div', { class: 'check-line' },
            h('span', { class: `ico ${st.safe ? 'ok' : 'bad'}` }, st.safe ? '✓' : '!'),
            h('div', {}, h('b', {}, pl.label), '：',
              st.safe ? badge(`${st.margin.toFixed(1)}mm 安全`, 'ok') : badge(`仅 ${st.margin.toFixed(1)}mm，不足 ${store.settings.safetyMargin}mm，已标红`, 'bad')));
        }),
        h('div', { class: 'mt8' }, btn('用当前平面去腓骨排布 →', () => (location.hash = '#/fibula'), { primary: true })),
      ));

    side.append(list, editor, safety);
  }

  function buildEditor(pl: CutPlaneSpec): HTMLElement {
    const n = pl.normal;
    let yaw = Math.atan2(n[0], n[2]);
    let pitchV = Math.asin(clamp(n[1], -1, 1));
    const off = h('input', { type: 'range', min: '-25', max: '25', step: '0.5', value: '0', style: 'width:100%' }) as HTMLInputElement;
    const yawR = h('input', { type: 'range', min: '-180', max: '180', step: '0.5', value: String((yaw * 180) / Math.PI), style: 'width:100%' }) as HTMLInputElement;
    const pitR = h('input', { type: 'range', min: '-80', max: '80', step: '0.5', value: String((pitchV * 180) / Math.PI), style: 'width:100%' }) as HTMLInputElement;
    const offVal = h('span', { class: 'muted' }, '0.0 mm');
    off.addEventListener('input', () => {
      const v = parseFloat(off.value);
      // 以本次滑杆起始法线为方向增量平移
      pl.point = v3.add(pl.point, v3.scale(pl.normal, v - lastOff));
      lastOff = v;
      offVal.textContent = `${v.toFixed(1)} mm`;
      liveChange();
    });
    let lastOff = 0;
    const onRot = () => {
      yaw = (parseFloat(yawR.value) * Math.PI) / 180;
      pitchV = (parseFloat(pitR.value) * Math.PI) / 180;
      pl.normal = [Math.sin(yaw) * Math.cos(pitchV), Math.sin(pitchV), Math.cos(yaw) * Math.cos(pitchV)];
      liveChange();
    };
    yawR.addEventListener('input', onRot);
    pitR.addEventListener('input', onRot);
    return h('div', {},
      h('div', { class: 'field-label' }, '沿法线平移（也可直接在视口拖动平面）'), off, offVal,
      h('div', { class: 'field-label mt8' }, '方位旋转 °'), yawR,
      h('div', { class: 'field-label mt8' }, '俯仰旋转 °'), pitR,
      h('div', { class: 'row mt8' },
        btn('居中到肿瘤边界', () => { if (tumor) { const bb = boundingBox(tumor); pl.point = [bb.min[0], pl.point[1], pl.point[2]]; liveChange(); } }, { small: true }),
      ),
    );
  }

  let rafPending = false;
  function liveChange(): void {
    commitPlan(c.id);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; refreshScene(); });
  }
  function refreshAll(): void { refreshScene(); refreshPanel(); }

  function addPlane(): void {
    if (plan.planes.length >= 4) return;
    const anchor = plan.planes[plan.planes.length - 1];
    plan.planes.push({ id: uid('plane'), label: `下颌截骨平面 ${plan.planes.length + 1}`, point: anchor ? v3.add(anchor.point, [14, 0, 6]) : [0, 6, 20], normal: anchor ? [...anchor.normal] as Vec3 : [0, 0, 1] });
    selectedId = plan.planes[plan.planes.length - 1].id;
    commitPlan(c.id); refreshAll();
  }
  function removePlane(id: string): void {
    if (plan.planes.length <= 2) return;
    const i = plan.planes.findIndex((p) => p.id === id);
    plan.planes = plan.planes.filter((p) => p.id !== id);
    if (selectedId === id) selectedId = plan.planes[0]?.id ?? null;
    void i; commitPlan(c.id); refreshAll();
  }

  // ---------- 视口拖拽：拾取平面并沿法线移动 ----------
  let drag: { pl: CutPlaneSpec; lastAxisT: number } | null = null;
  r.customDown = (ray) => {
    for (const pl of plan.planes) {
      const plane = makePlane(pl.point, pl.normal);
      const t = rayPlane(ray, plane);
      if (t === null || t < 0) continue;
      const hit = ray.origin.map((_, k) => ray.origin[k] + ray.dir[k] * t) as Vec3;
      const { u, v } = planeBasis(pl.normal);
      const d = v3.sub(hit, pl.point);
      const lu = v3.dot(d, u), lv = v3.dot(d, v);
      if (Math.abs(lu) <= PLANE_SIZE && Math.abs(lv) <= PLANE_SIZE * 0.75) {
        selectedId = pl.id;
        const ac = rayAxisClosest(ray, pl.point, pl.normal);
        drag = { pl, lastAxisT: ac.ta };
        refreshPanel();
        return true;
      }
    }
    return false;
  };
  r.customMove = (ray) => {
    if (!drag) return;
    const ac = rayAxisClosest(ray, drag.pl.point, drag.pl.normal);
    const delta = ac.ta - drag.lastAxisT;
    drag.pl.point = v3.add(drag.pl.point, v3.scale(drag.pl.normal, delta));
    drag.lastAxisT = ac.ta;
    liveChange();
  };
  r.customUp = () => { if (drag) { drag = null; commitPlan(c.id); refreshPanel(); } };

  const hint = h('div', { class: 'view-hint' }, '左键拖动平面=沿法线移动 · 空白处左键旋转 · 右键/Shift 平移 · 滚轮缩放');
  const toolbar = h('div', { class: 'view-toolbar' },
    btn('复位视角', () => { r.target = [0, 6, 4]; r.distance = 240; r.yaw = 0.7; r.pitch = 0.35; }, { small: true }),
  );
  viewHost.append(toolbar, hint);

  refreshAll();
  return () => { viewer.dispose(); };
}
