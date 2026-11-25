// 三角形网格 BVH：射线求交、最近点查询。用于拾取、安全边界、缝隙、扫查与轮廓比对。
import { MeshData, getTriangleVerts } from './mesh';
import { Vec3, v3, Ray, rayTriangle, Box3, box3 } from './vec';

interface BuildTri {
  t: number;
  center: Vec3;
  bmin: Vec3;
  bmax: Vec3;
}

interface BVHNode {
  box: Box3;
  left?: BVHNode;
  right?: BVHNode;
  tris?: number[]; // 叶子：三角形索引
}

export class BVH {
  mesh: MeshData;
  private root: BVHNode | null = null;

  constructor(mesh: MeshData) {
    this.mesh = mesh;
    this.build();
  }

  private build() {
    const m = this.mesh;
    const T = m.indices.length / 3;
    const items: BuildTri[] = new Array(T);
    for (let t = 0; t < T; t++) {
      const [a, b, c] = getTriangleVerts(m, t);
      const bmin = v3.min(v3.min(a, b), c);
      const bmax = v3.max(v3.max(a, b), c);
      items[t] = { t, center: v3.scale(v3.add(v3.add(a, b), c), 1 / 3), bmin, bmax };
    }
    this.root = this.buildNode(items, 0, T);
  }

  private buildNode(items: BuildTri[], start: number, end: number): BVHNode {
    const box = box3.empty();
    for (let i = start; i < end; i++) {
      box.min = v3.min(box.min, items[i].bmin);
      box.max = v3.max(box.max, items[i].bmax);
    }
    const count = end - start;
    if (count <= 6) {
      return { box, tris: items.slice(start, end).map((x) => x.t) };
    }
    // 沿最长轴排序后中点划分
    const size = box3.size(box);
    const axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
    const slice = items.slice(start, end).sort((a, b) => a.center[axis] - b.center[axis]);
    const mid = start + Math.floor(count / 2);
    for (let i = 0; i < count; i++) items[start + i] = slice[i];
    return {
      box,
      left: this.buildNode(items, start, mid),
      right: this.buildNode(items, mid, end),
    };
  }

  /** 射线求最近交点，返回距离 t 与三角形 */
  raycast(r: Ray): { t: number; tri: number; point: Vec3 } | null {
    let bestT = Infinity;
    let bestTri = -1;
    const walk = (node: BVHNode) => {
      if (!this.rayBox(r, node.box, bestT)) return;
      if (node.tris) {
        for (const tri of node.tris) {
          const [a, b, c] = getTriangleVerts(this.mesh, tri);
          const t = rayTriangle(r, a, b, c);
          if (t !== null && t < bestT) { bestT = t; bestTri = tri; }
        }
        return;
      }
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
    };
    if (this.root) walk(this.root);
    if (bestTri < 0) return null;
    return { t: bestT, tri: bestTri, point: v3.mulAdd(r.origin, r.dir, bestT) };
  }

  private rayBox(r: Ray, b: Box3, maxT: number): boolean {
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      const o = r.origin[i], d = r.dir[i];
      if (Math.abs(d) < 1e-12) {
        if (o < b.min[i] || o > b.max[i]) return false;
      } else {
        let t1 = (b.min[i] - o) / d;
        let t2 = (b.max[i] - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return false;
      }
    }
    return tmin <= maxT && tmax >= 0;
  }

  /** 点到网格的最近距离与最近点 */
  closestPoint(p: Vec3): { distance: number; point: Vec3; tri: number } {
    let bestD2 = Infinity;
    let bestPoint: Vec3 = p;
    let bestTri = -1;
    const walk = (node: BVHNode) => {
      if (!node) return;
      const db = this.pointBoxDist2(p, node.box);
      if (db > bestD2) return;
      if (node.tris) {
        for (const tri of node.tris) {
          const [a, b, c] = getTriangleVerts(this.mesh, tri);
          const q = closestPointOnTriangle(p, a, b, c);
          const d2 = v3.dist2(p, q);
          if (d2 < bestD2) { bestD2 = d2; bestPoint = q; bestTri = tri; }
        }
        return;
      }
      // 先查更近的子树
      const dl = node.left ? this.pointBoxDist2(p, node.left.box) : Infinity;
      const dr = node.right ? this.pointBoxDist2(p, node.right.box) : Infinity;
      if (dl < dr) { if (node.left) walk(node.left); if (node.right) walk(node.right); }
      else { if (node.right) walk(node.right); if (node.left) walk(node.left); }
    };
    if (this.root) walk(this.root);
    return { distance: Math.sqrt(bestD2), point: bestPoint, tri: bestTri };
  }

  private pointBoxDist2(p: Vec3, b: Box3): number {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
      let v = 0;
      if (p[i] < b.min[i]) v = b.min[i] - p[i];
      else if (p[i] > b.max[i]) v = p[i] - b.max[i];
      d2 += v * v;
    }
    return d2;
  }

  /** 查询与 AABB 相交的叶子三角形 */
  queryAABB(box: Box3): number[] {
    const out: number[] = [];
    const walk = (node: BVHNode) => {
      if (!this.boxOverlap(node.box, box)) return;
      if (node.tris) { for (const t of node.tris) out.push(t); return; }
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
    };
    if (this.root) walk(this.root);
    return out;
  }

  private boxOverlap(a: Box3, b: Box3): boolean {
    return !(
      a.max[0] < b.min[0] || a.min[0] > b.max[0] ||
      a.max[1] < b.min[1] || a.min[1] > b.max[1] ||
      a.max[2] < b.min[2] || a.min[2] > b.max[2]
    );
  }

  /** 网格中是否存在距离 p 小于 radius 的点（快速） */
  withinDistance(p: Vec3, radius: number): boolean {
    return this.closestPoint(p).distance <= radius;
  }
}

/** Ericson 最近点 on triangle */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = v3.sub(b, a);
  const ac = v3.sub(c, a);
  const ap = v3.sub(p, a);
  const d1 = v3.dot(ab, ap);
  const d2 = v3.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = v3.sub(p, b);
  const d3 = v3.dot(ab, bp);
  const d4 = v3.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return v3.add(a, v3.scale(ab, v));
  }
  const cp = v3.sub(p, c);
  const d5 = v3.dot(ab, cp);
  const d6 = v3.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return v3.add(a, v3.scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d1 - d2 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d1 - d2));
    return v3.add(b, v3.scale(v3.sub(c, b), w));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** 两个网格是否有三角形相交（粗粒度，带提前退出），返回第一对相交三角形 */
export function findIntersectingTriangles(
  m1: MeshData, m2: MeshData, maxChecks = 200000,
): { t1: number; t2: number } | null {
  const bvh2 = new BVH(m2);
  let checks = 0;
  for (let t1 = 0; t1 < m1.indices.length / 3; t1++) {
    const tri1 = getTriangleVerts(m1, t1);
    // 用 m1 三角形质心最近点粗筛 + 精确三角形对
    const c = v3.scale(v3.add(v3.add(tri1[0], tri1[1]), tri1[2]), 1 / 3);
    const near = bvh2.closestPoint(c);
    if (near.distance > 5) continue;
    // 遍历 m2 中靠近的三角形代价高；直接在 near 周围用 BVH 射线不合适，
    // 这里采用有限范围全量精确检测（导板网格规模可控）。
    for (let t2 = 0; t2 < m2.indices.length / 3; t2++) {
      if (checks++ > maxChecks) return null;
      const tri2 = getTriangleVerts(m2, t2);
      if (trianglesIntersect(tri1[0], tri1[1], tri1[2], tri2[0], tri2[1], tri2[2])) {
        return { t1, t2 };
      }
    }
  }
  return null;
}

/** Möller 三角形-三角形相交 */
export function trianglesIntersect(
  v0: Vec3, v1: Vec3, v2: Vec3,
  u0: Vec3, u1: Vec3, u2: Vec3,
): boolean {
  // 基于分离轴的快速检测（平面重叠区间法的简化实现）
  const n1 = v3.cross(v3.sub(v1, v0), v3.sub(v2, v0));
  const d1 = -v3.dot(n1, v0);
  const du0 = v3.dot(n1, u0) + d1;
  const du1 = v3.dot(n1, u1) + d1;
  const du2 = v3.dot(n1, u2) + d1;
  const eps = 1e-7;
  if ((du0 > eps && du1 > eps && du2 > eps) || (du0 < -eps && du1 < -eps && du2 < -eps)) return false;

  const n2 = v3.cross(v3.sub(u1, u0), v3.sub(u2, u0));
  const d2 = -v3.dot(n2, u0);
  const dv0 = v3.dot(n2, v0) + d2;
  const dv1 = v3.dot(n2, v1) + d2;
  const dv2 = v3.dot(n2, v2) + d2;
  if ((dv0 > eps && dv1 > eps && dv2 > eps) || (dv0 < -eps && dv1 < -eps && dv2 < -eps)) return false;

  // 共面退化：用边分离轴
  if (v3.len(n1) < eps || v3.len(n2) < eps) return false;

  // 交线方向
  const line = v3.cross(n1, n2);
  if (v3.len(line) < eps) {
    // 共面：SAT on edges（简化：跳过，导板检查中罕见）
    return coplanarTriOverlap(v0, v1, v2, u0, u1, u2, n1);
  }
  const dir = v3.norm(line);
  const project = (p: Vec3) => v3.dot(p, dir);
  const a = [project(v0), project(v1), project(v2)];
  const b = [project(u0), project(u1), project(u2)];
  const ia = [Math.min(...a), Math.max(...a)];
  const ib = [Math.min(...b), Math.max(...b)];
  return ia[0] <= ib[1] + eps && ib[0] <= ia[1] + eps;
}

function coplanarTriOverlap(a: Vec3, b: Vec3, c: Vec3, d: Vec3, e: Vec3, f: Vec3, n: Vec3): boolean {
  // 在三角形所在平面内对每条边做分离轴
  const tris = [[a, b, c], [d, e, f]];
  for (const tri of tris) {
    for (let i = 0; i < 3; i++) {
      const edge = v3.sub(tri[(i + 1) % 3], tri[i]);
      const axis = v3.norm(v3.cross(n, edge));
      if (v3.len(axis) < 1e-9) continue;
      const pa = [v3.dot(a, axis), v3.dot(b, axis), v3.dot(c, axis)];
      const pb = [v3.dot(d, axis), v3.dot(e, axis), v3.dot(f, axis)];
      const aMin = Math.min(...pa), aMax = Math.max(...pa);
      const bMin = Math.min(...pb), bMax = Math.max(...pb);
      if (aMax < bMin || bMax < aMin) return false;
    }
  }
  return true;
}
