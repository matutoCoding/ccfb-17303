import { store } from '../state/store';
import { h, btn, clear, toast } from '../ui/dom';
import { mountViewer } from '../ui/viewer';
import { requireCtx, planBar, commitPlan } from './common';
import { RenderObject } from '../render/Renderer';
import { gapDiscMesh } from '../render/gizmo';
import { FibulaSegmentSpec } from '../core/types';
import { Vec3, v3, m4, Mat4, rayPlane, rayAxisClosest } from '../core/vec';
import { MeshData } from '../core/mesh';
import { sweepTube } from '../core/procedural';
import {
  measureDefect, createInitialSegments, recomputeLayout, buildFibulaCutPlanes,
  MIN_SEGMENT_MM,
} from '../core/fibulaPlan';
import { segmentMatrix, q as quatLib } from '../core/quat';

/** 单位长度（X 轴 -0.5..0.5）腓骨段，半径保持真实 mm，靠 X 缩放得到长度 */
function unitFibulaSegment(): MeshData {
  const pts: Vec3[] = [];
  for (let i = 0; i <= 6; i++) pts.push([-0.5 + i / 6, 0, 0]);
  const m = sweepTube('fib-seg-unit', pts, {
    radialSegments: 16, threeLobe: 0.12,
    radiusA: () => 6.4, radiusB: () => 7.2,
  });
  return m;
}

export function renderFibulaPage(root: HTMLElement): () => void {
  const ctx = requireCtx(root);
  if (!ctx) return () => {};
  const { case: c, plan } = ctx;

  // 确保有分段
  let defect = measureDefect(plan.planes);
  if (defect && plan.segments.length === 0) {
    plan.segments = createInitialSegments(defect, undefined, store.settings.bladeThickness + store.settings.kerfClearance);
    commitPlan(c.id);
  }

  const side = h('div', { class: 'ws-side' });
  const viewHost = h('div', { class: 'ws-view' });
  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '腓骨排布'),
      h('span', { class: 'desc' }, '按缺损弧长自动分段、计算长度与两头楔形角；拖动段位置，邻段楔形角跟随重算；接缝缝隙彩色显示'),
      h('div', { class: 'actions' }, planBar(c))),
    h('div', { class: 'workspace' }, side, viewHost),
  );

  const viewer = mountViewer(viewHost);
  const r = viewer.renderer;
  r.target = [0, 4, 6]; r.yaw = 0.6; r.pitch = 0.3; r.distance = 230;

  const mandible = store.getMesh(c.id, 'mandible');
  const unitSeg = unitFibulaSegment();
  let showOriginal = true;
  let gapMeshes: MeshData[] = [];

  function modelMatrix(s: FibulaSegmentSpec): Mat4 {
    const tr = segmentMatrix(s.baseCenter, s.baseAxis, s.adjust.offset, s.adjust.quat);
    return m4.multiply(tr, m4.scaling(s.lengthMm, 1, 1));
  }

  function relayout(fixedId: string | null) {
    defect = measureDefect(plan.planes);
    if (!defect) return null;
    const layout = recomputeLayout(plan.segments, defect, fixedId);
    plan.gaps = layout.gaps;
    // 同步腓骨截骨平面到 plan（供导板/校核使用），保留下颌平面在前
    const fibPlanes = buildFibulaCutPlanes(plan.segments, layout);
    plan.planes = [...plan.planes.filter((p) => !p.id.startsWith('fib-plane-')), ...fibPlanes];
    commitPlan(c.id);
    return layout;
  }
  let layout = relayout(null);

  function refreshScene(): void {
    for (const gm of gapMeshes) r.releaseMesh(gm);
    gapMeshes = [];
    const objs: RenderObject[] = [];
    if (mandible && showOriginal) objs.push({ id: 'mandible-ghost', mesh: mandible, color: [0.7, 0.78, 0.92], opacity: 0.22 });
    plan.segments.forEach((s, i) => {
      const bad = s.lengthMm < MIN_SEGMENT_MM;
      objs.push({
        id: `seg-${s.id}`, mesh: unitSeg, matrix: modelMatrix(s),
        color: bad ? [0.9, 0.35, 0.3] : segmentColor(i), opacity: 1,
      });
    });
    for (const g of plan.gaps) {
      const gm = gapDiscMesh(g);
      gapMeshes.push(gm);
      objs.push({ id: `gap-${g.jointIndex}`, mesh: gm, vertexColors: true, opacity: 0.92 });
    }
    r.setObjects(objs);
  }

  function refreshPanel(): void {
    clear(side);
    const L = layout;
    const m = L?.metrics;
    const maxGap = plan.gaps.reduce((a, g) => Math.max(a, g.maxGapMm), 0);
    const minLen = Math.min(...plan.segments.map((s) => s.lengthMm), Infinity);

    const auto = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '自动分段')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'kv' },
          h('dt', {}, '缺损弧长'), h('dd', {}, defect ? `${defect.lengthMm.toFixed(1)} mm` : '—'),
          h('dt', {}, '段数'), h('dd', {}, `${plan.segments.length} 段`),
          h('dt', {}, '最短段'), h('dd', { class: minLen < MIN_SEGMENT_MM ? 'metric-bad' : '' }, `${isFinite(minLen) ? minLen.toFixed(1) : '—'} mm（下限 ${MIN_SEGMENT_MM}）`),
          h('dt', {}, '远端保踝'), h('dd', { class: L?.distalReserveOk ? '' : 'metric-bad' }, L?.distalReserveOk ? '已留 ≥60mm ✓' : '供体长度超限 ✗'),
        ),
        h('div', { class: 'row mt8' },
          btn('自动重排', () => { autoArrange(); }, { primary: true, small: true }),
          btn('＋一段', () => setCount(plan.segments.length + 1), { small: true, disabled: plan.segments.length >= 4 }),
          btn('－一段', () => setCount(plan.segments.length - 1), { small: true, disabled: plan.segments.length <= 1 }),
        ),
      ));

    const valid = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '放行条件')),
      h('div', { class: 'panel-body' },
        condition(minLen >= MIN_SEGMENT_MM, `每段 ≥ ${MIN_SEGMENT_MM}mm`, `存在短于 ${MIN_SEGMENT_MM}mm 的段，不允许进入导板`),
        condition(!!L?.distalReserveOk, '远端保留 6cm 保踝', '供体排布侵入远端 60mm'),
        condition(maxGap < 1.5, `接缝缝隙 ${maxGap.toFixed(2)}mm`, `最大缝隙 ${maxGap.toFixed(2)}mm 偏大，请调整段位置`),
      ));

    const metrics = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '轮廓偏差（实时）')),
      h('div', { class: 'panel-body' },
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
          metric('颏部偏移', m?.chinDevMm ?? 0),
          metric('左下颌角', m?.leftAngleDevMm ?? 0),
          metric('右下颌角', m?.rightAngleDevMm ?? 0),
          metric('轮廓 RMS', m?.rmsMm ?? 0),
        ),
        h('div', { class: 'muted mt8', style: 'font-size:12px' }, `最大轮廓偏差 ${m?.maxDevMm.toFixed(2) ?? '0.00'}mm；拖动一段时邻段自动重新对准，楔形角重算。`),
        h('label', { class: 'row mt8', style: 'gap:6px;font-size:13px' },
          h('input', { type: 'checkbox', checked: showOriginal, onchange: (e: Event) => { showOriginal = (e.target as HTMLInputElement).checked; refreshScene(); } }),
          '原始下颌轮廓半透明叠加'),
      ));

    const segPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '各段长度 / 楔形角')),
      h('div', { class: 'panel-body', style: 'padding:6px 10px' },
        h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, '段'), h('th', { class: 'num' }, '长度'), h('th', { class: 'num' }, '近端楔角'), h('th', { class: 'num' }, '远端楔角'), h('th', {}, '复位'))),
          h('tbody', {}, ...plan.segments.map((s, i) => h('tr', {},
            h('td', {}, `#${i + 1}`),
            h('td', { class: `num ${s.lengthMm < MIN_SEGMENT_MM ? 'fail' : ''}` }, `${s.lengthMm.toFixed(1)}`),
            h('td', { class: 'num' }, `${s.wedgeProxDeg.toFixed(1)}°`),
            h('td', { class: 'num' }, `${s.wedgeDistDeg.toFixed(1)}°`),
            h('td', {}, btn('复位', () => { s.adjust.offset = [0, 0, 0]; s.adjust.quat = [0, 0, 0, 1]; afterDrag(null); }, { small: true })),
          ))),
        ),
      ));

    const gapPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '接缝缝隙')),
      h('div', { class: 'panel-body' },
        plan.gaps.length === 0 ? h('span', { class: 'muted' }, '单段无间接缝。') :
          plan.gaps.map((g) => h('div', { class: 'check-line' },
            h('span', { class: 'ico', style: `background:rgb(${g.color.map((x) => Math.round(x * 255)).join(',')})` }, ''),
            h('div', {}, `接缝 ${g.jointIndex + 1}：最大 ${g.maxGapMm.toFixed(2)}mm / 平均 ${g.meanGapMm.toFixed(2)}mm / 侧向错位 ${g.lateralMm.toFixed(2)}mm`))),
        h('div', { class: 'legend', style: 'position:static;margin-top:10px;width:auto' },
          '缝隙色标', h('div', { class: 'bar' }), h('div', { class: 'scale' }, h('span', {}, '0'), h('span', {}, '1.2'), h('span', {}, '2.5+mm'))),
        h('div', { class: 'mt8' }, btn('去导板设计 →', () => (location.hash = '#/guides'), { primary: true })),
      ));

    side.append(auto, valid, metrics, segPanel, gapPanel);
  }

  function metric(label: string, v: number): HTMLElement {
    const tone = v < 1 ? 'metric-ok' : v < 3 ? 'metric-warn' : 'metric-bad';
    return h('div', { style: 'background:#f6f8fd;border-radius:10px;padding:10px' },
      h('div', { class: 'muted', style: 'font-size:12px' }, label),
      h('div', { class: `metric-big ${tone}` }, `${v.toFixed(1)}`), h('span', { class: 'muted' }, ' mm'));
  }
  function condition(ok: boolean, okText: string, badText: string): HTMLElement {
    return h('div', { class: 'check-line' }, h('span', { class: `ico ${ok ? 'ok' : 'bad'}` }, ok ? '✓' : '×'), h('div', {}, ok ? okText : badText));
  }

  function setCount(n: number): void {
    if (!defect) return;
    n = clampInt(n, 1, 4);
    plan.segments = createInitialSegments(defect, n, store.settings.bladeThickness + store.settings.kerfClearance);
    afterDrag(null);
  }
  function autoArrange(): void {
    if (!defect) return;
    const n = plan.segments.length || undefined;
    plan.segments = createInitialSegments(defect, n, store.settings.bladeThickness + store.settings.kerfClearance);
    afterDrag(null);
    toast2('已按下颌原始外轮廓自动排布');
  }

  let raf = 0;
  function afterDrag(fixed: string | null): void {
    layout = relayout(fixed);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { refreshScene(); refreshPanel(); });
  }

  // ---------- 拾取并拖动段 ----------
  let drag: { seg: FibulaSegmentSpec; planeN: Vec3; planeP: Vec3; grabOffset: Vec3 } | null = null;
  r.customDown = (ray) => {
    let best: { seg: FibulaSegmentSpec; dist: number } | null = null;
    for (const s of plan.segments) {
      const center = v3.add(s.baseCenter, s.adjust.offset);
      const axis = segmentAxisWorld(s);
      const ac = rayAxisClosest(ray, center, axis);
      if (Math.abs(ac.ta) > s.lengthMm / 2 + 5) continue;
      const pRay = ray.origin.map((_, k) => ray.origin[k] + ray.dir[k] * ac.tr) as Vec3;
      const pAx = v3.add(center, v3.scale(axis, ac.ta));
      const d = v3.dist(pRay, pAx);
      if (d < 12 && (!best || d < best.dist)) best = { seg: s, dist: d };
    }
    if (best) {
      const camFwd = v3.norm(v3.sub(r.target, r.camPos));
      const planeN = camFwd;
      const planeP = v3.add(best.seg.baseCenter, best.seg.adjust.offset);
      const t = rayPlaneLocal(ray, planeP, planeN);
      const hit = t !== null ? ray.origin.map((_, k) => ray.origin[k] + ray.dir[k] * t) as Vec3 : planeP;
      drag = { seg: best.seg, planeN, planeP, grabOffset: v3.sub(planeP, hit) };
      return true;
    }
    return false;
  };
  r.customMove = (ray) => {
    if (!drag) return;
    const t = rayPlaneLocal(ray, drag.planeP, drag.planeN);
    if (t === null) return;
    const hit = ray.origin.map((_, k) => ray.origin[k] + ray.dir[k] * t) as Vec3;
    const center = v3.add(hit, drag.grabOffset);
    drag.seg.adjust.offset = v3.sub(center, drag.seg.baseCenter);
    afterDrag(drag.seg.id);
  };
  r.customUp = () => { if (drag) { drag = null; commitPlan(c.id); refreshPanel(); } };

  viewHost.append(
    h('div', { class: 'view-toolbar' }, btn('复位视角', () => { r.target = [0, 4, 6]; r.distance = 230; }, { small: true })),
    h('div', { class: 'view-hint' }, '按住腓骨段拖动位置 · 邻段与楔形角自动重算 · 空白处旋转视角'),
  );

  refreshScene();
  refreshPanel();
  return () => { viewer.dispose(); };
}

function segmentAxisWorld(s: FibulaSegmentSpec): Vec3 {
  return quatLib.rotateVec(s.adjust.quat, s.baseAxis);
}

function rayPlaneLocal(ray: { origin: Vec3; dir: Vec3 }, p: Vec3, n: Vec3): number | null {
  const pl = { n, p, d: -v3.dot(n, p) };
  return rayPlane(ray, pl);
}

function segmentColor(i: number): Vec3 {
  const palette: Vec3[] = [[0.95, 0.72, 0.35], [0.36, 0.78, 0.62], [0.45, 0.66, 0.95], [0.78, 0.55, 0.92]];
  return palette[i % palette.length];
}
function clampInt(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n))); }
function toast2(msg: string): void { toast(msg, 'ok'); }
