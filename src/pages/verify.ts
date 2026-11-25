import { store } from '../state/store';
import { h, btn, badge, clear, table, toast, downloadBlob } from '../ui/dom';
import { mountViewer, ViewerHandle } from '../ui/viewer';
import { requireCtx, planBar, commitPlan } from './common';
import { buildGuide } from '../core/guide';
import { exportGuideSTL, ExportOutcome } from '../core/exportGuide';
import {
  inspectExportedSlots, slotsToVerificationRows, analyzeBladeSweep, compareMeshContours,
  FittedSlot, ContourCompareResult,
} from '../core/inspect';
import { fibulaDonorPlanes } from '../core/fibulaPlan';
import { CutPlaneSpec, SweepHit, VerificationRow, ExportRecord } from '../core/types';
import { writeBinarySTL } from '../core/io/stl';
import { RenderObject } from '../render/Renderer';

type Kind = 'mandible' | 'fibula';
let verifyKind: Kind = 'mandible';

interface VerifyResult {
  outcome: ExportOutcome;
  fitted: FittedSlot[];
  rows: VerificationRow[];
  sweep: SweepHit[];
  contour?: ContourCompareResult;
}

export function renderVerifyPage(root: HTMLElement): () => void {
  const ctx = requireCtx(root);
  if (!ctx) return () => {};
  const { case: c, plan } = ctx;
  let kind: Kind = verifyKind;
  let result: VerifyResult | null = null;
  let running = false;
  let viewerH: ViewerHandle | null = null;

  const host3d = h('div', { class: 'ws-view', style: 'height:560px' });
  const resultPanel = h('div', {});
  const progressWrap = h('div', {});

  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '校核与导出'),
      h('span', { class: 'desc' }, '锯槽夹角/偏移反拟合 · 锯片扫查神经管与对侧皮质 · 预览/导出轮廓偏差 · 水密自交壁厚放行'),
      h('div', { class: 'actions' }, planBar(c))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('div', { class: 'row' },
        btn('下颌骨导板校核', () => switchKind('mandible'), { small: true, primary: kind === 'mandible' }),
        btn('腓骨导板校核', () => switchKind('fibula'), { small: true, primary: kind === 'fibula' }),
        h('span', { style: 'flex:1' }),
        btn('▶ 运行校核并生成 STL', () => void run(), { primary: true }),
      ),
      progressWrap,
    )),
    h('div', { class: 'grid-2 wide-left', style: 'grid-template-columns:minmax(0,1.1fr) minmax(360px,.9fr)' },
      h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '导出 STL × 规划 叠合视图')), h('div', { class: 'panel-body', style: 'padding:0' }, host3d)),
      resultPanel,
    ),
  );

  viewerH = mountViewer(host3d);
  const r = viewerH.renderer;
  r.target = [0, 6, 6]; r.distance = 230;

  function planesFor(k: Kind): CutPlaneSpec[] {
    if (k === 'mandible') return plan.planes.filter((p) => !p.id.startsWith('fdonor-') && !p.id.startsWith('fib-plane-'));
    return fibulaDonorPlanes(plan.segments);
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    clear(progressWrap);
    const bar = h('div', { class: 'progress mt8' }, h('i', {}));
    const label = h('div', { class: 'muted mt8', style: 'font-size:12.5px' }, '准备…');
    progressWrap.append(bar, label);
    const setP = (m: string, pct?: number) => { label.textContent = m; if (pct !== undefined) (bar.firstElementChild as HTMLElement).style.width = `${pct}%`; };

    try {
      const planes = planesFor(kind);
      const bone = store.getMesh(c.id, kind === 'mandible' ? 'mandible' : 'fibula');
      if (!bone || planes.length === 0) { toast('缺少骨模型或截骨平面', 'err'); running = false; return; }
      const s = store.settings;
      setP('构建导板…', 8);
      const guide = buildGuide(bone, {
        planes, seatDir: kind === 'mandible' ? [0, -1, 0.25] : [0, 0, 1],
        thickness: s.guideWallThickness, slotWidth: s.bladeThickness + s.kerfClearance,
        pinDiameter: s.pinDiameter, bandWidth: s.plateBandWidth, autoRelieve: true,
      });
      setP('体素重建 + 布尔基准 + 校验…', 25);
      const outcome = await exportGuideSTL(guide, planes, s.bladeThickness + s.kerfClearance, s.guideWallThickness, {
        voxelMm: 0.16,
        onProgress: (m) => setP(m),
      });
      if (!outcome.ok || !outcome.stlMesh) {
        setP('导出被拦截', 100);
        progressWrap.append(h('div', { class: 'check-line mt8' }, h('span', { class: 'ico bad' }, '×'), h('div', {}, outcome.error ?? '导出失败')));
        toast('校验未通过，已阻止导出', 'err', 5000);
        running = false;
        return;
      }
      setP('反拟合锯槽平面…', 75);
      const fitted = inspectExportedSlots(outcome.stlMesh, planes, s.bladeThickness + s.kerfClearance);
      const rows = slotsToVerificationRows(fitted);

      setP('锯片扫查…', 85);
      const nerve = store.getMesh(c.id, 'nerve') ?? undefined;
      const mandible = store.getMesh(c.id, 'mandible') ?? undefined;
      const sweep: SweepHit[] = [];
      for (const pl of planesFor('mandible')) {
        sweep.push(...analyzeBladeSweep(pl, mandible, nerve, { thicknessMm: s.bladeThickness, widthMm: 20, reachMm: 30 }));
      }

      setP('轮廓偏差比对…', 92);
      let contour: ContourCompareResult | undefined;
      if (outcome.referenceMesh) contour = compareMeshContours(outcome.stlMesh, outcome.referenceMesh, s.printerPrecision, 2500);

      result = { outcome, fitted, rows, sweep, contour };
      setP('完成', 100);
      await new Promise((res) => setTimeout(res, 300));
      renderResult();
      renderOverlay();
      recordExport();
    } finally {
      running = false;
    }
  }

  function allAccuracyPass(): boolean {
    return !!result && result.rows.every((x) => x.anglePass && x.offsetPass);
  }
  function contourPass(): boolean { return !!result?.contour?.pass; }
  function canDownload(): boolean {
    return !!result?.outcome.ok && !!result.outcome.validation?.passed && allAccuracyPass();
  }

  function renderOverlay(): void {
    if (!result) return;
    const objs: RenderObject[] = [];
    const bone = store.getMesh(c.id, kind === 'mandible' ? 'mandible' : 'fibula');
    if (bone) objs.push({ id: 'bone', mesh: bone, color: [0.86, 0.83, 0.78], opacity: 0.35 });
    if (result.outcome.referenceMesh) objs.push({ id: 'ref', mesh: result.outcome.referenceMesh, color: [1, 0.55, 0.2], opacity: 0.35 });
    if (result.outcome.stlMesh) objs.push({ id: 'stl', mesh: result.outcome.stlMesh, color: [0.2, 0.55, 0.95], opacity: 0.9 });
    r.setObjects(objs);
    r.target = [0, 6, 6]; r.distance = 220;
  }

  function renderResult(): void {
    if (!result) return;
    clear(resultPanel);
    const { rows, sweep, contour, outcome } = result;
    const v = outcome.validation!;

    // 精度表
    const accTable = table(
      ['锯槽/规划平面', '夹角°', '偏移mm', '结论'],
      rows.map((row) => [
        h('span', {}, row.slotLabel),
        h('span', { class: row.anglePass ? 'pass' : 'fail' }, row.angleDeg >= 999 ? '未识别' : row.angleDeg.toFixed(3)),
        h('span', { class: row.offsetPass ? 'pass' : 'fail' }, row.offsetMm >= 999 ? '—' : row.offsetMm.toFixed(3)),
        row.anglePass && row.offsetPass ? badge('合格', 'ok') : badge('超差', 'bad'),
      ]),
    );
    const accPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, '① 锯槽精度（导出 STL 反拟合）'),
        h('div', { class: 'right' }, allAccuracyPass() ? badge('全部 ≤0.5° / ≤0.3mm', 'ok') : badge('存在超差', 'bad'))),
      h('div', { class: 'panel-body', style: 'padding:6px 10px;overflow-x:auto' }, accTable));

    // 轮廓
    const contourPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '② 预览/导出轮廓叠合')),
      h('div', { class: 'panel-body' },
        contour ? h('div', { class: 'kv' },
          h('dt', {}, '采样点'), h('dd', {}, `${contour.sampled}`),
          h('dt', {}, 'P95 轮廓偏差'), h('dd', { class: contour.pass ? 'metric-ok' : 'metric-bad' }, `${contour.p95DevMm.toFixed(3)} mm`),
          h('dt', {}, 'RMS'), h('dd', {}, `${contour.rmsDevMm.toFixed(3)} mm`),
          h('dt', {}, '最大偏差(离群)'), h('dd', {}, `${contour.maxDevMm.toFixed(3)} mm`),
          h('dt', {}, '打印机精度'), h('dd', {}, `${contour.limitMm} mm`),
          h('dt', {}, '结论'), h('dd', {}, contour.pass ? badge('P95 ≤ 打印机精度', 'ok') : badge('超过打印机精度', 'bad')),
        ) : h('p', { class: 'muted' }, '无 CSG 基准可比对。'),
        h('p', { class: 'muted', style: 'font-size:12px' }, '左图蓝色为导出 STL，橙色半透明为精修前体素 CSG 基准（与实时预览同一切割定义），骨为灰色半透明；可旋转叠合检查。')));

    // 扫查
    const sweepPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '③ 锯片扫查')),
      h('div', { class: 'panel-body' },
        sweep.length === 0 ? h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '✓'), h('div', {}, '未扫到神经管或对侧骨皮质异常接触。'))
          : sweep.map((hit) => h('div', { class: 'check-line' },
            h('span', { class: 'ico warn' }, '!'),
            h('div', {}, h('b', {}, `[${hit.planeLabel}] ${hit.target}`), h('div', { class: 'muted', style: 'font-size:12.5px' }, hit.message)))),
      ));

    // 校验
    const checkRow = (ok: boolean, text: string) => h('div', { class: 'check-line' }, h('span', { class: `ico ${ok ? 'ok' : 'bad'}` }, ok ? '✓' : '×'), h('div', {}, text));
    const validPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '④ 导出前强制校验')),
      h('div', { class: 'panel-body' },
        checkRow(v.watertight, `水密：${v.boundaryEdges} 条边界边`),
        checkRow(v.manifold, `流形：${v.nonManifoldEdges} 条非流形边`),
        checkRow(v.selfIntersectFree, `自交抽检：${v.selfIntersectionCount} 处`),
        checkRow(parseFloat(v.wallP5Mm.toFixed(2)) >= 0.8,
          `壁厚 P5=${v.wallP5Mm.toFixed(2)}mm（极端最小值 ${v.minWallMm.toFixed(2)}mm，样本 ${v.wallSamples}；可打印下限 0.8mm，名义 ${store.settings.guideWallThickness}mm）`),
        v.blockers.length ? h('div', { class: 'mt8' }, ...v.blockers.map((b) => h('div', { class: 'fail', style: 'font-size:12.5px' }, '• ' + b))) : null,
      ));

    // 导出
    const sizeKb = outcome.stl ? (outcome.stl.byteLength / 1024).toFixed(0) : '0';
    const exportPanel = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '⑤ 导出')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'row' },
          btn('⬇ 导出导板 STL（送 3D 打印）', () => {
            if (!result?.outcome.stl) return;
            downloadBlob(result.outcome.stl, `${c.patientId}_${kind}-guide.stl`);
            toast('STL 已导出', 'ok');
          }, { primary: true, disabled: !canDownload() }),
          btn('📄 导出规划单（HTML，可打印 PDF）', () => void exportReport(), {}),
        ),
        h('p', { class: 'muted mt8', style: 'font-size:12.5px' },
          canDownload() ? `STL 二进制 · ${sizeKb} KB · ${outcome.finalMesh ? (outcome.finalMesh.indices.length / 3).toLocaleString() : ''} 面，校验与精度全部放行。`
            : '存在未通过项，STL 导出已锁定；规划单仍可导出。'),
      ));

    resultPanel.append(accPanel, contourPanel, sweepPanel, validPanel, exportPanel);
  }

  function switchKind(k: Kind): void {
    verifyKind = k;
    (window as unknown as { __rerenderRoute?: () => void }).__rerenderRoute?.();
  }

  function recordExport(): void {
    if (!result?.outcome.validation) return;
    const rec: ExportRecord = {
      id: `exp-${Date.now()}`, at: Date.now(), kind: kind === 'mandible' ? 'mandible-guide' : 'fibula-guide',
      filename: `${c.patientId}_${kind}-guide.stl`,
      triangles: result.outcome.finalMesh ? result.outcome.finalMesh.indices.length / 3 : 0,
      watertight: result.outcome.validation.watertight, manifold: result.outcome.validation.manifold,
      selfIntersectFree: result.outcome.validation.selfIntersectFree,
      minWallMm: result.outcome.validation.wallP5Mm,
      contourMaxDevMm: result.contour?.maxDevMm, contourPass: result.contour?.pass,
      stlSize: result.outcome.stl?.byteLength ?? 0,
    };
    store.mutateCase(c.id, (cc) => { const p = cc.plans.find((x) => x.id === plan.id); p?.exports.unshift(rec); }, true);
  }

  async function exportReport(): Promise<void> {
    const shot = viewerH?.renderer.screenshot() ?? '';
    const rowsHtml = plan.segments.map((s, i) =>
      `<tr><td>${i + 1}</td><td>${s.lengthMm.toFixed(1)}</td><td>${s.wedgeProxDeg.toFixed(1)}°</td><td>${s.wedgeDistDeg.toFixed(1)}°</td><td>${s.donorT0.toFixed(3)}–${s.donorT1.toFixed(3)}</td></tr>`).join('');
    const accHtml = result?.rows.map((x) =>
      `<tr><td>${x.slotLabel}</td><td>${x.angleDeg.toFixed(3)}°</td><td>${x.offsetMm.toFixed(3)}</td><td>${x.anglePass && x.offsetPass ? '合格' : '超差'}</td></tr>`).join('')
      ?? '<tr><td colspan=4>尚未运行校核</td></tr>';
    const html = `<!doctype html><html lang=zh><head><meta charset=utf-8><title>腓骨瓣规划单 ${c.patientId}</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;padding:32px;color:#1c2433}h1{font-size:22px}h2{font-size:16px;margin-top:26px;border-left:4px solid #2563eb;padding-left:8px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ccd5e6;padding:6px 9px;text-align:left}th{background:#f2f5fc}.meta{display:grid;grid-template-columns:120px 1fr 120px 1fr;gap:6px 12px;font-size:13px}.shot{max-width:100%;border:1px solid #ccd5e6;border-radius:8px;margin-top:8px}.ok{color:#15955c;font-weight:700}.bad{color:#dc2626;font-weight:700}@media print{button{display:none}}</style></head><body>
<h1>腓骨瓣重建与截骨导板规划单</h1>
<div class=meta>
<b>患者</b><span>${c.patientName}</span><b>影像号</b><span>${c.patientId}</span>
<b>肿瘤分期</b><span>${c.tumorStage}</span><b>Brown 分类</b><span>${c.brownClass}</span>
<b>取腓骨</b><span>${c.fibulaSide === 'left' ? '左' : '右'}侧</span><b>血管蒂</b><span>${c.pedicleDir}</span>
<b>方案</b><span>${plan.name}</span><b>日期</b><span>${new Date().toLocaleString('zh-CN')}</span>
</div>
<h2>腓骨分段与楔形角</h2>
<table><thead><tr><th>段</th><th>长度 mm</th><th>近端楔角</th><th>远端楔角</th><th>供体 t 区间</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<p style=font-size:12.5px;color:#55607a>约束：单段 ≥20mm；远端保留 60mm 保踝；安全边界 ${store.settings.safetyMargin}mm。</p>
<h2>锯槽精度校核</h2>
<table><thead><tr><th>锯槽/规划平面</th><th>夹角</th><th>偏移 mm</th><th>结论</th></tr></thead><tbody>${accHtml}</tbody></table>
${result?.contour ? `<p>轮廓 P95 偏差 <b>${result.contour.p95DevMm.toFixed(3)}mm</b>（RMS ${result.contour.rmsDevMm.toFixed(3)} / 最大 ${result.contour.maxDevMm.toFixed(3)}），打印机精度 ${result.contour.limitMm}mm：<span class="${result.contour.pass ? 'ok' : 'bad'}">${result.contour.pass ? '通过' : '超差'}</span></p>` : ''}
<h2>截骨 / 导板视图</h2>
${shot ? `<img class=shot src="${shot}">` : '<p>无截图</p>'}
<p style="margin-top:28px;font-size:12px;color:#8a94ab">本规划单由浏览器内腓骨瓣导板规划系统生成，STL 经水密/流形/自交/壁厚校验。</p>
<button onclick="window.print()" style="padding:10px 20px;font-size:14px">打印 / 另存 PDF</button>
</body></html>`;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${c.patientId}_规划单.html`);
    // 同时把截图存入病例
    if (shot) store.mutateCase(c.id, (cc) => { const p = cc.plans.find((x) => x.id === plan.id); p?.screenshots.unshift({ name: '校核视图', dataUrl: shot, at: Date.now() }); }, true);
    toast('规划单已导出', 'ok');
  }

  // 初始叠合：显示骨
  const bone0 = store.getMesh(c.id, kind === 'mandible' ? 'mandible' : 'fibula');
  if (bone0) r.setObjects([{ id: 'bone', mesh: bone0, color: [0.86, 0.83, 0.78], opacity: 0.4 }]);

  return () => { viewerH?.dispose(); };
}

// 保持 writeBinarySTL 引用以便未来直接导出当前网格
void writeBinarySTL;
