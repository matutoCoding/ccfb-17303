// 体素重建导出路径（题目允许的“体素重建出水密 STL”）：
// 骨板网格 -> 距离喷溅 + 外部泛洪得到带符号距离场 -> SDF 减法合并锯槽/钉孔
// -> 插值移动四面体(Marching Tetrahedra) + 全局边缓存输出索引网格，拓扑天然水密。
import { MeshData } from './mesh';
import { Vec3, v3, Box3, box3 } from './vec';
import { closestPointOnTriangle } from './bvh';
import { getTriangleVerts } from './mesh';
import { CutterSpec } from './guide';
import { OBB } from './primitives';
import { obbLocalPoint } from './inspect';

export interface VoxelOptions {
  voxelMm: number;
  maxCells?: number;
  cutters: CutterSpec[];
  onProgress?: (msg: string) => void;
}

export function voxelizeGuideSolid(plate: MeshData, opts: VoxelOptions): MeshData {
  const maxCells = opts.maxCells ?? 12_000_000;
  const bb = boxWith(plate);
  const size = box3.size(bb);
  const volume = Math.max(1, size[0] * size[1] * size[2]);
  let h = opts.voxelMm;
  if (volume / (h * h * h) > maxCells) h = Math.cbrt(volume / maxCells);
  h = Math.max(h, 0.16);
  const pad = h * 3;
  const origin: Vec3 = [bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad];
  const nx = Math.max(4, Math.ceil((size[0] + pad * 2) / h) + 1);
  const ny = Math.max(4, Math.ceil((size[1] + pad * 2) / h) + 1);
  const nz = Math.max(4, Math.ceil((size[2] + pad * 2) / h) + 1);
  const N = nx * ny * nz;
  opts.onProgress?.(`体素化 ${nx}×${ny}×${nz} (h=${h.toFixed(2)}mm)`);

  const dist = new Float32Array(N);
  dist.fill(1e9);
  const T = plate.indices.length / 3;
  const reach = h * 1.2;
  for (let t = 0; t < T; t++) {
    const [a, b, c] = getTriangleVerts(plate, t);
    const tmin = v3.min(v3.min(a, b), c);
    const tmax = v3.max(v3.max(a, b), c);
    const i0 = Math.max(0, Math.floor((tmin[0] - reach - origin[0]) / h));
    const i1 = Math.min(nx - 1, Math.ceil((tmax[0] + reach - origin[0]) / h));
    const j0 = Math.max(0, Math.floor((tmin[1] - reach - origin[1]) / h));
    const j1 = Math.min(ny - 1, Math.ceil((tmax[1] + reach - origin[1]) / h));
    const k0 = Math.max(0, Math.floor((tmin[2] - reach - origin[2]) / h));
    const k1 = Math.min(nz - 1, Math.ceil((tmax[2] + reach - origin[2]) / h));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const id = k * nx * ny + j * nx + i;
          const p: Vec3 = [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];
          const d = v3.dist(p, closestPointOnTriangle(p, a, b, c));
          if (d < dist[id]) dist[id] = d;
        }
      }
    }
  }

  // 外部泛洪（6 邻接）。state: 0 未知, 1 屏障(近表面), 2 外部
  const state = new Uint8Array(N);
  for (let id = 0; id < N; id++) if (dist[id] <= reach) state[id] = 1;
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const tryPush = (id: number) => {
    if (state[id] === 0) { state[id] = 2; queue[qt++] = id; }
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!(i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1)) continue;
    const id = k * nx * ny + j * nx + i;
    if (state[id] === 0) { state[id] = 2; queue[qt++] = id; }
  }
  while (qh < qt) {
    const id = queue[qh++];
    const k = Math.floor(id / (nx * ny));
    const rem = id - k * nx * ny;
    const j = Math.floor(rem / nx);
    const i = rem - j * nx;
    if (i > 0) tryPush(id - 1);
    if (i < nx - 1) tryPush(id + 1);
    if (j > 0) tryPush(id - nx);
    if (j < ny - 1) tryPush(id + nx);
    if (k > 0) tryPush(id - nx * ny);
    if (k < nz - 1) tryPush(id + nx * ny);
  }

  // 有符号：内部正、外部负
  const field = new Float32Array(N);
  for (let id = 0; id < N; id++) {
    if (state[id] === 2) field[id] = -dist[id];
    else field[id] = dist[id] >= 1e8 ? h * 4 : dist[id];
  }

  const boxSDF = (p: Vec3, obb: OBB): number => {
    const l = obbLocalPoint(obb, p);
    const qx = Math.abs(l[0]) - obb.half[0];
    const qy = Math.abs(l[1]) - obb.half[1];
    const qz = Math.abs(l[2]) - obb.half[2];
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  };
  const cylSDF = (p: Vec3, center: Vec3, axis: Vec3, radius: number, length: number): number => {
    const d = v3.sub(p, center);
    const axial = v3.dot(d, axis);
    const radial = Math.sqrt(Math.max(0, v3.dot(d, d) - axial * axial));
    const qx = radial - radius;
    const qy = Math.abs(axial) - length / 2;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy);
  };

  opts.onProgress?.('SDF 减法合并锯槽/钉孔…');
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = k * nx * ny + j * nx + i;
    if (field[id] < -h * 2) continue;
    const p: Vec3 = [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];
    let cut = Infinity;
    for (const c of opts.cutters) {
      const sdf = c.kind === 'box' ? boxSDF(p, c.obb) : cylSDF(p, c.center, c.axis, c.radius, c.length);
      if (sdf < cut) cut = sdf;
    }
    if (isFinite(cut)) field[id] = Math.max(field[id], -cut);
  }

  opts.onProgress?.('插值移动四面体重建表面…');
  return marchingTetrahedra(field, nx, ny, nz, origin, h);
}

function boxWith(m: MeshData): Box3 {
  const b = box3.empty();
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) box3.includePoint(b, [p[i], p[i + 1], p[i + 2]]);
  return b;
}

const CUBE_CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const TETRA: [number, number, number, number][] = [
  [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
  [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
];

function marchingTetrahedra(
  field: Float32Array, nx: number, ny: number, nz: number, origin: Vec3, h: number,
): MeshData {
  const gid = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  const positions: number[] = [];
  const indices: number[] = [];
  const edgeVerts = new Map<string, number>();

  const cpos = (i: number, j: number, k: number): Vec3 => [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];

  function ev(g0: number, g1: number, p0: Vec3, p1: Vec3, f0: number, f1: number): number {
    const lo = Math.min(g0, g1), hi = Math.max(g0, g1);
    const key = `${lo}_${hi}`;
    const hit = edgeVerts.get(key);
    if (hit !== undefined) return hit;
    let t = f0 / (f0 - f1);
    if (!isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    const p = v3.lerp(p0, p1, t);
    const id = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    edgeVerts.set(key, id);
    return id;
  }
  const tri = (a: number, b: number, c: number) => indices.push(a, b, c);

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const g: number[] = new Array(8), pp: Vec3[] = new Array(8), ff: number[] = new Array(8);
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CUBE_CORNERS[c];
          const ii = i + di, jj = j + dj, kk = k + dk;
          g[c] = gid(ii, jj, kk);
          pp[c] = cpos(ii, jj, kk);
          ff[c] = field[g[c]];
        }
        for (const tet of TETRA) {
          const ids = tet.map((c) => g[c]);
          const ps = tet.map((c) => pp[c]);
          const fs = tet.map((c) => ff[c]);
          const ins = fs.map((x) => x >= 0);
          const nIn = ins.filter(Boolean).length;
          if (nIn === 0 || nIn === 4) continue;
          const inA = [0, 1, 2, 3].filter((x) => ins[x]);
          const outA = [0, 1, 2, 3].filter((x) => !ins[x]);
          const edge = (a: number, b: number) => ev(ids[a], ids[b], ps[a], ps[b], fs[a], fs[b]);
          if (nIn === 1) {
            const a = inA[0];
            tri(edge(a, outA[0]), edge(a, outA[1]), edge(a, outA[2]));
          } else if (nIn === 3) {
            const a = outA[0];
            tri(edge(a, inA[0]), edge(a, inA[2]), edge(a, inA[1]));
          } else {
            const [i0, i1] = inA, [o0, o1] = outA;
            const e00 = edge(i0, o0), e01 = edge(i0, o1), e10 = edge(i1, o0), e11 = edge(i1, o1);
            tri(e00, e10, e11);
            tri(e00, e11, e01);
          }
        }
      }
    }
  }
  return { name: 'voxel-guide', positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
