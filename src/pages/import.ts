import { store } from '../state/store';
import { h, btn, badge, toast } from '../ui/dom';
import { parseModelFile } from '../core/io';
import { inspectTopology, repairMesh } from '../core/topology';
import { meshToJSON } from '../core/mesh';
import { ModelHealthRecord, ModelKind } from '../core/types';
import { generateMandible, generateFibula, generateTumor, generateNerve, generateBrokenFibula, defaultTumorCenter } from '../core/procedural';

const KINDS: { kind: ModelKind; label: string; accept: string }[] = [
  { kind: 'mandible', label: '下颌骨', accept: '.stl,.ply' },
  { kind: 'fibula', label: '腓骨', accept: '.stl,.ply' },
  { kind: 'tumor', label: '肿瘤', accept: '.stl,.ply' },
  { kind: 'nerve', label: '下牙槽神经管', accept: '.stl,.ply' },
];

export function renderImportPage(root: HTMLElement): () => void {
  const c0 = store.currentCase;
  if (!c0) {
    root.append(h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      '请先在病例列表选择或新建一个病例。', h('div', { class: 'mt8' }, btn('去病例列表', () => (location.hash = '#/cases'), { primary: true })))));
    return () => {};
  }
  const caseId = c0.id;

  const slotGrid = h('div', { class: 'import-kind-grid' });
  const reportWrap = h('div', {});
  const drop = h('div', { class: 'dropzone' },
    h('div', { style: 'font-size:15px;font-weight:700;margin-bottom:4px' }, '拖拽 STL / PLY 到此处，或点击选择'),
    h('div', {}, '按文件名自动识别：下颌骨 / 腓骨 / 肿瘤 / 神经；也可点各卡片按钮指定类型'),
  );
  const fileInput = h('input', { type: 'file', accept: '.stl,.ply', multiple: true, style: 'display:none' }) as HTMLInputElement;
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void handleFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files) void handleFiles(Array.from(dt.files));
  });

  const sampleRow = h('div', { class: 'row mt8' },
    h('span', { class: 'muted' }, '没有文件？装入内置测试模型：'),
    btn('全套正常模型', () => loadBuiltinAll(), { small: true }),
    btn('注入“破洞+翻转面”腓骨', () => loadBrokenFibula(), { small: true }),
  );

  const layout = h('div', {},
    h('div', { class: 'page-head' }, h('h2', {}, '模型导入与体检'),
      h('span', { class: 'desc' }, '自动检查破洞 / 非流形边 / 翻转法线，可修复项自动修复并标记，无法修复则指明哪块模型、什么问题并拒收')),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, drop, fileInput, sampleRow)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '模型槽位')), h('div', { class: 'panel-body' }, slotGrid)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '体检与修复报告')), h('div', { class: 'panel-body' }, reportWrap)),
  );
  root.append(layout);

  function drawSlots(): void {
    const c = store.currentCase;
    slotGrid.replaceChildren();
    for (const k of KINDS) {
      const rep = c?.models.reports?.[k.kind];
      const has = !!store.getMesh(caseId, k.kind);
      const status = rep?.rejected
        ? badge('已拒收', 'bad')
        : has ? badge(rep?.repaired?.length ? '已修复入库' : '正常入库', rep?.repaired?.length ? 'warn' : 'ok')
          : badge('未导入', 'muted');
      const card = h('div', { class: 'kind-slot' },
        h('div', { class: 'row', style: 'justify-content:center' }, kindIcon(k.kind)),
        h('div', { class: 'kname' }, k.label),
        h('div', { class: 'kstat' }, rep ? `${rep.vertexCount.toLocaleString()} 顶点 · ${rep.triangleCount.toLocaleString()} 面` : '等待 STL/PLY'),
        h('div', { style: 'margin:6px 0' }, status),
        h('div', { class: 'row', style: 'justify-content:center' },
          btn('选择文件', () => pickFor(k.kind), { small: true }),
          has ? btn('移除', () => removeKind(k.kind), { small: true, danger: true }) : null,
        ),
      );
      slotGrid.append(card);
    }
    drawReports();
  }

  function drawReports(): void {
    const c = store.currentCase;
    reportWrap.replaceChildren();
    const reps = c?.models.reports ? Object.values(c.models.reports) : [];
    if (!reps.length) { reportWrap.append(h('p', { class: 'muted' }, '尚未导入任何模型。')); return; }
    for (const r of reps) reportWrap.append(reportCard(r));
  }

  function pickFor(kind: ModelKind): void {
    const inp = h('input', { type: 'file', accept: '.stl,.ply' }) as HTMLInputElement;
    inp.addEventListener('change', () => { if (inp.files?.[0]) void handleFiles([inp.files[0]], kind); });
    inp.click();
  }

  async function handleFiles(files: File[], forceKind?: ModelKind): Promise<void> {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        let mesh = parseModelFile(buf, f.name);
        const kind = forceKind ?? guessKind(f.name);
        if (!kind) { toast(`无法从文件名判断类型，请用卡片上的“选择文件”：${f.name}`, 'err', 5000); continue; }
        const before = inspectTopology(mesh);
        const res = repairMesh(mesh);
        mesh = res.mesh;
        const health: ModelHealthRecord = {
          fileName: f.name, kind, importedAt: Date.now(),
          vertexCount: res.report.vertexCount, triangleCount: res.report.triangleCount,
          boundaryEdgeCount: before.boundaryEdgeCount, nonManifoldEdgeCount: before.nonManifoldEdgeCount,
          holeCount: before.holes.length, flippedTriCountEstimate: before.flippedTriCountEstimate,
          degenerateTriCount: before.degenerateTriCount,
          repaired: res.report.repaired, rejected: res.report.rejected,
        };
        if (res.report.rejected) {
          store.mutateCase(caseId, (cc) => { cc.models.reports = { ...(cc.models.reports ?? {}), [kind]: health }; }, true);
          toast(`已拒收「${KINDS.find((k) => k.kind === kind)?.label}」：${res.report.rejected}`, 'err', 7000);
        } else {
          store.setMesh(caseId, kind, meshToJSON(mesh));
          store.mutateCase(caseId, (cc) => { cc.models.reports = { ...(cc.models.reports ?? {}), [kind]: health }; }, true);
          toast(`「${f.name}」导入成功${res.report.repaired.length ? `，已自动修复 ${res.report.repaired.length} 项` : ''}`, 'ok');
        }
        drawSlots();
      } catch (e) {
        toast(`解析失败 ${f.name}：${(e as Error).message}`, 'err', 6000);
      }
    }
  }

  function removeKind(kind: ModelKind): void {
    store.mutateCase(caseId, (cc) => {
      const mm = cc.models as unknown as Record<string, unknown>;
      delete mm[kind];
      if (cc.models.reports) delete cc.models.reports[kind];
    }, true);
    store.invalidateMesh(caseId, kind);
    drawSlots();
  }

  function loadBuiltinAll(): void {
    const c = store.currentCase!;
    const side = c.side;
    const built: Record<ModelKind, ReturnType<typeof generateMandible>> = {
      mandible: generateMandible(),
      fibula: generateFibula(),
      tumor: generateTumor(defaultTumorCenter(side)),
      nerve: generateNerve(),
    };
    for (const k of KINDS) {
      const m = built[k.kind];
      const rep = inspectTopology(m);
      store.setMesh(caseId, k.kind, meshToJSON(m));
      const health: ModelHealthRecord = {
        fileName: `builtin-${k.kind}`, kind: k.kind, importedAt: Date.now(),
        vertexCount: rep.vertexCount, triangleCount: rep.triangleCount,
        boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, holeCount: 0,
        flippedTriCountEstimate: 0, degenerateTriCount: 0, repaired: [], rejected: null,
      };
      store.mutateCase(caseId, (cc) => { cc.models.reports = { ...(cc.models.reports ?? {}), [k.kind]: health }; }, false);
    }
    void store.saveCaseNow(caseId);
    toast('已装入全套程序化正常模型', 'ok');
    drawSlots();
  }

  function loadBrokenFibula(): void {
    const broken = generateBrokenFibula();
    const before = inspectTopology(broken.mesh);
    const res = repairMesh(broken.mesh);
    const health: ModelHealthRecord = {
      fileName: '测试_带破洞和翻转面的腓骨.stl', kind: 'fibula', importedAt: Date.now(),
      vertexCount: res.report.vertexCount, triangleCount: res.report.triangleCount,
      boundaryEdgeCount: before.boundaryEdgeCount, nonManifoldEdgeCount: before.nonManifoldEdgeCount,
      holeCount: before.holes.length, flippedTriCountEstimate: before.flippedTriCountEstimate,
      degenerateTriCount: before.degenerateTriCount,
      repaired: res.report.repaired, rejected: res.report.rejected, injectedDefects: broken.injected,
    };
    store.setMesh(caseId, 'fibula', meshToJSON(res.mesh));
    store.mutateCase(caseId, (cc) => { cc.models.reports = { ...(cc.models.reports ?? {}), fibula: health }; }, true);
    toast('问题腓骨已体检并自动修复入库，详见报告', 'ok');
    drawSlots();
  }

  drawSlots();
  const unsub = store.subscribe(() => drawSlots());
  return unsub;
}

function guessKind(name: string): ModelKind | null {
  const n = name.toLowerCase();
  if (/mandible|jaw|xiahe|下颌/.test(n)) return 'mandible';
  if (/fibula|feigu|腓骨/.test(n)) return 'fibula';
  if (/tumor|zhongliu|肿瘤/.test(n)) return 'tumor';
  if (/nerve|shenjing|ian|神经管/.test(n)) return 'nerve';
  return null;
}

function kindIcon(kind: string): HTMLElement {
  const map: Record<string, string> = { mandible: '🦴', fibula: '🦵', tumor: '🔴', nerve: '⚡' };
  const span = h('span', { style: 'font-size:26px' }, map[kind] ?? '📦');
  return span;
}

function reportCard(r: ModelHealthRecord): HTMLElement {
  const head = h('div', { class: 'spread' },
    h('div', {}, h('b', {}, KINDS.find((k) => k.kind === r.kind)?.label ?? String(r.kind)),
      h('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, r.fileName)),
    r.rejected ? badge('拒收', 'bad') : r.repaired.length ? badge('已自动修复', 'warn') : badge('合格', 'ok'),
  );
  const stats = h('div', { class: 'row mt8' },
    badge(`破洞边界边 ${r.boundaryEdgeCount}`, r.boundaryEdgeCount ? 'warn' : 'ok'),
    badge(`非流形边 ${r.nonManifoldEdgeCount}`, r.nonManifoldEdgeCount ? 'bad' : 'ok'),
    badge(`翻转面≈${r.flippedTriCountEstimate}`, r.flippedTriCountEstimate ? 'warn' : 'ok'),
    badge(`退化面 ${r.degenerateTriCount}`, r.degenerateTriCount ? 'warn' : 'ok'),
  );
  const defects = r.injectedDefects?.length
    ? h('div', { class: 'check-line mt8' }, h('span', { class: 'ico warn' }, '!'), h('div', {}, h('b', {}, '测试注入缺陷：'), h('span', { class: 'muted' }, r.injectedDefects.join('；'))))
    : null;
  const repairs = r.repaired.length
    ? h('ul', { style: 'margin:8px 0 0;padding-left:18px;font-size:13px;color:#8a5a00' }, ...r.repaired.map((x) => h('li', {}, '已修复：' + x)))
    : null;
  const reject = r.rejected
    ? h('div', { class: 'check-line mt8' }, h('span', { class: 'ico bad' }, '×'), h('div', {}, h('b', {}, '拒收原因：'), r.rejected))
    : null;
  return h('div', { class: 'panel', style: 'box-shadow:none' }, h('div', { class: 'panel-body' }, head, stats, defects, repairs, reject));
}
