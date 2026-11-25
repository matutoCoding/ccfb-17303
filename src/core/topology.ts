// 网格拓扑体检与修复：破洞(边界环)、非流形边、翻转面/绕向不一致、退化三角形。
import { MeshData, computeVertexNormals, weldVertices } from './mesh';
import { Vec3, v3 } from './vec';

export interface HoleInfo {
  loop: number[]; // 顶点索引环
  edgeCount: number;
  center: Vec3;
  diameterMm: number;
  areaMm2: number;
  filled: boolean;
}

export interface TopologyReport {
  vertexCount: number;
  triangleCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  nonManifoldEdges: { a: number; b: number; faces: number[] }[];
  holes: HoleInfo[];
  degenerateTriCount: number;
  windingConflictEdges: number;
  flippedTriCountEstimate: number;
  isWatertight: boolean;
  isManifold: boolean;
  repaired: string[]; // 已执行的修复说明
  rejected: string | null; // 无法修复时的拒收原因（指明是哪块/什么问题）
}

interface EdgeUse {
  tri: number;
  dir: 1 | -1; // 边在三角形中的方向是否与 (a->b, a<b) 相同
}

function buildEdges(m: MeshData) {
  const V = m.positions.length / 3;
  const edges = new Map<number, EdgeUse[]>();
  const keyOf = (a: number, b: number) => (a < b ? a * (V + 1) + b : b * (V + 1) + a);
  const triOfKey = new Map<number, { a: number; b: number }>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const vs = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    for (let e = 0; e < 3; e++) {
      const x = vs[e], y = vs[(e + 1) % 3];
      const key = keyOf(x, y);
      if (!triOfKey.has(key)) triOfKey.set(key, { a: Math.min(x, y), b: Math.max(x, y) });
      const use: EdgeUse = { tri: t / 3, dir: x < y ? 1 : -1 };
      const arr = edges.get(key);
      if (arr) arr.push(use);
      else edges.set(key, [use]);
    }
  }
  return { V, edges, triOfKey, keyOf };
}

/** 更强的近邻焊接：空间哈希检查相邻 27 格，避免量化网格边界漏焊 */
export function mergeNearVertices(m: MeshData, eps = 1e-3): MeshData {
  const p = m.positions;
  const V = p.length / 3;
  const cell = eps * 2;
  const grid = new Map<string, number[]>();
  const newPos: number[] = [];
  const remap = new Uint32Array(V);
  const key = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  for (let v = 0; v < V; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
    let found = -1;
    outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(key(ix + dx, iy + dy, iz + dz));
      if (!arr) continue;
      for (const nv of arr) {
        if (
          Math.abs(newPos[nv * 3] - x) <= eps &&
          Math.abs(newPos[nv * 3 + 1] - y) <= eps &&
          Math.abs(newPos[nv * 3 + 2] - z) <= eps
        ) { found = nv; break outer; }
      }
    }
    if (found < 0) {
      found = newPos.length / 3;
      newPos.push(x, y, z);
      const k = key(ix, iy, iz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(found);
    }
    remap[v] = found;
  }
  const indices = new Uint32Array(m.indices.length);
  for (let i = 0; i < m.indices.length; i++) indices[i] = remap[m.indices[i]];
  return { name: m.name, positions: Float32Array.from(newPos), indices };
}

/** 点到线段距离，若投影在线段内返回 t，否则 null */
function pointOnSegment(p: Vec3, a: Vec3, b: Vec3, tol: number): number | null {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 < 1e-12) return null;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
  if (t < 1e-4 || t > 1 - 1e-4) return null; // 端点附近不算（它们本应焊接）
  const qx = a[0] + abx * t, qy = a[1] + aby * t, qz = a[2] + abz * t;
  if (Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz) <= tol) return t;
  return null;
}

/**
 * 修复 CSG 常见的 T 型接头：若一条边界边的内部落在某个已有顶点上，
 * 把拥有该边的三角形在该顶点处拆开，使两侧细分一致。
 */
export function resolveTJunctions(m: MeshData, tolMm = 0.05, maxPasses = 8): { mesh: MeshData; splits: number } {
  let positions = new Float32Array(m.positions);
  let indices = new Uint32Array(m.indices);
  let totalSplits = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const V = positions.length / 3;
    const T = indices.length / 3;
    const keyOf = (a: number, b: number) => (a < b ? a * (V + 1) + b : b * (V + 1) + a);
    const edgeTris = new Map<number, number[]>();
    for (let t = 0; t < T; t++) {
      const vs = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        const arr = edgeTris.get(k);
        if (arr) arr.push(t);
        else edgeTris.set(k, [t]);
      }
    }
    // 每条边界边找一个落在其上的顶点
    const splitOfTri = new Map<number, { x: number; y: number; z: number; v: number }>();
    for (const [k, tris] of edgeTris) {
      if (tris.length !== 1) continue;
      const a = Math.floor(k / (V + 1));
      const b = k % (V + 1);
      const pa: Vec3 = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
      const pb: Vec3 = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
      const t0 = tris[0];
      if (splitOfTri.has(t0)) continue;
      for (let v = 0; v < V; v++) {
        if (v === a || v === b) continue;
        // 排除该三角形的第三个顶点
        const i0 = indices[t0 * 3], i1 = indices[t0 * 3 + 1], i2 = indices[t0 * 3 + 2];
        if (v === i0 || v === i1 || v === i2) continue;
        const pv: Vec3 = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
        if (pointOnSegment(pv, pa, pb, tolMm) !== null) {
          // 确定有向边与对顶点
          let x = i0, y = i1, z = i2;
          const edges: [number, number, number][] = [[i0, i1, i2], [i1, i2, i0], [i2, i0, i1]];
          for (const [ex, ey, ez] of edges) {
            if ((ex === a && ey === b) || (ex === b && ey === a)) {
              // 统一成边界键的 a->b 方向，z 为第三点
              if (ex === a && ey === b) { x = ex; y = ey; z = ez; }
              else { x = ey; y = ex; z = ez; } // 反转
              break;
            }
          }
          splitOfTri.set(t0, { x, y, z, v });
          break;
        }
      }
    }
    if (!splitOfTri.size) break;
    const out: number[] = [];
    for (let t = 0; t < T; t++) {
      const sp = splitOfTri.get(t);
      if (!sp) {
        out.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
      } else {
        // (x,v,z) + (v,y,z)，朝向最后由 unifyWinding 统一
        out.push(sp.x, sp.v, sp.z, sp.v, sp.y, sp.z);
        totalSplits++;
      }
    }
    indices = Uint32Array.from(out);
  }
  const mesh: MeshData = { name: m.name, positions, indices };
  return { mesh, splits: totalSplits };
}

/**
 * 消除 >2 面共用边：反复删除“沾染非流形边最多”的三角形，
 * 打开的小洞后续由 fillHole 补回。返回删除数量。
 */
export function eliminateNonManifold(m: MeshData, maxRemove = 4000): { mesh: MeshData; removed: number } {
  let indices = new Uint32Array(m.indices);
  let removed = 0;
  for (let iter = 0; iter < maxRemove; iter++) {
    const T = indices.length / 3;
    const V = m.positions.length / 3;
    if (T === 0) break;
    const keyOf = (a: number, b: number) => (a < b ? a * (V + 1) + b : b * (V + 1) + a);
    const uses = new Map<number, number[]>();
    for (let t = 0; t < T; t++) {
      const vs = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const k = keyOf(vs[e], vs[(e + 1) % 3]);
        const arr = uses.get(k);
        if (arr) arr.push(t);
        else uses.set(k, [t]);
      }
    }
    const nmTriCount = new Int32Array(T);
    let nmEdges = 0;
    for (const u of uses.values()) {
      if (u.length > 2) {
        nmEdges++;
        for (const t of u) nmTriCount[t]++;
      }
    }
    if (nmEdges === 0) break;
    // 选沾染最多的三角形删除；并列时删面积更小的（优先剔除碎屑/重复面）
    let victim = -1;
    let bestScore = -1;
    for (let t = 0; t < T; t++) {
      if (nmTriCount[t] === 0) continue;
      let score = nmTriCount[t] * 1e6;
      // 面积越小越优先删除：用 -area 微调
      const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
      const p = m.positions;
      const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
      const e1x = p[ib] - ax, e1y = p[ib + 1] - ay, e1z = p[ib + 2] - az;
      const e2x = p[ic] - ax, e2y = p[ic + 1] - ay, e2z = p[ic + 2] - az;
      const area = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) / 2;
      score -= Math.min(area, 100);
      if (score > bestScore) { bestScore = score; victim = t; }
    }
    if (victim < 0) break;
    const out = new Uint32Array(indices.length - 3);
    out.set(indices.subarray(0, victim * 3));
    out.set(indices.subarray(victim * 3 + 3), victim * 3);
    indices = out;
    removed++;
  }
  return { mesh: { name: m.name, positions: m.positions, indices }, removed };
}

/**
 * 导出网格的完整愈合：近邻焊接 -> 删退化 -> 非流形消除 -> T 接頭修复 -> 统一绕向 -> 补小孔。
 * 返回尽量水密的流形网格；无法消除的非流形边放在 report 中。
 */
export function healExportMesh(raw: MeshData): { mesh: MeshData; report: TopologyReport; logs: string[] } {
  const logs: string[] = [];
  let mesh = mergeNearVertices(raw, 1e-3);
  mesh = removeDegenerate(mesh);
  const elim0 = eliminateNonManifold(mesh);
  if (elim0.removed > 0) logs.push(`移除 ${elim0.removed} 个造成非流形边的面`);
  mesh = elim0.mesh;
  const tj = resolveTJunctions(mesh, 0.06, 10);
  if (tj.splits > 0) logs.push(`细分 ${tj.splits} 处 T 型接头`);
  mesh = tj.mesh;
  mesh = mergeNearVertices(mesh, 1e-3);
  mesh = removeDegenerate(mesh);
  const elim1 = eliminateNonManifold(mesh);
  mesh = elim1.mesh;
  mesh = unifyWinding(mesh).mesh;

  // 补孔（含 T 接頭修复后残留的小边界环），多轮
  let report = inspectTopology(mesh);
  for (let pass = 0; pass < 8 && (report.holes.length || report.boundaryEdgeCount > 0); pass++) {
    const fillable = report.holes.filter((h) => h.edgeCount <= 96 && h.diameterMm <= 12);
    if (!fillable.length) break;
    for (const h of fillable) mesh = fillHole(mesh, h.loop);
    mesh = removeDegenerate(mesh);
    report = inspectTopology(mesh);
  }
  // 补孔后若又产生 NM（扇形在复杂边界可能），再消除+补一次
  if (report.nonManifoldEdgeCount > 0) {
    const e2 = eliminateNonManifold(mesh);
    mesh = e2.mesh;
    report = inspectTopology(mesh);
    for (const h of report.holes.filter((x) => x.edgeCount <= 96)) mesh = fillHole(mesh, h.loop);
  }
  computeVertexNormals(mesh);
  report = inspectTopology(mesh);
  return { mesh, report, logs };
}

/** 仅做体检，不修改网格 */
export function inspectTopology(m: MeshData): TopologyReport {
  const { edges, triOfKey } = buildEdges(m);
  const boundaryKeys: number[] = [];
  const nonManifold: { a: number; b: number; faces: number[] }[] = [];
  let windingConflictEdges = 0;

  for (const [key, uses] of edges) {
    if (uses.length === 1) {
      boundaryKeys.push(key);
    } else if (uses.length === 2) {
      // 一致的外表面绕向要求共享边在两个三角形中方向相反
      if (uses[0].dir === uses[1].dir) windingConflictEdges++;
    } else if (uses.length > 2) {
      const ab = triOfKey.get(key)!;
      nonManifold.push({ a: ab.a, b: ab.b, faces: uses.map((u) => u.tri) });
    }
  }

  // 退化三角形
  let degenerate = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const ia = m.indices[t] * 3, ib = m.indices[t + 1] * 3, ic = m.indices[t + 2] * 3;
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-12) degenerate++;
  }

  const holes = traceHoles(m, boundaryKeys, triOfKey);

  // 估算翻转三角形数量：以邻接 BFS 传播绕向
  const flippedEstimate = estimateFlippedTris(m);

  const boundaryEdgeCount = boundaryKeys.length;
  return {
    vertexCount: m.positions.length / 3,
    triangleCount: m.indices.length / 3,
    boundaryEdgeCount,
    nonManifoldEdgeCount: nonManifold.length,
    nonManifoldEdges: nonManifold.slice(0, 50),
    holes,
    degenerateTriCount: degenerate,
    windingConflictEdges,
    flippedTriCountEstimate: flippedEstimate,
    isWatertight: boundaryEdgeCount === 0 && nonManifold.length === 0,
    isManifold: nonManifold.length === 0,
    repaired: [],
    rejected: null,
  };
}

function traceHoles(
  m: MeshData,
  boundaryKeys: number[],
  triOfKey: Map<number, { a: number; b: number }>,
): HoleInfo[] {
  const p = m.positions;
  // 顶点 -> 相邻边界顶点
  const vAdj = new Map<number, number[]>();
  const keySet = new Set(boundaryKeys);
  for (const key of boundaryKeys) {
    const ab = triOfKey.get(key)!;
    if (!vAdj.has(ab.a)) vAdj.set(ab.a, []);
    if (!vAdj.has(ab.b)) vAdj.set(ab.b, []);
    vAdj.get(ab.a)!.push(ab.b);
    vAdj.get(ab.b)!.push(ab.a);
  }
  const visitedEdges = new Set<number>();
  const holes: HoleInfo[] = [];
  const edgeKey = (a: number, b: number) => {
    const V = p.length / 3;
    return a < b ? a * (V + 1) + b : b * (V + 1) + a;
  };
  for (const key of boundaryKeys) {
    if (visitedEdges.has(key)) continue;
    const ab0 = triOfKey.get(key)!;
    const loop: number[] = [ab0.a];
    let prev = ab0.a;
    let cur = ab0.b;
    visitedEdges.add(key);
    let guard = 0;
    while (cur !== ab0.a && guard++ < 100000) {
      loop.push(cur);
      const nbrs = vAdj.get(cur) ?? [];
      let next = -1;
      for (const nb of nbrs) {
        const k = edgeKey(cur, nb);
        if (!visitedEdges.has(k) && keySet.has(k)) { next = nb; visitedEdges.add(k); break; }
      }
      if (next === -1) break;
      prev = cur;
      cur = next;
    }
    // 几何信息
    const center = v3.create();
    let maxD = 0;
    for (const vi of loop) {
      center[0] += p[vi * 3]; center[1] += p[vi * 3 + 1]; center[2] += p[vi * 3 + 2];
    }
    center[0] /= loop.length; center[1] /= loop.length; center[2] /= loop.length;
    for (const vi of loop) {
      maxD = Math.max(maxD, v3.dist(center, [p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]]));
    }
    let area = 0;
    for (let i = 1; i < loop.length - 1; i++) {
      const a: Vec3 = [p[loop[0] * 3], p[loop[0] * 3 + 1], p[loop[0] * 3 + 2]];
      const b: Vec3 = [p[loop[i] * 3], p[loop[i] * 3 + 1], p[loop[i] * 3 + 2]];
      const c: Vec3 = [p[loop[i + 1] * 3], p[loop[i + 1] * 3 + 1], p[loop[i + 1] * 3 + 2]];
      area += v3.len(v3.cross(v3.sub(b, a), v3.sub(c, a))) / 2;
    }
    holes.push({
      loop, edgeCount: loop.length, center,
      diameterMm: maxD * 2, areaMm2: area, filled: false,
    });
  }
  return holes.sort((a, b) => b.edgeCount - a.edgeCount);
}

/** BFS 绕向传播，估算与多数面朝向不一致的三角形数 */
export function estimateFlippedTris(m: MeshData): number {
  const T = m.indices.length / 3;
  if (T === 0) return 0;
  const { edges } = buildEdges(m);
  const adj = new Map<number, { tri: number; sameDir: boolean }[]>();
  for (const uses of edges.values()) {
    if (uses.length !== 2) continue;
    const [u0, u1] = uses;
    const sameDir = u0.dir === u1.dir;
    // sameDir=true 表示共享边同向 -> 两个三角形绕向冲突，需要翻转其中一个才能一致
    if (!adj.has(u0.tri)) adj.set(u0.tri, []);
    if (!adj.has(u1.tri)) adj.set(u1.tri, []);
    adj.get(u0.tri)!.push({ tri: u1.tri, sameDir });
    adj.get(u1.tri)!.push({ tri: u0.tri, sameDir });
  }
  const flip = new Int8Array(T); // 0 未知, 1 不翻, -1 翻
  let flipped = 0;
  for (let start = 0; start < T; start++) {
    if (flip[start] !== 0) continue;
    flip[start] = 1;
    const queue = [start];
    const comp: number[] = [];
    while (queue.length) {
      const t = queue.pop()!;
      comp.push(t);
      for (const nb of adj.get(t) ?? []) {
        // 若共享边同向，则邻居需要取反
        const expected = (nb.sameDir ? -flip[t] : flip[t]) as 1 | -1;
        if (flip[nb.tri] === 0) {
          flip[nb.tri] = expected;
          queue.push(nb.tri);
        }
      }
    }
    let neg = 0;
    for (const t of comp) if (flip[t] === -1) neg++;
    // 选少数派作为翻转面
    if (neg > comp.length / 2) {
      flipped += comp.length - neg;
      for (const t of comp) flip[t] = flip[t] === 1 ? -1 : 1;
    } else {
      flipped += neg;
    }
  }
  return flipped;
}

/**
 * 自动修复：焊接顶点 -> 删退化 -> 统一绕向 -> 补小孔。
 * 大孔 / 非流形边无法可靠修复时返回 rejected 原因。
 */
export function repairMesh(
  raw: MeshData,
  opts: { maxHoleEdges?: number; maxHoleDiameterMm?: number } = {},
): { mesh: MeshData; report: TopologyReport } {
  const maxHoleEdges = opts.maxHoleEdges ?? 64;
  const maxHoleDiameterMm = opts.maxHoleDiameterMm ?? 25;
  const repaired: string[] = [];

  // 1. 焊接
  let { mesh: m } = weldVertices(raw, 1e-3);
  if (m.positions.length !== raw.positions.length) {
    repaired.push(`焊接重合顶点（${raw.positions.length / 3} → ${m.positions.length / 3} 顶点）`);
  }

  // 2. 删退化三角形
  const beforeTris = m.indices.length / 3;
  m = removeDegenerate(m);
  if (m.indices.length / 3 < beforeTris) {
    repaired.push(`删除 ${beforeTris - m.indices.length / 3} 个退化三角形`);
  }

  // 3. 统一绕向
  const oriented = unifyWinding(m);
  if (oriented.flipped > 0) repaired.push(`翻转 ${oriented.flipped} 个绕向/法线相反的面，统一朝外`);
  m = oriented.mesh;

  // 4. 体检 + 补洞（循环，补一个可能改变拓扑）
  let report = inspectTopology(m);
  if (report.nonManifoldEdgeCount > 0) {
    report.repaired = repaired;
    report.rejected = `存在 ${report.nonManifoldEdgeCount} 条非流形边（超过两个面共用一条边），无法可靠自动修复。问题位置示例：顶点 ${report.nonManifoldEdges.slice(0, 3).map((e) => `#${e.a}-#${e.b}`).join('、')}。请在建模软件中清理后重新导出 ${raw.name}。`;
    return { mesh: m, report };
  }

  let fillPasses = 0;
  while (true) {
    report = inspectTopology(m);
    const fillable = report.holes.filter((h) => h.edgeCount <= maxHoleEdges && h.diameterMm <= maxHoleDiameterMm);
    const tooBig = report.holes.filter((h) => !(h.edgeCount <= maxHoleEdges && h.diameterMm <= maxHoleDiameterMm));
    if (tooBig.length > 0) {
      report.repaired = repaired;
      report.rejected =
        `${raw.name} 有 ${tooBig.length} 个过大的破洞无法自动修补` +
        `（最大 ${tooBig[0].edgeCount} 边 / 直径 ${tooBig[0].diameterMm.toFixed(1)}mm，` +
        `允许上限 ${maxHoleEdges} 边 / ${maxHoleDiameterMm}mm）。请重新分割导出该模型。`;
      return { mesh: m, report };
    }
    if (fillable.length === 0 || fillPasses >= 10) break;
    let filledNow = 0;
    for (const h of fillable) {
      m = fillHole(m, h.loop);
      filledNow++;
    }
    repaired.push(`修补 ${filledNow} 个破洞（${fillable.map((h) => h.edgeCount + '边').join('、')}）`);
    fillPasses++;
  }

  computeVertexNormals(m);
  report = inspectTopology(m);
  report.repaired = repaired;
  report.rejected = null;
  return { mesh: m, report };
}

export function removeDegenerate(m: MeshData): MeshData {
  const p = m.positions;
  const idx = m.indices;
  const out: number[] = [];
  let removed = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3;
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    // 重合索引也算退化
    if (idx[t] === idx[t + 1] || idx[t + 1] === idx[t + 2] || idx[t] === idx[t + 2] || cx * cx + cy * cy + cz * cz < 1e-10) {
      removed++;
      continue;
    }
    out.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  return { name: m.name, positions: m.positions, indices: Uint32Array.from(out) };
}

/** BFS 统一三角形绕向，并按有符号体积决定是否整体翻转 */
export function unifyWinding(m: MeshData): { mesh: MeshData; flipped: number } {
  const T = m.indices.length / 3;
  if (T === 0) return { mesh: m, flipped: 0 };
  const { edges } = buildEdges(m);
  const adj = new Map<number, { tri: number; sameDir: boolean }[]>();
  for (const uses of edges.values()) {
    if (uses.length !== 2) continue;
    const [u0, u1] = uses;
    const sameDir = u0.dir === u1.dir;
    if (!adj.has(u0.tri)) adj.set(u0.tri, []);
    if (!adj.has(u1.tri)) adj.set(u1.tri, []);
    adj.get(u0.tri)!.push({ tri: u1.tri, sameDir });
    adj.get(u1.tri)!.push({ tri: u0.tri, sameDir });
  }
  const flip = new Int8Array(T);
  const flipList: number[] = [];
  for (let start = 0; start < T; start++) {
    if (flip[start] !== 0) continue;
    flip[start] = 1;
    const queue = [start];
    const comp: number[] = [];
    while (queue.length) {
      const t = queue.pop()!;
      comp.push(t);
      for (const nb of adj.get(t) ?? []) {
        const expected = (nb.sameDir ? -flip[t] : flip[t]) as 1 | -1;
        if (flip[nb.tri] === 0) {
          flip[nb.tri] = expected;
          queue.push(nb.tri);
        }
      }
    }
    // 用该连通分量的有符号体积决定整体朝向
    let vol6 = 0;
    const p = m.positions, idx = m.indices;
    for (const t of comp) {
      let a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (flip[t] === -1) { const tmp = b; b = c; c = tmp; }
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
      const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
      vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    // 我们约定朝外的面产生正体积；若分量体积为负则整体取反
    if (vol6 < 0) for (const t of comp) flip[t] = flip[t] === 1 ? -1 : 1;
  }
  const indices = new Uint32Array(m.indices);
  let flipped = 0;
  for (let t = 0; t < T; t++) {
    if (flip[t] === -1) {
      const i = t * 3;
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
      flipped++;
    }
  }
  return { mesh: { name: m.name, positions: m.positions, indices }, flipped };
}

/** 用中心顶点扇形填充边界环（适合小破洞） */
function fillHole(m: MeshData, loop: number[]): MeshData {
  const p = m.positions;
  let cx = 0, cy = 0, cz = 0;
  for (const vi of loop) { cx += p[vi * 3]; cy += p[vi * 3 + 1]; cz += p[vi * 3 + 2]; }
  cx /= loop.length; cy /= loop.length; cz /= loop.length;
  const newPositions = new Float32Array(p.length + 3);
  newPositions.set(p);
  const centerIndex = p.length / 3;
  newPositions[p.length] = cx; newPositions[p.length + 1] = cy; newPositions[p.length + 2] = cz;
  const newTris: number[] = Array.from(m.indices);
  // 选择与边界边方向相反的扇形绕向：直接尝试，unifyWinding 之后还会统一
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    newTris.push(centerIndex, a, b);
  }
  const out: MeshData = { name: m.name, positions: newPositions, indices: Uint32Array.from(newTris) };
  const u = unifyWinding(out);
  computeVertexNormals(u.mesh);
  return u.mesh;
}
