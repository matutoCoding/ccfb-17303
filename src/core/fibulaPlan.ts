// 腓骨瓣排布数学：缺损弧长、自动分段、两头楔形角、手动拖拽后的链式重解、
// 段间接缝间隙着色、以及下颌角/颏部轮廓偏差。全部纯函数，可在 Node 测试。
import { Vec3, v3, deg, clamp } from './vec';
import { archPoint, ARCH, FIBULA_LENGTH, DISTAL_RESERVE_MM } from './procedural';
import { CutPlaneSpec, FibulaSegmentSpec, JointGap } from './types';
import { q, Quat } from './quat';

export const MIN_SEGMENT_MM = 20;

export interface DefectInfo {
  phiA: number;
  phiB: number;
  lengthMm: number;
  contour: Vec3[];
}

/** 找到平面最近的弓参数 phi */
export function planeToPhi(plane: CutPlaneSpec): number {
  let best = 0;
  let bestD = Infinity;
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const phi = -ARCH.phiMax + (2 * ARCH.phiMax * i) / N;
    const d = v3.dist2(archPoint(phi), plane.point);
    if (d < bestD) { bestD = d; best = phi; }
  }
  return best;
}

/** 沿弓曲线的弧长采样 */
export function sampleArchArc(phiA: number, phiB: number, count: number): Vec3[] {
  // 先加密采样做弧长表
  const DENSE = 600;
  const pts: Vec3[] = [];
  const cum: number[] = [0];
  let prev: Vec3 | null = null;
  for (let i = 0; i <= DENSE; i++) {
    const phi = phiA + ((phiB - phiA) * i) / DENSE;
    const p = archPoint(phi);
    pts.push(p);
    if (prev) cum.push(cum[cum.length - 1] + v3.dist(prev, p));
    prev = p;
  }
  const total = cum[cum.length - 1];
  const out: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const t = (target - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    out.push(v3.lerp(pts[i - 1], pts[i], clamp(t, 0, 1)));
  }
  return out;
}

export function measureDefect(planes: CutPlaneSpec[]): DefectInfo | null {
  if (planes.length < 2) return null;
  const phis = planes.map(planeToPhi).sort((a, b) => a - b);
  const phiA = phis[0];
  const phiB = phis[phis.length - 1];
  if (phiB - phiA < 0.05) return null;
  const contour = sampleArchArc(phiA, phiB, 120);
  let length = 0;
  for (let i = 1; i < contour.length; i++) length += v3.dist(contour[i - 1], contour[i]);
  return { phiA, phiB, lengthMm: length, contour };
}

/** 自动决定段数：目标段长 ~28mm，且每段必须 ≥20mm */
export function autoSegmentCount(defectLengthMm: number): number {
  const byTarget = Math.round(defectLengthMm / 28);
  const byMin = Math.max(1, Math.floor(defectLengthMm / MIN_SEGMENT_MM));
  return clamp(Math.min(byTarget, byMin), 1, 4);
}

let idCounter = 0;
export function newSegId(): string {
  idCounter += 1;
  return `seg-${Date.now().toString(36)}-${idCounter}`;
}

/** 依据缺损生成初始分段（弦连接），并分配供体腓骨位置（远端留 6cm） */
export function createInitialSegments(defect: DefectInfo, count?: number, kerfMm = 1.0): FibulaSegmentSpec[] {
  const n = count ?? autoSegmentCount(defect.lengthMm);
  const joints = sampleArchArc(defect.phiA, defect.phiB, n + 1);
  const segs: FibulaSegmentSpec[] = [];

  // 供体分配：从远端安全上限向近端排
  const tDistMax = 1 - DISTAL_RESERVE_MM / FIBULA_LENGTH;
  let cursorX = -FIBULA_LENGTH / 2 + tDistMax * FIBULA_LENGTH; // 最远端可用 x
  for (let i = 0; i < n; i++) {
    const a = joints[i], b = joints[i + 1];
    const axis = v3.norm(v3.sub(b, a));
    const center = v3.scale(v3.add(a, b), 0.5);
    const len = v3.dist(a, b);
    const t1 = (cursorX + FIBULA_LENGTH / 2) / FIBULA_LENGTH;
    const t0 = (cursorX - len + FIBULA_LENGTH / 2) / FIBULA_LENGTH;
    cursorX -= len + kerfMm;
    segs.push({
      id: newSegId(),
      index: i,
      lengthMm: len,
      wedgeProxDeg: 0,
      wedgeDistDeg: 0,
      baseCenter: center,
      baseAxis: axis,
      adjust: { offset: [0, 0, 0], quat: q.identity() },
      donorT0: t0,
      donorT1: t1,
    });
  }
  // 计算初始楔形角
  applyWedgeAngles(segs);
  return segs;
}

function currentCenter(s: FibulaSegmentSpec): Vec3 {
  return v3.add(s.baseCenter, s.adjust.offset);
}
function currentAxis(s: FibulaSegmentSpec): Vec3 {
  return v3.norm(q.rotateVec(s.adjust.quat, s.baseAxis));
}

function applyWedgeAngles(segs: FibulaSegmentSpec[]): void {
  for (let i = 0; i < segs.length; i++) {
    const axis = currentAxis(segs[i]);
    if (i === 0) segs[i].wedgeProxDeg = 0;
    if (i === segs.length - 1) segs[i].wedgeDistDeg = 0;
    if (i > 0) {
      const prevAxis = currentAxis(segs[i - 1]);
      const bend = deg(Math.acos(clamp(v3.dot(prevAxis, axis), -1, 1)));
      segs[i].wedgeProxDeg = bend / 2;
      segs[i - 1].wedgeDistDeg = bend / 2;
    }
  }
}

export interface LayoutMetrics {
  chinDevMm: number;
  leftAngleDevMm: number;
  rightAngleDevMm: number;
  rmsMm: number;
  maxDevMm: number;
}

export interface LayoutResult {
  centers: Vec3[];
  axes: Vec3[];
  proxEnds: Vec3[];
  distEnds: Vec3[];
  joints: Vec3[];
  gaps: JointGap[];
  metrics: LayoutMetrics;
  minSegmentOk: boolean;
  distalReserveOk: boolean;
  proximalReserveOk: boolean;
  donorUsedMm: number;
}

function gapColor(g: number): Vec3 {
  // 0 绿 -> 1.2mm 黄 -> 2.5mm+ 红
  const t = clamp(g / 2.5, 0, 1);
  if (t < 0.5) {
    const k = t / 0.5;
    return [0.2 + (0.95 - 0.2) * k, 0.85 - 0.05 * k, 0.35 - 0.25 * k];
  }
  const k = (t - 0.5) / 0.5;
  return [0.95, 0.8 - 0.55 * k, 0.1 + 0.05 * k];
}

/**
 * 根据各段 adjust 重解排布。
 * fixedId：正在拖拽的段，其位姿固定；其余段做“中点桥接”松弛，
 * 自动改变朝向 -> 楔形角随之重算。
 */
export function recomputeLayout(
  segs: FibulaSegmentSpec[],
  defect: DefectInfo | null,
  fixedId?: string | null,
): LayoutResult {
  const n = segs.length;
  const centers = segs.map(currentCenter);
  const axes = segs.map(currentAxis);
  const lengths = segs.map((s) => s.lengthMm);

  // 松弛：由当前端点求关节中点，再让非固定段重新对准相邻关节
  if (fixedId) {
    const fixedIndex = segs.findIndex((s) => s.id === fixedId);
    for (let iter = 0; iter < 8; iter++) {
      const prox: Vec3[] = [], dist: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        prox.push(v3.mulAdd(centers[i], axes[i], -lengths[i] / 2));
        dist.push(v3.mulAdd(centers[i], axes[i], lengths[i] / 2));
      }
      const joints: Vec3[] = [prox[0]];
      for (let j = 1; j < n; j++) joints.push(v3.scale(v3.add(dist[j - 1], prox[j]), 0.5));
      joints.push(dist[n - 1]);
      for (let i = 0; i < n; i++) {
        if (i === fixedIndex) continue;
        const a = joints[i], b = joints[i + 1];
        const len = v3.dist(a, b);
        if (len > 1e-6) {
          axes[i] = v3.norm(v3.sub(b, a));
          centers[i] = v3.scale(v3.add(a, b), 0.5);
        }
      }
    }
    // 写回 adjust
    for (let i = 0; i < n; i++) {
      segs[i].adjust.offset = v3.sub(centers[i], segs[i].baseCenter);
      segs[i].adjust.quat = q.fromVectors(segs[i].baseAxis, axes[i]);
    }
  }

  // 最终端点 / 关节
  const proxEnds: Vec3[] = [];
  const distEnds: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    proxEnds.push(v3.mulAdd(centers[i], axes[i], -lengths[i] / 2));
    distEnds.push(v3.mulAdd(centers[i], axes[i], lengths[i] / 2));
  }
  const joints: Vec3[] = [proxEnds[0]];
  for (let j = 1; j < n; j++) joints.push(v3.scale(v3.add(distEnds[j - 1], proxEnds[j]), 0.5));
  joints.push(distEnds[n - 1]);

  applyWedgeAngles(segs);

  // 间隙
  const gaps: JointGap[] = [];
  for (let j = 1; j < n; j++) {
    const eA = distEnds[j - 1];
    const eB = proxEnds[j];
    const aA = axes[j - 1], aB = axes[j];
    const normal = v3.norm(v3.add(aA, aB));
    const delta = v3.sub(eB, eA);
    const axial = v3.dot(delta, normal);
    const axialVec = v3.scale(normal, axial);
    const lateral = v3.len(v3.sub(delta, axialVec));
    const g = Math.abs(axial);
    const discCenter = v3.scale(v3.add(eA, eB), 0.5);
    const radius = 6.5;
    const basis = planeBasisLocal(normal);
    const samples: { p: Vec3; gap: number }[] = [{ p: discCenter, gap: g }];
    for (const rr of [0.55, 1]) {
      for (let k = 0; k < 20; k++) {
        const ang = (k / 20) * Math.PI * 2;
        const p = v3.add(
          discCenter,
          v3.add(v3.scale(basis.u, Math.cos(ang) * radius * rr), v3.scale(basis.v, Math.sin(ang) * radius * rr)),
        );
        samples.push({ p, gap: g });
      }
    }
    gaps.push({
      jointIndex: j - 1,
      position: discCenter,
      maxGapMm: g,
      meanGapMm: g,
      lateralMm: lateral,
      color: gapColor(g),
      discCenter,
      discNormal: normal,
      discRadius: radius,
      samples,
    });
  }

  const metrics = computeDeviations(segs, defect, centers, axes);

  const minSegmentOk = segs.every((s) => s.lengthMm + 1e-6 >= MIN_SEGMENT_MM);
  const tDistMax = 1 - DISTAL_RESERVE_MM / FIBULA_LENGTH;
  const distalReserveOk = segs.every((s) => s.donorT1 <= tDistMax + 1e-6);
  const proximalReserveOk = segs.every((s) => s.donorT0 * FIBULA_LENGTH - FIBULA_LENGTH / 2 >= -FIBULA_LENGTH / 2 + 18);
  const donorUsedMm = segs.reduce((acc, s) => acc + s.lengthMm, 0);

  return {
    centers, axes, proxEnds, distEnds, joints, gaps, metrics,
    minSegmentOk, distalReserveOk, proximalReserveOk, donorUsedMm,
  };
}

function planeBasisLocal(n: Vec3): { u: Vec3; v: Vec3 } {
  const ref = Math.abs(n[1]) < 0.9 ? ([0, 1, 0] as Vec3) : ([1, 0, 0] as Vec3);
  const u = v3.norm(v3.cross(ref, n));
  const v = v3.cross(n, u);
  return { u, v };
}

/** 三个标志点（颏部、左右下颌角）与原始弓轮廓的偏差 + 缺陷区内轮廓拟合误差 */
function computeDeviations(
  segs: FibulaSegmentSpec[],
  defect: DefectInfo | null,
  centers: Vec3[],
  axes: Vec3[],
): LayoutMetrics {
  // 重建折线（含端点）
  const chain: Vec3[] = [];
  if (segs.length) {
    chain.push(v3.mulAdd(centers[0], axes[0], -segs[0].lengthMm / 2));
    for (let i = 0; i < segs.length; i++) {
      chain.push(v3.mulAdd(centers[i], axes[i], segs[i].lengthMm / 2));
    }
  }
  const distToChain = (p: Vec3): number => {
    let best = Infinity;
    for (let i = 0; i < chain.length - 1; i++) best = Math.min(best, pointSegDist(p, chain[i], chain[i + 1]));
    return best === Infinity ? 0 : best;
  };

  // 标志点：phi=0 颏部；phi=±(phiMax-0.12) 下颌角
  const chinOriginal = archPoint(0);
  const angleL = archPoint(-(ARCH.phiMax - 0.12));
  const angleR = archPoint(ARCH.phiMax - 0.12);

  // 若标志点落在缺陷区间内，用“同弧分数对应点”的直接位移；否则距离链仅在链靠近时计入
  let chinDev = 0, leftDev = 0, rightDev = 0;
  if (defect) {
    const inDefect = (phi: number) => phi >= defect.phiA && phi <= defect.phiB;
    const corresponding = (phi: number): number => {
      const frac = (phi - defect.phiA) / (defect.phiB - defect.phiA);
      const idx = clamp(Math.round(frac * (defect.contour.length - 1)), 0, defect.contour.length - 1);
      const original = archPoint(phi);
      // 链上按段数线性取点
      const cf = clamp(frac, 0, 1) * (chain.length - 1);
      const ci = Math.floor(cf);
      const ct = cf - ci;
      const recon = chain.length >= 2
        ? v3.lerp(chain[Math.min(ci, chain.length - 1)], chain[Math.min(ci + 1, chain.length - 1)], ct)
        : chain[0];
      return v3.dist(original, recon);
    };
    chinDev = inDefect(0) ? corresponding(0) : 0;
    leftDev = inDefect(-(ARCH.phiMax - 0.12)) ? corresponding(-(ARCH.phiMax - 0.12)) : 0;
    rightDev = inDefect(ARCH.phiMax - 0.12) ? corresponding(ARCH.phiMax - 0.12) : 0;

    // 缺陷区轮廓拟合 RMS / max：原始弓采样点到重建链距离
    let sum2 = 0, maxD = 0, cnt = 0;
    for (const p of defect.contour) {
      const d = distToChain(p);
      sum2 += d * d; maxD = Math.max(maxD, d); cnt++;
    }
    return {
      chinDevMm: chinDev,
      leftAngleDevMm: leftDev,
      rightAngleDevMm: rightDev,
      rmsMm: Math.sqrt(sum2 / Math.max(1, cnt)),
      maxDevMm: maxD,
    };
  }
  return { chinDevMm: chinDev, leftAngleDevMm: leftDev, rightAngleDevMm: rightDev, rmsMm: 0, maxDevMm: 0 };
}

function pointSegDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = v3.sub(b, a);
  const t = clamp(v3.dot(v3.sub(p, a), ab) / Math.max(1e-9, v3.dot(ab, ab)), 0, 1);
  return v3.dist(p, v3.add(a, v3.scale(ab, t)));
}

/** 供体腓骨局部坐标系（沿 X 轴）上的截骨平面，供腓骨导板与校核使用。
 *  取每段供体区间的两端，并按该段楔形角倾斜法线。 */
export function fibulaDonorPlanes(segs: FibulaSegmentSpec[]): CutPlaneSpec[] {
  const planes: CutPlaneSpec[] = [];
  segs.forEach((s, i) => {
    const x0 = -FIBULA_LENGTH / 2 + s.donorT0 * FIBULA_LENGTH;
    const x1 = -FIBULA_LENGTH / 2 + s.donorT1 * FIBULA_LENGTH;
    const wedgeP = ((s.wedgeProxDeg || 0) * Math.PI) / 180;
    const wedgeD = ((s.wedgeDistDeg || 0) * Math.PI) / 180;
    planes.push({
      id: `fdonor-${i}-p`, label: `腓骨段 ${i + 1} 近端槽`,
      point: [x0, 0, 0],
      normal: [Math.cos(wedgeP), Math.sin(wedgeP), 0],
    });
    planes.push({
      id: `fdonor-${i}-d`, label: `腓骨段 ${i + 1} 远端槽`,
      point: [x1, 0, 0],
      normal: [Math.cos(wedgeD), -Math.sin(wedgeD), 0],
    });
  });
  return planes;
}

/** 由当前排布结果生成全部腓骨截骨平面（n+1 个），与导板锯槽一一对应 */
export function buildFibulaCutPlanes(segs: FibulaSegmentSpec[], layout: LayoutResult): CutPlaneSpec[] {
  const planes: CutPlaneSpec[] = [];
  const n = segs.length;
  for (let j = 0; j <= n; j++) {
    let normal: Vec3;
    if (j === 0) normal = layout.axes[0];
    else if (j === n) normal = layout.axes[n - 1];
    else normal = v3.norm(v3.add(layout.axes[j - 1], layout.axes[j]));
    planes.push({
      id: `fib-plane-${j}`,
      label: `腓骨锯槽 ${j + 1}/${n + 1}`,
      point: layout.joints[j],
      normal,
      segId: j < n ? segs[j].id : segs[n - 1].id,
      end: j === 0 ? 'prox' : j === n ? 'dist' : undefined,
    });
  }
  return planes;
}
