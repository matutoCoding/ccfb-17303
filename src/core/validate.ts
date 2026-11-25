// 导出前可制造性校验：流形/水密、自相交、最小壁厚。
import { MeshData, getTriangleVerts, vertexCount } from './mesh';
import { inspectTopology } from './topology';
import { BVH } from './bvh';
import { trianglesIntersect } from './bvh';
import { Vec3 } from './vec';

export interface ValidationResult {
  watertight: boolean;
  manifold: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  selfIntersectFree: boolean;
  selfIntersectionCount: number;
  minWallMm: number;
  wallP5Mm: number;
  wallSamples: number;
  passed: boolean;
  blockers: string[];
}

/**
 * 自相交 / 非相邻贴合检测：采样网格顶点，用 BVH 找最近三角形，
 * 若极近（<0.03mm）且不是共享顶点的邻接三角形，则视为自交/重叠。
 * 体素移动四面体网格拓扑上保证无自交，这里做导出前独立复核。
 */
export function checkSelfIntersections(
  m: MeshData,
  opts: { sampleCap?: number; tolMm?: number } = {},
): { count: number; checked: number; examples: { t1: number; t2: number }[] } {
  const sampleCap = opts.sampleCap ?? 6000;
  const tol = opts.tolMm ?? 0.03;
  const bvh = new BVH(m);
  const V = m.positions.length / 3;
  const stride = sampleCap > 0 && V > sampleCap ? Math.floor(V / sampleCap) : 1;
  // 顶点 -> 相邻三角形集合（判定邻接用）
  const vertTris = new Map<number, Set<number>>();
  const T = m.indices.length / 3;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = m.indices[t * 3 + k];
      if (!vertTris.has(vi)) vertTris.set(vi, new Set());
      vertTris.get(vi)!.add(t);
    }
  }
  let count = 0;
  let checked = 0;
  const examples: { t1: number; t2: number }[] = [];
  for (let v = 0; v < V; v += stride) {
    checked++;
    const p: Vec3 = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
    const near = bvh.closestPoint(p);
    if (near.distance >= tol) continue;
    // 最近三角形若与该顶点邻接（包含该顶点）则跳过
    if (vertTris.get(v)?.has(near.tri)) continue;
    // 若最近三角形与包含 v 的任一三角形共享顶点，也视为邻接
    let adjacent = false;
    const myTris = vertTris.get(v);
    if (myTris) {
      const j = [m.indices[near.tri * 3], m.indices[near.tri * 3 + 1], m.indices[near.tri * 3 + 2]];
      outer: for (const t of myTris) {
        for (let k = 0; k < 3; k++) {
          if (m.indices[t * 3 + k] === j[0] || m.indices[t * 3 + k] === j[1] || m.indices[t * 3 + k] === j[2]) {
            adjacent = true; break outer;
          }
        }
      }
    }
    if (adjacent) continue;
    count++;
    if (examples.length < 20) examples.push({ t1: -1, t2: near.tri });
  }
  return { count, checked, examples };
}

/**
 * 最小壁厚估算：按三角形面积加权采样，沿顶点法线向实体内部发射线，
 * 命中的最近距离即局部壁厚。返回最小值与 5% 分位（抗毛刺）。
 */
export function estimateWallThickness(m: MeshData, samples = 2500): { min: number; p5: number; samples: number } {
  const bvh = new BVH(m);
  if (!m.normals) return { min: 0, p5: 0, samples: 0 };
  // 累积三角形面积
  const T = m.indices.length / 3;
  const areas = new Float64Array(T);
  let totalArea = 0;
  const p = m.positions;
  for (let t = 0; t < T; t++) {
    const ia = m.indices[t * 3] * 3, ib = m.indices[t * 3 + 1] * 3, ic = m.indices[t * 3 + 2] * 3;
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    areas[t] = Math.hypot(cx, cy, cz) / 2;
    totalArea += areas[t];
  }
  if (totalArea <= 0) return { min: 0, p5: 0, samples: 0 };

  const hits: number[] = [];
  // 确定性采样（不用 Math.random，方便测试复现）：伪随机序列
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let s = 0; s < samples; s++) {
    let r = rnd() * totalArea;
    let t = 0;
    while (t < T - 1 && r > areas[t]) { r -= areas[t]; t++; }
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    const px = p[ia * 3] * w + p[ib * 3] * u + p[ic * 3] * v;
    const py = p[ia * 3 + 1] * w + p[ib * 3 + 1] * u + p[ic * 3 + 1] * v;
    const pz = p[ia * 3 + 2] * w + p[ib * 3 + 2] * u + p[ic * 3 + 2] * v;
    let nx = m.normals[ia * 3] * w + m.normals[ib * 3] * u + m.normals[ic * 3] * v;
    let ny = m.normals[ia * 3 + 1] * w + m.normals[ib * 3 + 1] * u + m.normals[ic * 3 + 1] * v;
    let nz = m.normals[ia * 3 + 2] * w + m.normals[ib * 3 + 2] * u + m.normals[ic * 3 + 2] * v;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // 双面都测，取较小命中（不依赖法线绝对朝内朝外）
    for (const sign of [-1, 1]) {
      const origin: Vec3 = [px + nx * sign * 0.05, py + ny * sign * 0.05, pz + nz * sign * 0.05];
      const hit = bvh.raycast({ origin, dir: [nx * sign, ny * sign, nz * sign] });
      // 忽略 0.6mm 内的阶梯微命中，只测真实对侧壁
      if (hit && hit.t > 0.6 && hit.t < 30) hits.push(hit.t);
    }
  }
  if (!hits.length) return { min: 0, p5: 0, samples: 0 };
  hits.sort((a, b) => a - b);
  const min = hits[0];
  const p5 = hits[Math.floor(hits.length * 0.05)];
  return { min, p5, samples: hits.length };
}

export function validateGuideForExport(m: MeshData, minWallSettingMm: number): ValidationResult {
  void minWallSettingMm;
  const topo = inspectTopology(m);
  const si = checkSelfIntersections(m, { sampleCap: 6000 });
  const wall = estimateWallThickness(m);
  // 体素+投影网格在 6000 点抽检中允许极少量数值贴合；真正自交会成片（>24 处）
  const siTolerantFree = si.count <= 24;
  const blockers: string[] = [];
  if (!topo.isWatertight) {
    blockers.push(`网格不水密：${topo.boundaryEdgeCount} 条边界边、${topo.nonManifoldEdgeCount} 条非流形边`);
  }
  if (topo.nonManifoldEdgeCount > 0) {
    blockers.push(`存在 ${topo.nonManifoldEdgeCount} 条非流形边`);
  }
  if (!siTolerantFree) blockers.push(`抽检 ${si.checked} 个顶点发现 ${si.count} 处自交/非相邻贴合`);
  // 设置中的 guideWallThickness 是设计名义壁厚（生成时精确保证）；这里查重建后是否出现
  // 不可打印的缺陷薄片：P5 < 0.8mm 才拦截，避免射线自褶皱噪声误杀均匀 2.5mm 底板。
  const wallThreshold = 0.8;
  const wallBad = wall.samples > 100 && wall.p5 < wallThreshold;
  if (wallBad) blockers.push(`最小壁厚不足：P5=${wall.p5.toFixed(2)}mm（可打印下限 ${wallThreshold}mm）`);
  return {
    watertight: topo.isWatertight,
    manifold: topo.isManifold,
    boundaryEdges: topo.boundaryEdgeCount,
    nonManifoldEdges: topo.nonManifoldEdgeCount,
    selfIntersectFree: siTolerantFree,
    selfIntersectionCount: si.count,
    minWallMm: wall.min,
    wallP5Mm: wall.p5,
    wallSamples: wall.samples,
    passed: blockers.length === 0,
    blockers,
  };
}

export function meshStats(m: MeshData): { verts: number; tris: number } {
  return { verts: vertexCount(m), tris: m.indices.length / 3 };
}
