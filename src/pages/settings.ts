import { store } from '../state/store';
import { h, btn, field, numInput, toast } from '../ui/dom';
import { settingsFingerprint } from '../core/types';

export function renderSettingsPage(root: HTMLElement): () => void {
  const s = store.settings;
  const fp = settingsFingerprint(s);

  const blade = numInput(s.bladeThickness, 0.1, (v) => store.updateSettings({ bladeThickness: clamp(v, 0.2, 2) }), { min: 0.2, max: 2, unit: 'mm' });
  const clear = numInput(s.kerfClearance, 0.05, (v) => store.updateSettings({ kerfClearance: clamp(v, 0, 2) }), { min: 0, max: 2 });
  const pin = numInput(s.pinDiameter, 0.1, (v) => store.updateSettings({ pinDiameter: clamp(v, 1, 6) }), { min: 1, max: 6 });
  const wall = numInput(s.guideWallThickness, 0.1, (v) => store.updateSettings({ guideWallThickness: clamp(v, 1, 6) }), { min: 1, max: 6 });
  const margin = numInput(s.safetyMargin, 1, (v) => store.updateSettings({ safetyMargin: clamp(v, 2, 30) }), { min: 2, max: 30 });
  const precision = numInput(s.printerPrecision, 0.02, (v) => store.updateSettings({ printerPrecision: clamp(v, 0.02, 1) }), { min: 0.02, max: 1 });
  const band = numInput(s.plateBandWidth, 1, (v) => store.updateSettings({ plateBandWidth: clamp(v, 5, 25) }), { min: 5, max: 25 });

  const slotWidth = (s.bladeThickness + s.kerfClearance).toFixed(2);

  // 统计受指纹影响的已有导板
  let staleGuides = 0;
  for (const c of store.cases) for (const p of c.plans) {
    if (p.guideMandible && p.guideMandible.settingsFingerprint !== fp) staleGuides++;
    if (p.guideFibula && p.guideFibula.settingsFingerprint !== fp) staleGuides++;
  }

  const warn = staleGuides
    ? h('div', { class: 'check-line' },
      h('span', { class: 'ico warn' }, '!'),
      h('div', {}, h('b', {}, `有 ${staleGuides} 块已设计导板基于旧参数。`), '请前往“导板设计”页点击“按新设置重算”，否则导出校核可能使用旧槽宽/壁厚。'))
    : h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '✓'), h('div', {}, '所有已建设导板均使用当前设置。'));

  const resetBtn = btn('恢复默认', () => {
    void store.updateSettings({
      bladeThickness: 0.6, kerfClearance: 0.4, pinDiameter: 2.0,
      guideWallThickness: 2.5, safetyMargin: 10, printerPrecision: 0.1, plateBandWidth: 10,
    }).then(() => toast('已恢复默认设置', 'ok'));
  });

  root.append(
    h('div', { class: 'page-head' }, h('h2', {}, '设置'),
      h('span', { class: 'desc' }, '锯片、钉孔、壁厚、安全边界与打印机精度；更改后已有导板会提示重算'),
      h('div', { class: 'actions' }, resetBtn)),
    h('div', { style: 'max-width:760px' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '加工与打印参数')),
        h('div', { class: 'panel-body' },
          h('div', { class: 'field-row' },
            field('锯片厚度 mm', blade, '常用往复锯片 0.4–0.8mm'),
            field('锯槽总间隙 mm', clear, '槽宽 = 锯片厚度 + 总间隙'),
          ),
          h('div', { class: 'field-row' },
            field('实际锯槽宽度 mm', h('input', { class: 'input num', value: slotWidth, disabled: true }) as HTMLElement, '随上面两项自动计算'),
            field('固定钉孔直径 mm', pin),
          ),
          h('div', { class: 'field-row' },
            field('导板底板厚度/最小壁厚 mm', wall),
            field('贴骨带半宽 mm', band),
          ),
          h('div', { class: 'field-row' },
            field('肿瘤安全边界 mm', margin, '截骨平面距肿瘤不足该值标红'),
            field('打印机精度 mm', precision, '轮廓叠合偏差的合格阈值'),
          ),
        )),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '参数变更影响')), h('div', { class: 'panel-body' }, warn)),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, '精度验收口径')),
        h('div', { class: 'panel-body' },
          h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '1'), h('div', {}, '导出 STL 中反拟合的锯槽中心面与规划截骨平面：夹角 ≤ ', h('b', {}, '0.5°'), '，偏移 ≤ ', h('b', {}, '0.3mm'))),
          h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '2'), h('div', {}, '实时图像空间 CSG 预览与导出 STL 叠合，采样轮廓最大偏差 ≤ 打印机精度（当前 ', h('b', {}, `${s.printerPrecision}mm`), '）')),
          h('div', { class: 'check-line' }, h('span', { class: 'ico ok' }, '3'), h('div', {}, '导出前强制检查水密/流形、自交与最小壁厚，不合格不产出 STL')),
        )),
    ),
  );
  return () => {};
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
