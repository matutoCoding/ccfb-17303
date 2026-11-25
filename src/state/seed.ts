// 首次启动播种：左右侧下颌病例各一例，右侧掺入带破洞/翻转面的腓骨（走自动修复）。
import {
  generateMandible, generateTumor, generateNerve, generateFibula,
  generateBrokenFibula, archPoint, archTangent, defaultTumorCenter,
} from '../core/procedural';
import { meshToJSON } from '../core/mesh';
import { inspectTopology, repairMesh } from '../core/topology';
import { measureDefect, createInitialSegments, recomputeLayout } from '../core/fibulaPlan';
import {
  CaseRecord, PlanRecord, AppSettings, ModelHealthRecord, Side,
} from '../core/types';

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultPlanes(side: Side) {
  // 左侧肿瘤 phi≈-0.62，截骨弓参数包络；右侧镜像
  const phis = side === 'left' ? [-1.42, 0.16] : [-0.16, 1.42];
  return phis.map((phi, i) => ({
    id: uid('plane'),
    label: `下颌截骨平面 ${i + 1}`,
    point: archPoint(phi),
    normal: archTangent(phi),
  }));
}

export function createPlan(name: string, side: Side, settings: AppSettings): PlanRecord {
  const planes = defaultPlanes(side);
  const defect = measureDefect(planes);
  const segments = defect ? createInitialSegments(defect, undefined, settings.bladeThickness + settings.kerfClearance) : [];
  const layout = defect ? recomputeLayout(segments, defect) : null;
  const now = Date.now();
  return {
    id: uid('plan'),
    name,
    createdAt: now,
    updatedAt: now,
    planes,
    segments,
    gaps: layout?.gaps ?? [],
    brownClass: 'Brown Ⅱ类：单侧半下颌缺损（含升支；c=累及髁突）',
    pedicleDir: '朝向颈部（下行）',
    fibulaSide: side === 'left' ? 'right' : 'left',
    exports: [],
    screenshots: [],
  };
}

function healthFromMesh(fileName: string, kind: string, m: ReturnType<typeof generateMandible>): ModelHealthRecord {
  const r = inspectTopology(m);
  return {
    fileName, kind, importedAt: Date.now(),
    vertexCount: r.vertexCount, triangleCount: r.triangleCount,
    boundaryEdgeCount: r.boundaryEdgeCount, nonManifoldEdgeCount: r.nonManifoldEdgeCount,
    holeCount: r.holes.length, flippedTriCountEstimate: r.flippedTriCountEstimate,
    degenerateTriCount: r.degenerateTriCount, repaired: r.repaired, rejected: r.rejected,
  };
}

export function buildSeedCases(settings: AppSettings): CaseRecord[] {
  const cases: CaseRecord[] = [];

  (['left', 'right'] as Side[]).forEach((side) => {
    const mandible = generateMandible();
    const tumor = generateTumor(defaultTumorCenter(side), 17, side === 'left' ? 7 : 21);
    const nerve = generateNerve();
    const healthyFibula = generateFibula();

    // 右侧病例使用“问题腓骨”并自动修复，保留体检与修复标记
    let fibula = healthyFibula;
    let fibulaHealth: ModelHealthRecord;
    if (side === 'right') {
      const broken = generateBrokenFibula();
      const before = inspectTopology(broken.mesh);
      const repaired = repairMesh(broken.mesh);
      fibula = repaired.mesh;
      fibulaHealth = {
        ...healthFromMesh('问题腓骨_破洞翻转.stl', 'fibula', fibula),
        boundaryEdgeCount: before.boundaryEdgeCount,
        holeCount: before.holes.length,
        flippedTriCountEstimate: before.flippedTriCountEstimate,
        repaired: repaired.report.repaired,
        injectedDefects: broken.injected,
      };
    } else {
      fibulaHealth = healthFromMesh('fibula_left.ply', 'fibula', fibula);
    }

    const reports: Record<string, ModelHealthRecord> = {
      mandible: healthFromMesh('mandible.stl', 'mandible', mandible),
      tumor: healthFromMesh('tumor.stl', 'tumor', tumor),
      nerve: healthFromMesh('ian.stl', 'nerve', nerve),
      fibula: fibulaHealth,
    };

    const plan = createPlan('方案 A（默认）', side, settings);
    const now = Date.now() - (side === 'left' ? 1000 : 0);
    cases.push({
      id: uid('case'),
      name: side === 'left' ? '李某·左下颌骨成釉细胞瘤' : '王某·右下颌骨鳞状细胞癌',
      side,
      patientName: side === 'left' ? '李某' : '王某',
      patientId: side === 'left' ? 'P-2026-001' : 'P-2026-002',
      tumorStage: side === 'left' ? 'T4a（侵犯骨皮质）' : 'T3（>4cm）',
      brownClass: plan.brownClass,
      fibulaSide: plan.fibulaSide,
      pedicleDir: plan.pedicleDir,
      note: side === 'right' ? '含一根带破洞与翻转面的测试腓骨，已自动体检修复。' : '标准演示病例。',
      createdAt: now,
      updatedAt: now,
      models: {
        mandible: meshToJSON(mandible),
        tumor: meshToJSON(tumor),
        nerve: meshToJSON(nerve),
        fibula: meshToJSON(fibula),
        reports,
      },
      plans: [plan],
      activePlanId: plan.id,
    });
  });

  return cases;
}
