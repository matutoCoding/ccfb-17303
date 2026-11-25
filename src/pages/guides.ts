import { store } from '../state/store';
import { h, btn, badge, clear, toast } from '../ui/dom';
import { mountViewer } from '../ui/viewer';
import { requireCtx, planBar, commitPlan } from './common';
import { CsgPreview } from '../render/csgPreview';
import { buildGuide, GuideBuildResult } from '../core/guide';
import { fibulaDonorPlanes } from '../core/fibulaPlan';
import { GuideSpec, settingsFingerprint, CutPlaneSpec } from '../core/types';
import { Vec3 } from '../core/vec';
import { MeshData } from '../core/mesh';
import { markerPoints } from '../render/gizmo';
import { RenderObject } from '../render/Renderer';
import { uid } from '../state/seed';

type Kind = 'mandible' | 'fibula';

export function renderGuidesPage(root: HTMLElement): () => void {
  const ctx = requireCtx(root);
  if (!ctx) return () => {};
  const { case: c, plan } = ctx;
  const fp = settingsFingerprint(store.settings);

  let kind: Kind = 'mandible';
  let autoRelieve = true;
  let seatDir: Vec3 = [0, -1, 0.25];
  let guideResult: GuideBuildResult | null = null;
  let csg: CsgPreview | null = null;

  const side = h('div', { class: 'ws-side' });
  const viewHost = h('div', { class: 'ws-view' });
  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '导板设计'),
      h('span', { class: 'desc' }, '贴骨底板偏移出厚度 · 锯槽宽=锯片+间隙 · 固定钉孔 · 深度剥离+模板图像空间 CSG，拖槽不跑布尔'),
      h('div', { class: 'actions' }, planBar(c))),
    h('div', { class: 'workspace' }, side, viewHost),
  );

  const viewer = mountViewer(viewHost);
  const r = viewer.renderer;
  r.target = [0, 6, 6]; r.distance = 220; r.yaw = 0.6; r.pitch = 0.32;

  function boneAndPlanes(): { bone: MeshData | null; planes: CutPlaneSpec[] } {
    if (kind === 'mandible') {
      return { bone: store.getMesh(c.id, 'mandible'), planes: plan.planes.filter((p) => !p.id.startsWith('fdonor-') && !p.id.startsWith('fib-plane-')) };
    }
    return { bone: store.getMesh(c.id, 'fibula'), planes: fibulaDonorPlanes(plan.segments) };
  }

  function build(): void {
    const { bone, planes } = boneAndPlanes();
    if (!bone || planes.length === 0) {
      toast(kind === 'fibula' ? '请先在腓骨排布页生成分段' : '缺少下颌骨或截骨平面', 'err');
      return;
    }
    const s = store.settings;
    seatDir = kind === 'mandible' ? [0, -1, 0.25] : [0, 0, 1];
    guideResult = buildGuide(bone, {
      planes, seatDir, thickness: s.guideWallThickness,
      slotWidth: s.bladeThickness + s.kerfClearance,
      pinDiameter: s.pinDiameter, bandWidth: s.plateBandWidth,
      autoRelieve,
    });
    // 持久化 GuideSpec 元数据
    const spec: GuideSpec = {
      id: uid('guide'), kind, name: kind === 'mandible' ? '下颌骨截骨导板' : '腓骨截骨导板',
      seatDir, thickness: s.guideWallThickness, slotWidth: s.bladeThickness + s.kerfClearance,
      pinDiameter: s.pinDiameter, pinPoints: guideResult.pinPoints,
      undercutPoints: guideResult.undercutPoints, autoRelieve,
      settingsFingerprint: fp, createdAt: Date.now(),
    };
    if (kind === 'mandible') plan.guideMandible = spec; else plan.guideFibula = spec;
    commitPlan(c.id);
    refreshView();
    refreshPanel();
  }

  function refreshView(): void {
    const { bone } = boneAndPlanes();
    const objs: RenderObject[] = [];
    if (bone) objs.push({ id: 'bone', mesh: bone, color: kind === 'mandible' ? [0.86, 0.83, 0.78] : [0.85, 0.8, 0.72], opacity: 0.5 });
    if (guideResult?.undercutMesh && !autoRelieve) {
      objs.push({ id: 'undercut', mesh: guideResult.undercutMesh, color: [0.95, 0.1, 0.1], opacity: 0.85 });
    }
    if (guideResult && guideResult.pinPoints.length) {
      objs.push({ id: 'pins', mesh: markerPoints('pins', guideResult.pinPoints, [0.2, 0.4, 1]), vertexColors: true });
    }
    r.setObjects(objs);
    if (guideResult) {
      if (!csg) csg = new CsgPreview(r.gl);
      csg.setGuide(guideResult.plate, guideResult.cutters);
      r.customPass = (_gl, ctx) => csg!.render(ctx.viewProj, ctx.camPos, r.canvas.width, r.canvas.height);
    } else {
      r.customPass = null;
    }
  }

  function refreshPanel(): void {
    clear(side);
    const spec = kind === 'mandible' ? plan.guideMandible : plan.guideFibula;
    const stale = spec && spec.settingsFingerprint !== fp;

    const tabs = h('section', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('div', { class: 'row' },
        btn('下颌骨截骨导板', () => switchKind('mandible'), { small: true, primary: kind === 'mandible' }),
        btn('腓骨截骨导板', () => switchKind('fibula'), { small: true, primary: kind === 'fibula' }),
      ),
      stale ? h('div', { class: 'check-line mt8' }, h('span', { class: 'ico warn' }, '!'), h('div', {}, '设置已变更，该导板参数为旧版本，建议重算。')) : null,
    ));

    const params = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '导板参数（来自设置）')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'kv' },
          h('dt', {}, '底板厚度'), h('dd', {}, `${store.settings.guideWallThickness} mm`),
          h('dt', {}, '锯片厚度'), h('dd', {}, `${store.settings.bladeThickness} mm`),
          h('dt', {}, '锯槽宽度'), h('dd', { class: 'metric-ok' }, `${(store.settings.bladeThickness + store.settings.kerfClearance).toFixed(2)} mm`),
          h('dt', {}, '钉孔直径'), h('dd', {}, `${store.settings.pinDiameter} mm`),
          h('dt', {}, '贴骨带半宽'), h('dd', {}, `${store.settings.plateBandWidth} mm`),
        ),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '就位方向预设'),
          presetRow()),
        liveSlotRow(),
        h('label', { class: 'row mt8', style: 'gap:6px;font-size:13px' },
          h('input', { type: 'checkbox', checked: autoRelieve, onchange: (e: Event) => { autoRelieve = (e.target as HTMLInputElement).checked; build(); } }),
          '沿就位方向自动削除倒凹区'),
        h('div', { class: 'row mt8' },
          btn(guideResult ? '重新生成导板' : '生成导板', () => build(), { primary: true }),
          btn('去校核导出 →', () => (location.hash = '#/verify'), { small: true }),
        ),
      ));

    const info = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '就位 / 倒凹 / 钉孔')),
      h('div', { class: 'panel-body' },
        guideResult ? h('div', {},
          h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '✓'), h('div', {}, `贴骨选区 ${guideResult.selectedTriCount} 面；自动削除倒凹面 ${guideResult.removedUndercutTriCount}`)),
          h('div', { class: 'check-line' }, h('span', { class: guideResult.undercutPoints.length ? 'ico warn' : 'ico ok' }, guideResult.undercutPoints.length ? '!' : '✓'),
            h('div', {}, guideResult.undercutPoints.length ? `算出倒凹区 ${guideResult.undercutPoints.length} 处（视口红色），${autoRelieve ? '已沿就位方向削除' : '未开启自动削除'}` : '未发现明显倒凹')),
          h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '✓'), h('div', {}, `固定钉孔 ${guideResult.pinPoints.length} 个，直径 ${store.settings.pinDiameter}mm`)),
        ) : h('p', { class: 'muted' }, '点击“生成导板”，右侧将用深度剥离+模板 CSG 实时预览锯槽与钉孔。')),
    );

    const csgNote = h('section', { class: 'panel' }, h('div', { class: 'panel-body', style: 'font-size:12.5px;color:var(--ink-2)' },
      h('b', { style: 'color:var(--ink)' }, '图像空间 CSG：'),
      '两遍深度剥离得到骨板前后深度，骨板着色器逐片元剔除锯槽/钉孔，切割盒内壁仅在前后深度层之间绘制，并用模板限制在骨板覆盖区。拖动锯槽只改 uniform，不触发网格布尔。'));

    clear(side);
    side.append(tabs, params, info, csgNote);
  }

  function liveSlotRow(): HTMLElement {
    const w0 = store.settings.bladeThickness + store.settings.kerfClearance;
    const val = h('span', { class: 'muted', style: 'font-size:12px;min-width:42px;text-align:right' }, `${w0.toFixed(2)}`);
    const range = h('input', { type: 'range', min: '0.6', max: '2.2', step: '0.05', value: String(w0), style: 'flex:1' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      const w = parseFloat(range.value);
      val.textContent = `${w.toFixed(2)}mm`;
      if (!guideResult || !csg) return;
      // 只改锯槽盒的法向半宽并重建小切割体 GL —— 不跑网格布尔
      for (const c of guideResult.cutters) if (c.kind === 'box') c.obb.half[2] = w / 2;
      csg.setCutters(guideResult.cutters);
    });
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, '实时锯槽宽度（拖动即见 CSG，不重算布尔）'),
      h('div', { class: 'row' }, range, val));
  }

  function presetRow(): HTMLElement {
    const presets: { label: string; d: Vec3 }[] = kind === 'mandible'
      ? [{ label: '下方就位', d: [0, -1, 0.25] }, { label: '颊侧就位', d: [0.8, -0.4, 0] }, { label: '舌侧就位', d: [-0.8, -0.4, 0] }]
      : [{ label: '上方就位', d: [0, 0, 1] }, { label: '侧向就位', d: [0, 1, 0.3] }];
    return h('div', { class: 'row' }, ...presets.map((p) => btn(p.label, () => { seatDir = p.d; toast(`就位方向：${p.label}，请重新生成`, 'info', 1600); }, { small: true })));
  }

  function switchKind(k: Kind): void {
    kind = k;
    guideResult = null;
    if (csg) { r.customPass = null; csg = null; }
    const existing = k === 'mandible' ? plan.guideMandible : plan.guideFibula;
    if (existing) { autoRelieve = existing.autoRelieve; seatDir = existing.seatDir; }
    r.setObjects([]);
    refreshPanel();
  }

  viewHost.append(
    h('div', { class: 'view-toolbar' },
      btn('复位视角', () => { r.target = [0, 6, 6]; r.distance = 220; }, { small: true }),
      badge('实时 CSG 预览', 'info'),
    ),
    h('div', { class: 'view-hint' }, '橙色为锯槽/钉孔内壁 · 红色为倒凹区 · 左键旋转 · 滚轮缩放'),
  );

  // 初始：若已有规格直接生成一次
  const existing = kind === 'mandible' ? plan.guideMandible : plan.guideFibula;
  if (existing) { autoRelieve = existing.autoRelieve; seatDir = existing.seatDir; }
  build();

  return () => { viewer.dispose(); };
}
