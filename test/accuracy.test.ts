import { describe, it, expect } from 'vitest';
import {
  generateMandible, generateTumor, generateNerve, generateFibula,
  generateBrokenFibula, archPoint, archTangent,
} from '../src/core/procedural';
import { repairMesh, inspectTopology } from '../src/core/topology';
import { measureDefect, createInitialSegments, recomputeLayout, buildFibulaCutPlanes } from '../src/core/fibulaPlan';
import { buildGuide } from '../src/core/guide';
import { exportGuideSTL } from '../src/core/exportGuide';
import { inspectExportedSlots, ANGLE_LIMIT_DEG, OFFSET_LIMIT_MM } from '../src/core/inspect';
import { slotWidth, DEFAULT_SETTINGS, CutPlaneSpec } from '../src/core/types';
import { computeVertexNormals } from '../src/core/mesh';

function defaultPlanesLeft(): CutPlaneSpec[] {
  const phis = [-1.42, 0.16];
  return phis.map((phi, i) => ({
    id: `mp-${i}`,
    label: `下颌截骨平面 ${i + 1}`,
    point: archPoint(phi),
    normal: archTangent(phi),
  }));
}

describe('程序化模型与拓扑修复', () => {
  it('生成左右下颌/肿瘤/神经/腓骨', () => {
    const man = generateMandible();
    expect(man.positions.length).toBeGreaterThan(1000);
    expect(man.indices.length / 3).toBeGreaterThan(500);
    expect(generateTumor().positions.length).toBeGreaterThan(100);
    expect(generateNerve().indices.length).toBeGreaterThan(100);
    expect(generateFibula().positions.length).toBeGreaterThan(1000);
  });

  it('带破洞和翻转面的腓骨可被修复为水密流形', () => {
    const { mesh: broken, injected } = generateBrokenFibula();
    expect(injected.length).toBe(2);
    const before = inspectTopology(broken);
    expect(before.boundaryEdgeCount).toBeGreaterThan(0);
    expect(before.flippedTriCountEstimate).toBeGreaterThan(5);
    const { mesh: repaired, report } = repairMesh(broken);
    expect(report.rejected).toBeNull();
    const after = inspectTopology(repaired);
    expect(after.boundaryEdgeCount).toBe(0);
    expect(after.nonManifoldEdgeCount).toBe(0);
  });
});

describe('腓骨排布', () => {
  it('缺损测量与分段满足 ≥20mm 约束', () => {
    const planes = defaultPlanesLeft();
    const defect = measureDefect(planes)!;
    expect(defect.lengthMm).toBeGreaterThan(40);
    const segs = createInitialSegments(defect);
    const layout = recomputeLayout(segs, defect);
    expect(layout.minSegmentOk).toBe(true);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (const s of segs) expect(s.lengthMm).toBeGreaterThanOrEqual(19.999);
    const fp = buildFibulaCutPlanes(segs, layout);
    expect(fp.length).toBe(segs.length + 1);
  });
});

describe('导板导出精度（最关键）', () => {
  it('导出 STL 的锯槽中心面与规划平面夹角≤0.5°、偏移≤0.3mm', async () => {
    const mandible = generateMandible();
    computeVertexNormals(mandible);
    const planes = defaultPlanesLeft();
    const w = slotWidth(DEFAULT_SETTINGS);
    const guide = buildGuide(mandible, {
      planes,
      seatDir: [0, 1, 0],
      thickness: DEFAULT_SETTINGS.guideWallThickness,
      slotWidth: w,
      pinDiameter: DEFAULT_SETTINGS.pinDiameter,
      autoRelieve: false,
      bandWidth: DEFAULT_SETTINGS.plateBandWidth,
    });
    expect(guide.plate.indices.length).toBeGreaterThan(100);
    const outcome = await exportGuideSTL(guide, planes, w, DEFAULT_SETTINGS.guideWallThickness, { allowUnsafe: true });
    if (!outcome.ok) {
      console.log('EXPORT FAIL', outcome.error, outcome.logs);
    }
    expect(outcome.ok).toBe(true);
    console.log('VALIDATION', JSON.stringify({
      wt: outcome.validation?.watertight, mf: outcome.validation?.manifold,
      be: outcome.validation?.boundaryEdges, nm: outcome.validation?.nonManifoldEdges,
      si: outcome.validation?.selfIntersectionCount, p5: outcome.validation?.wallP5Mm?.toFixed(2),
      min: outcome.validation?.minWallMm?.toFixed(2), pass: outcome.validation?.passed,
      blockers: outcome.validation?.blockers,
    }));
    const fitted = inspectExportedSlots(outcome.stlMesh!, planes, w);
    for (const f of fitted) {
      console.log(f.label, 'found=', f.found, 'angle=', f.angleDeg.toFixed(5), 'offset=', f.offsetMm.toFixed(5), 'walls=', f.plusWallTris, f.minusWallTris);
      expect(f.found).toBe(true);
      expect(f.angleDeg).toBeLessThan(ANGLE_LIMIT_DEG);
      expect(f.offsetMm).toBeLessThan(OFFSET_LIMIT_MM);
    }
  }, 60000);
});
