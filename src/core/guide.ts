// 导板生成：在骨面选取贴骨带 -> 偏移出底板实体；分析就位方向倒凹；
// 生成锯槽有向盒与钉孔圆柱切割体（预览着色器与导出 BSP 共用同一份定义，保证所见即所导）。
import { MeshData, computeVertexNormals, buildMesh } from './mesh';
import { Vec3, v3, makePlane, planeBasis } from './vec';
import { BVH } from './bvh';
import { CutPlaneSpec } from './types';
import { OBB } from './primitives';

export type CutterSpec =
  | { kind: 'box'; label: string; obb: OBB; slotIndex?: number }
  | { kind: 'cylinder'; label: string; center: Vec3; axis: Vec3; radius: number; length: number };

export interface GuideBuildResult {
  plate: MeshData;
  cutters: CutterSpec[];
  pinPoints: Vec3[];
  undercutPoints: Vec3[];
  undercutMesh: MeshData | null;
  selectedTriCount: number;
  removedUndercutTriCount: number;
}

export interface GuideParams {
  planes: CutPlaneSpec[];
  seatDir: Vec3;
  thickness: number;
  slotWidth: number;
  pinDiameter: number;
  pinCount?: number;
  bandWidth: number;
  boneGap?: number;
  autoRelieve: boolean;
  /** 锯槽盒在平面内两个方向的半长 */
  slotExtentU?: number;
  slotExtentV?: number;
  patchRadius?: number;
}

export function buildGuide(bone: MeshData, params: GuideParams): GuideBuildResult {
  if (!bone.normals) computeVertexNormals(bone);
  const normal = bone.normals!;
  const p = bone.positions;
  const triCount = bone.indices.length / 3;
  const bvh = new BVH(bone);
  const seat = v3.norm(params.seatDir);
  const patchRadius = params.patchRadius ?? 27;

  // 1. 选取贴骨带三角形
  const selected: number[] = [];
  const undercutTris: number[] = [];
  const undercutPoints: Vec3[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = bone.indices[t * 3], ib = bone.indices[t * 3 + 1], ic = bone.indices[t * 3 + 2];
    const cx = (p[ia * 3] + p[ib * 3] + p[ic * 3]) / 3;
    const cy = (p[ia * 3 + 1] + p[ib * 3 + 1] + p[ic * 3 + 1]) / 3;
    const cz = (p[ia * 3 + 2] + p[ib * 3 + 2] + p[ic * 3 + 2]) / 3;
    const centroid: Vec3 = [cx, cy, cz];
    let nearDist = Infinity;
    let nearAnchor = Infinity;
    for (const pl of params.planes) {
      const plane = makePlane(pl.point, pl.normal);
      nearDist = Math.min(nearDist, Math.abs(plane.n[0] * cx + plane.n[1] * cy + plane.n[2] * cz + plane.d));
      nearAnchor = Math.min(nearAnchor, v3.dist(centroid, pl.point));
    }
    if (nearDist > params.bandWidth) continue;
    if (nearAnchor > patchRadius) continue; // 限制为围绕截骨区的紧凑导板，避免沿升支拉长
    // 面法线（用顶点法线均值更稳）
    const nx = (normal[ia * 3] + normal[ib * 3] + normal[ic * 3]) / 3;
    const ny = (normal[ia * 3 + 1] + normal[ib * 3 + 1] + normal[ic * 3 + 1]) / 3;
    const nz = (normal[ia * 3 + 2] + normal[ib * 3 + 2] + normal[ic * 3 + 2]) / 3;
    const nn = v3.norm([nx, ny, nz]);
    if (v3.dot(nn, seat) > 0.45) continue; // 背向就位方向的顶面不包
    selected.push(t);

    // 2. 倒凹：从骨面沿就位反方向回看，若再次命中骨头则被卡
    const origin = v3.mulAdd(centroid, nn, 0.6);
    const hit = bvh.raycast({ origin, dir: v3.scale(seat, -1) });
    if (hit && hit.t > 1.2 && hit.t < 60) {
      undercutTris.push(t);
      undercutPoints.push(hit.point);
    }
  }

  const undercutSet = new Set(undercutTris);
  let finalTris = selected;
  let removed = 0;
  if (params.autoRelieve) {
    finalTris = selected.filter((t) => !undercutSet.has(t));
    removed = selected.length - finalTris.length;
  }
  // 规范化选区：最大连通片 + 剪枝 + 消除蝴蝶结，保证底板是带边界的流形片
  finalTris = regularizeSelection(bone, finalTris);

  // 倒凹红色高亮网格（未消时显示在骨面上）
  let undercutMesh: MeshData | null = null;
  if (undercutTris.length) {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const t of undercutTris) {
      const base = pos.length / 3;
      for (let k = 0; k < 3; k++) {
        const vi = bone.indices[t * 3 + k];
        pos.push(p[vi * 3] + normal[vi * 3] * 0.4, p[vi * 3 + 1] + normal[vi * 3 + 1] * 0.4, p[vi * 3 + 2] + normal[vi * 3 + 2] * 0.4);
      }
      idx.push(base, base + 1, base + 2);
    }
    undercutMesh = buildMesh('undercut', pos, idx);
  }

  // 3. 底板实体
  const plate = buildOffsetPlate(bone, finalTris, params.thickness, params.boneGap ?? 0.35);

  // 4. 固定钉点（贪心最远点采样，避开锯槽）
  const pinPoints = choosePinPoints(bone, finalTris, params.planes, params.pinCount ?? 3);

  // 5. 切割体
  const cutters: CutterSpec[] = [];
  const w = params.slotWidth;
  params.planes.forEach((pl, i) => {
    const basis = planeBasis(pl.normal);
    cutters.push({
      kind: 'box',
      label: pl.label || `锯槽${i + 1}`,
      slotIndex: i,
      obb: {
        center: pl.point,
        axes: [basis.u, basis.v, basis.n],
        half: [params.slotExtentU ?? 27, params.slotExtentV ?? 26, w / 2],
      },
    });
  });
  for (const pp of pinPoints) {
    cutters.push({
      kind: 'cylinder',
      label: '固定钉孔',
      center: pp,
      axis: seat,
      radius: params.pinDiameter / 2,
      length: 34,
    });
  }

  return {
    plate, cutters, pinPoints, undercutPoints, undercutMesh,
    selectedTriCount: selected.length, removedUndercutTriCount: removed,
  };
}

/** 把选出的骨面三角形沿法线偏移并封边，生成封闭底板 */
function buildOffsetPlate(bone: MeshData, tris: number[], thickness: number, gap: number): MeshData {
  const srcP = bone.positions;
  const n = bone.normals!;
  const used = new Map<number, number>();
  const oldVerts: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = bone.indices[t * 3 + k];
      if (!used.has(vi)) { used.set(vi, oldVerts.length); oldVerts.push(vi); }
    }
  }
  const V = oldVerts.length;
  const positions = new Float32Array(V * 2 * 3);
  for (let i = 0; i < V; i++) {
    const vi = oldVerts[i];
    for (let layer = 0; layer < 2; layer++) {
      const off = gap + layer * thickness;
      positions[(layer * V + i) * 3] = srcP[vi * 3] + n[vi * 3] * off;
      positions[(layer * V + i) * 3 + 1] = srcP[vi * 3 + 1] + n[vi * 3 + 1] * off;
      positions[(layer * V + i) * 3 + 2] = srcP[vi * 3 + 2] + n[vi * 3 + 2] * off;
    }
  }
  const indices: number[] = [];
  const edgeCount = new Map<string, number>();
  const edgeDir = new Map<string, [number, number]>();
  const vkey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const t of tris) {
    const oa = bone.indices[t * 3], ob = bone.indices[t * 3 + 1], oc = bone.indices[t * 3 + 2];
    const a = used.get(oa)!, b = used.get(ob)!, c = used.get(oc)!;
    // 外层同绕向
    indices.push(V + a, V + b, V + c);
    // 内层反绕向
    indices.push(a, c, b);
    const edges: [number, number][] = [[oa, ob], [ob, oc], [oc, oa]];
    for (const [x, y] of edges) {
      const key = vkey(x, y);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!edgeDir.has(key)) edgeDir.set(key, [used.get(x)!, used.get(y)!]);
    }
  }
  // 边界封边
  for (const [key, cnt] of edgeCount) {
    if (cnt !== 1) continue;
    const [a, b] = edgeDir.get(key)!;
    indices.push(V + a, V + b, b, V + a, b, a);
  }
  const m: MeshData = { name: 'guide-plate', positions, indices: Uint32Array.from(indices) };
  computeVertexNormals(m);
  return m;
}

/** 选区规范化：只留最大边连通片，剪掉细耳，并消除顶点蝴蝶结 */
function regularizeSelection(bone: MeshData, tris: number[]): number[] {
  if (tris.length < 4) return tris;
  const V = bone.positions.length / 3;
  const tset = new Set(tris);
  const keyOf = (a: number, b: number) => (a < b ? a * (V + 1) + b : b * (V + 1) + a);

  // 三角形邻接（共享边）
  const edgeTris = new Map<number, number[]>();
  for (const t of tris) {
    const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const k = keyOf(vs[e], vs[(e + 1) % 3]);
      const arr = edgeTris.get(k);
      if (arr) arr.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  // 连通分量：保留所有足够大的片（多个相距较远的锯槽区各自成片，不能只留最大）
  const seen = new Set<number>();
  const components: number[][] = [];
  for (const start of tris) {
    if (seen.has(start)) continue;
    const stack = [start];
    const cur: number[] = [];
    seen.add(start);
    while (stack.length) {
      const t = stack.pop()!;
      cur.push(t);
      const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        for (const nb of edgeTris.get(k) ?? []) {
          if (nb !== t && tset.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
      }
    }
    components.push(cur);
  }
  // 保留 ≥24 面的分量（丢弃噪点岛），但若最大分量很大则阈值可放宽
  const biggest = Math.max(...components.map((c) => c.length));
  const keepThreshold = Math.min(24, Math.floor(biggest * 0.08));
  let curSet = new Set<number>(components.filter((c) => c.length >= keepThreshold).flat());

  // 剪耳：删除有 ≥2 条边界边的三角形，重复几轮
  for (let pass = 0; pass < 4; pass++) {
    const boundaryCount = new Map<number, number>();
    const eUse = new Map<number, number>();
    for (const t of curSet) {
      const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        eUse.set(k, (eUse.get(k) ?? 0) + 1);
      }
    }
    for (const t of curSet) {
      const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
      let bc = 0;
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        if ((eUse.get(k) ?? 0) === 1) bc++;
      }
      boundaryCount.set(t, bc);
    }
    const remove = [...curSet].filter((t) => (boundaryCount.get(t) ?? 0) >= 2 && curSet.size > 80);
    if (!remove.length) break;
    for (const t of remove) curSet.delete(t);
  }

  // 蝴蝶结：某顶点关联 >2 条边界边时，删掉该顶点上边界边最多的一个三角形
  for (let iter = 0; iter < 200; iter++) {
    const eUse = new Map<number, number>();
    for (const t of curSet) {
      const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        eUse.set(k, (eUse.get(k) ?? 0) + 1);
      }
    }
    const boundaryDeg = new Map<number, number>();
    for (const [k, cnt] of eUse) {
      if (cnt !== 1) continue;
      const a = Math.floor(k / (V + 1));
      const b = k % (V + 1);
      boundaryDeg.set(a, (boundaryDeg.get(a) ?? 0) + 1);
      boundaryDeg.set(b, (boundaryDeg.get(b) ?? 0) + 1);
    }
    let bowV = -1;
    for (const [v, d] of boundaryDeg) if (d > 2) { bowV = v; break; }
    if (bowV < 0) break;
    let victim = -1, victimBoundaryEdges = -1;
    for (const t of curSet) {
      const vs = [bone.indices[t * 3], bone.indices[t * 3 + 1], bone.indices[t * 3 + 2]];
      if (!vs.includes(bowV)) continue;
      let bc = 0;
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        if ((eUse.get(k) ?? 0) === 1) bc++;
      }
      if (bc > victimBoundaryEdges) { victimBoundaryEdges = bc; victim = t; }
    }
    if (victim < 0) break;
    curSet.delete(victim);
  }

  return [...curSet];
}

function choosePinPoints(bone: MeshData, tris: number[], planes: CutPlaneSpec[], count: number): Vec3[] {
  const p = bone.positions;
  const normals = bone.normals!;
  const candidates: Vec3[] = [];
  const step = Math.max(1, Math.floor(tris.length / 400));
  for (let i = 0; i < tris.length; i += step) {
    const t = tris[i];
    const ia = bone.indices[t * 3];
    const pt: Vec3 = [p[ia * 3] + normals[ia * 3] * 4, p[ia * 3 + 1] + normals[ia * 3 + 1] * 4, p[ia * 3 + 2] + normals[ia * 3 + 2] * 4];
    let tooCloseSlot = false;
    for (const pl of planes) {
      const plane = makePlane(pl.point, pl.normal);
      if (Math.abs(plane.n[0] * pt[0] + plane.n[1] * pt[1] + plane.n[2] * pt[2] + plane.d) < 8) { tooCloseSlot = true; break; }
    }
    if (!tooCloseSlot) candidates.push(pt);
  }
  if (!candidates.length) return [];
  // 最远点采样
  const chosen: Vec3[] = [candidates[Math.floor(candidates.length / 2)]];
  while (chosen.length < count && candidates.length) {
    let best: Vec3 | null = null;
    let bestD = -1;
    for (const c of candidates) {
      let d = Infinity;
      for (const q of chosen) d = Math.min(d, v3.dist2(c, q));
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best) break;
    if (bestD < 36 && chosen.length >= 1) break; // 间距 ≥6mm
    chosen.push(best);
  }
  return chosen;
}
