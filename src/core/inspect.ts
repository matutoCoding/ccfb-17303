// 校核核心：从导出的 STL 网格反拟合锯槽壁平面，计算与规划平面的夹角/偏移；
// 锯片扫查神经管/对侧骨皮质；导出网格与 CSG 基准的轮廓偏差采样。
import { MeshData } from './mesh';
import { Vec3, v3, Plane, makePlane, planeBasis, planeAngleDeg, planeSignedDistance } from './vec';
import { CutPlaneSpec, VerificationRow, SweepHit } from './types';
import { BVH } from './bvh';
import { OBB } from './primitives';

export const ANGLE_LIMIT_DEG = 0.5;
export const OFFSET_LIMIT_MM = 0.3;

export interface FittedSlot {
  label: string;
  expectedPoint: Vec3;
  expectedNormal: Vec3;
  centerPoint: Vec3;
  centerNormal: Vec3;
  angleDeg: number;
  offsetMm: number;
  plusWallTris: number;
  minusWallTris: number;
  found: boolean;
}

/** Newell 法拟合一组三角形所在平面 */
function fitPlaneFromTris(m: MeshData, tris: number[]): { n: Vec3; p: Vec3 } | null {
  if (tris.length < 1) return null;
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0, cz = 0;
  let count = 0;
  const p = m.positions;
  for (const t of tris) {
    const i0 = m.indices[t * 3], i1 = m.indices[t * 3 + 1], i2 = m.indices[t * 3 + 2];
    const ax = p[i0 * 3], ay = p[i0 * 3 + 1], az = p[i0 * 3 + 2];
    const bx = p[i1 * 3], by = p[i1 * 3 + 1], bz = p[i1 * 3 + 2];
    const cx0 = p[i2 * 3], cy0 = p[i2 * 3 + 1], cz0 = p[i2 * 3 + 2];
    nx += (ay - by) * (az + bz) + (by - cy0) * (bz + cz0) + (cy0 - ay) * (cz0 + az);
    ny += (az - bz) * (ax + bx) + (bz - cz0) * (bx + cx0) + (cz0 - az) * (cx0 + ax);
    nz += (ax - bx) * (ay + by) + (bx - cx0) * (by + cy0) + (cx0 - ax) * (cy0 + ay);
    cx += ax + bx + cx0; cy += ay + by + cy0; cz += az + bz + cz0;
    count += 3;
  }
  const n = v3.norm([nx, ny, nz]);
  return { n, p: [cx / count, cy / count, cz / count] };
}

/**
 * 从导出的 STL 网格中识别每个规划锯槽的两面槽壁并拟合中心面。
 * 这是端到端精度验证：输入应当是 writeBinarySTL 再 parseSTL 回来的网格。
 */
export function inspectExportedSlots(
  stlMesh: MeshData,
  expected: CutPlaneSpec[],
  slotWidth: number,
): FittedSlot[] {
  const T = stlMesh.indices.length / 3;
  const triNormals: Vec3[] = new Array(T);
  const triCenters: Vec3[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const i0 = stlMesh.indices[t * 3], i1 = stlMesh.indices[t * 3 + 1], i2 = stlMesh.indices[t * 3 + 2];
    const p = stlMesh.positions;
    const a: Vec3 = [p[i0 * 3], p[i0 * 3 + 1], p[i0 * 3 + 2]];
    const b: Vec3 = [p[i1 * 3], p[i1 * 3 + 1], p[i1 * 3 + 2]];
    const c: Vec3 = [p[i2 * 3], p[i2 * 3 + 1], p[i2 * 3 + 2]];
    triNormals[t] = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    triCenters[t] = v3.scale(v3.add(v3.add(a, b), c), 1 / 3);
  }

  return expected.map((pl) => {
    const ePlane = makePlane(pl.point, pl.normal);
    const plus: number[] = [];
    const minus: number[] = [];
    for (let t = 0; t < T; t++) {
      const dotN = Math.abs(v3.dot(triNormals[t], ePlane.n));
      if (dotN < Math.cos((3 * Math.PI) / 180)) continue; // 法线偏差 >3° 不要
      const d = ePlane.n[0] * triCenters[t][0] + ePlane.n[1] * triCenters[t][1] + ePlane.n[2] * triCenters[t][2] + ePlane.d;
      if (Math.abs(Math.abs(d) - slotWidth / 2) < 0.8) {
        if (d > 0) plus.push(t);
        else minus.push(t);
      }
    }
    const fp = fitPlaneFromTris(stlMesh, plus);
    const fm = fitPlaneFromTris(stlMesh, minus);
    if (!fp || !fm) {
      return {
        label: pl.label, expectedPoint: pl.point, expectedNormal: pl.normal,
        centerPoint: pl.point, centerNormal: pl.normal, angleDeg: 999, offsetMm: 999,
        plusWallTris: plus.length, minusWallTris: minus.length, found: false,
      };
    }
    // 统一法线朝向期望方向
    if (v3.dot(fp.n, ePlane.n) < 0) fp.n = v3.scale(fp.n, -1);
    if (v3.dot(fm.n, ePlane.n) < 0) fm.n = v3.scale(fm.n, -1);
    const centerN = v3.norm(v3.add(fp.n, fm.n));
    const centerP = v3.scale(v3.add(fp.p, fm.p), 0.5);
    const centerPlane: Plane = { n: centerN, p: centerP, d: -v3.dot(centerN, centerP) };
    const angle = planeAngleDeg(centerPlane, ePlane);
    const offset = Math.abs(planeSignedDistance(ePlane, centerP));
    return {
      label: pl.label, expectedPoint: pl.point, expectedNormal: pl.normal,
      centerPoint: centerP, centerNormal: centerN, angleDeg: angle, offsetMm: offset,
      plusWallTris: plus.length, minusWallTris: minus.length, found: true,
    };
  });
}

export function slotsToVerificationRows(fitted: FittedSlot[]): VerificationRow[] {
  return fitted.map((f, i) => ({
    slotLabel: f.label,
    planLabel: f.label,
    angleDeg: f.angleDeg,
    offsetMm: f.offsetMm,
    anglePass: f.found && f.angleDeg <= ANGLE_LIMIT_DEG + 1e-6,
    offsetPass: f.found && f.offsetMm <= OFFSET_LIMIT_MM + 1e-6,
  }));
}

// ---------------- 锯片扫查 ----------------

export interface BladeSpec {
  thicknessMm: number;
  widthMm: number; // 锯片宽度方向
  reachMm: number; // 伸入长度方向
}

export function obbLocalPoint(obb: OBB, p: Vec3): Vec3 {
  const d = v3.sub(p, obb.center);
  return [v3.dot(d, obb.axes[0]), v3.dot(d, obb.axes[1]), v3.dot(d, obb.axes[2])];
}

function obbWorldAABB(obb: OBB) {
  const pts: Vec3[] = [];
  for (const su of [-1, 1]) for (const sv of [-1, 1]) for (const sn of [-1, 1]) {
    pts.push([
      obb.center[0] + obb.axes[0][0] * su * obb.half[0] + obb.axes[1][0] * sv * obb.half[1] + obb.axes[2][0] * sn * obb.half[2],
      obb.center[1] + obb.axes[0][1] * su * obb.half[0] + obb.axes[1][1] * sv * obb.half[1] + obb.axes[2][1] * sn * obb.half[2],
      obb.center[2] + obb.axes[0][2] * su * obb.half[0] + obb.axes[1][2] * sv * obb.half[1] + obb.axes[2][2] * sn * obb.half[2],
    ]);
  }
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) { min = v3.min(min, p); max = v3.max(max, p); }
  return { min, max };
}

/** 锯片扫查：thin OBB 与神经管/下颌骨求交，报告扫到的位置 */
export function analyzeBladeSweep(
  plane: CutPlaneSpec,
  mandible: MeshData | undefined,
  nerve: MeshData | undefined,
  blade: BladeSpec,
): SweepHit[] {
  const hits: SweepHit[] = [];
  const basis = planeBasis(plane.normal);
  // 锯片薄方向 = 平面法线；宽/伸入取平面内两轴，给足覆盖范围以检查整个截面
  const obb: OBB = {
    center: plane.point,
    axes: [basis.u, basis.v, basis.n],
    half: [blade.widthMm / 2 + 6, blade.reachMm / 2 + 14, blade.thicknessMm / 2 + 0.4],
  };
  const aabb = obbWorldAABB(obb);

  // 神经管
  if (nerve) {
    const bvh = new BVH(nerve);
    const cand = bvh.queryAABB(aabb);
    let best: { p: Vec3; d: number } | null = null;
    for (const t of cand) {
      const i0 = nerve.indices[t * 3];
      const pt: Vec3 = [nerve.positions[i0 * 3], nerve.positions[i0 * 3 + 1], nerve.positions[i0 * 3 + 2]];
      const l = obbLocalPoint(obb, pt);
      // 神经管半径 ~1.7，留 1mm 安全裕量
      if (Math.abs(l[0]) < obb.half[0] + 2.5 && Math.abs(l[1]) < obb.half[1] + 2.5 && Math.abs(l[2]) < obb.half[2] + 2.5) {
        const d = v3.dist(plane.point, pt);
        if (!best || d < best.d) best = { p: pt, d };
      }
    }
    if (best) {
      hits.push({
        planeLabel: plane.label,
        target: '下牙槽神经管',
        hitPoint: best.p,
        depthMm: best.d,
        message: `锯片在 ${best.p.map((x) => x.toFixed(1)).join(', ')} mm 处扫到下牙槽神经管（距平面锚点 ${best.d.toFixed(1)}mm），建议调整平面角度或减小伸入深度`,
      });
    }
  }

  // 对侧/舌侧骨皮质：查 OBB 内的下颌骨三角形，按局部 v 轴两侧聚类
  if (mandible) {
    const bvh = new BVH(mandible);
    const cand = bvh.queryAABB(aabb);
    let farPoint: Vec3 | null = null;
    let farLocalV = -Infinity;
    let crossMidline = false;
    for (const t of cand) {
      const i0 = mandible.indices[t * 3], i1 = mandible.indices[t * 3 + 1], i2 = mandible.indices[t * 3 + 2];
      const c: Vec3 = [
        (mandible.positions[i0 * 3] + mandible.positions[i1 * 3] + mandible.positions[i2 * 3]) / 3,
        (mandible.positions[i0 * 3 + 1] + mandible.positions[i1 * 3 + 1] + mandible.positions[i2 * 3 + 1]) / 3,
        (mandible.positions[i0 * 3 + 2] + mandible.positions[i1 * 3 + 2] + mandible.positions[i2 * 3 + 2]) / 3,
      ];
      const l = obbLocalPoint(obb, c);
      if (Math.abs(l[0]) < obb.half[0] && Math.abs(l[1]) < obb.half[1] && Math.abs(l[2]) < obb.half[2] + 1.5) {
        // 远离平面中心的一侧骨皮质
        if (Math.abs(l[1]) > farLocalV) { farLocalV = Math.abs(l[1]); farPoint = c; }
        if (Math.sign(c[0]) !== Math.sign(plane.point[0]) && Math.abs(c[0]) > 4) crossMidline = true;
      }
    }
    if (farPoint && farLocalV > 12) {
      hits.push({
        planeLabel: plane.label,
        target: crossMidline ? '对侧骨皮质' : '舌侧/远侧骨皮质',
        hitPoint: farPoint,
        depthMm: farLocalV,
        message: crossMidline
          ? `锯片延伸越过中线，在 ${farPoint.map((x) => x.toFixed(1)).join(', ')} mm 处触及对侧骨皮质，注意勿过切`
          : `锯片可切透至 ${farPoint.map((x) => x.toFixed(1)).join(', ')} mm 处的舌侧/远侧骨皮质（伸入 ${farLocalV.toFixed(1)}mm），这是离断所需边界，注意控制过冲`,
      });
    }
  }
  return hits;
}

// ---------------- 轮廓偏差 ----------------

export interface ContourCompareResult {
  maxDevMm: number;
  rmsDevMm: number;
  p95DevMm: number;
  sampled: number;
  pass: boolean;
  limitMm: number;
}

/** 采样 exported 表面点到 reference 网格的距离（导出 STL vs CSG 基准/实时预览基准） */
export function compareMeshContours(
  exported: MeshData,
  reference: MeshData,
  limitMm: number,
  sampleCount = 3000,
): ContourCompareResult {
  const bvh = new BVH(reference);
  const T = exported.indices.length / 3;
  // 面积加权采样
  let seed = 98765;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
  const areas: number[] = [];
  let total = 0;
  const p = exported.positions;
  for (let t = 0; t < T; t++) {
    const i0 = exported.indices[t * 3], i1 = exported.indices[t * 3 + 1], i2 = exported.indices[t * 3 + 2];
    const ax = p[i0 * 3], ay = p[i0 * 3 + 1], az = p[i0 * 3 + 2];
    const e1x = p[i1 * 3] - ax, e1y = p[i1 * 3 + 1] - ay, e1z = p[i1 * 3 + 2] - az;
    const e2x = p[i2 * 3] - ax, e2y = p[i2 * 3 + 1] - ay, e2z = p[i2 * 3 + 2] - az;
    const a = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) / 2;
    areas.push(a); total += a;
  }
  const devs: number[] = [];
  for (let s = 0; s < sampleCount; s++) {
    let r = rnd() * total;
    let t = 0;
    while (t < T - 1 && r > areas[t]) { r -= areas[t]; t++; }
    const i0 = exported.indices[t * 3], i1 = exported.indices[t * 3 + 1], i2 = exported.indices[t * 3 + 2];
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    const pt: Vec3 = [
      p[i0 * 3] * w + p[i1 * 3] * u + p[i2 * 3] * v,
      p[i0 * 3 + 1] * w + p[i1 * 3 + 1] * u + p[i2 * 3 + 1] * v,
      p[i0 * 3 + 2] * w + p[i1 * 3 + 2] * u + p[i2 * 3 + 2] * v,
    ];
    devs.push(bvh.closestPoint(pt).distance);
  }
  devs.sort((a, b) => a - b);
  const rms = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
  const p95 = devs[Math.floor(devs.length * 0.95)];
  const max = devs[devs.length - 1];
  // 轮廓偏差以 P95 为统计主指标（避免个别离群点），max 用 3 倍精度兜底
  return { maxDevMm: max, rmsDevMm: rms, p95DevMm: p95, sampled: devs.length, pass: p95 <= limitMm && max <= limitMm * 3, limitMm };
}
