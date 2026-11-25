// 真正的网格布尔：BSP CSG（移植自经典 csg.js 算法，针对本项目干净流形网格）。
// 用于导出前一次性生成导板实体；实时预览不走这里。
import { MeshData } from '../mesh';
import { Vec3, v3, Plane, makePlane } from '../vec';

const EPS = 1e-5;

interface Vertex {
  pos: Vec3;
}

class CSGPlane {
  normal: Vec3;
  w: number; // n·p = w
  constructor(normal: Vec3, w: number) {
    this.normal = normal;
    this.w = w;
  }
  static fromPoints(a: Vec3, b: Vec3, c: Vec3): CSGPlane {
    const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    return new CSGPlane(n, v3.dot(n, a));
  }
  flip(): void {
    this.normal = v3.scale(this.normal, -1);
    this.w = -this.w;
  }
  clone(): CSGPlane {
    return new CSGPlane(v3.clone(this.normal), this.w);
  }
  splitPolygon(poly: Polygon, cf: Polygon[], cb: Polygon[], f: Polygon[], b: Polygon[]): void {
    const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
    let polyType = 0;
    const types: number[] = [];
    for (const vert of poly.vertices) {
      const t = v3.dot(this.normal, vert.pos) - this.w;
      const type = Math.abs(t) < EPS ? COPLANAR : t > 0 ? FRONT : BACK;
      types.push(type);
      polyType |= type;
    }
    switch (polyType) {
      case COPLANAR:
        if (v3.dot(this.normal, poly.plane.normal) > 0) cf.push(poly);
        else cb.push(poly);
        break;
      case FRONT:
        f.push(poly);
        break;
      case BACK:
        b.push(poly);
        break;
      case SPANNING: {
        const nf: Vertex[] = [];
        const nb: Vertex[] = [];
        const verts = poly.vertices;
        for (let i = 0; i < verts.length; i++) {
          const j = (i + 1) % verts.length;
          const ti = types[i], tj = types[j];
          const vi = verts[i], vj = verts[j];
          if (ti !== BACK) nf.push(vi);
          if (ti !== FRONT) nb.push(ti === BACK ? vi : { pos: vi.pos });
          if ((ti === FRONT && tj === BACK) || (ti === BACK && tj === FRONT)) {
            const t = (this.w - v3.dot(this.normal, vi.pos)) / v3.dot(this.normal, v3.sub(vj.pos, vi.pos));
            const p = v3.add(vi.pos, v3.scale(v3.sub(vj.pos, vi.pos), t));
            const nv: Vertex = { pos: p };
            nf.push(nv);
            nb.push({ pos: v3.clone(p) });
          }
        }
        if (nf.length >= 3) f.push(new Polygon(nf, poly.shared));
        if (nb.length >= 3) b.push(new Polygon(nb, poly.shared));
        break;
      }
    }
  }
}

class Polygon {
  vertices: Vertex[];
  plane: CSGPlane;
  shared?: unknown;
  constructor(vertices: Vertex[], shared?: unknown) {
    this.vertices = vertices;
    this.shared = shared;
    const positions = vertices.map((v) => v.pos);
    this.plane = CSGPlane.fromPoints(positions[0], positions[1], positions[2]);
  }
  flip(): void {
    this.vertices.reverse();
    this.plane.flip();
  }
}

class Node {
  plane: CSGPlane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];

  constructor(polygons?: Polygon[]) {
    if (polygons) this.build(polygons);
  }

  clone(): Node {
    const n = new Node();
    n.plane = this.plane;
    n.front = this.front?.clone() ?? null;
    n.back = this.back?.clone() ?? null;
    n.polygons = this.polygons.slice();
    return n;
  }

  invert(): void {
    for (const p of this.polygons) p.flip();
    this.plane?.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
  }

  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return polygons.slice();
    let front: Polygon[] = [];
    let back: Polygon[] = [];
    for (const poly of polygons) {
      this.plane.splitPolygon(poly, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    if (this.back) back = this.back.clipPolygons(back);
    else back = [];
    return front.concat(back);
  }

  clipTo(node: Node): void {
    this.polygons = node.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(node);
    if (this.back) this.back.clipTo(node);
  }

  allPolygons(): Polygon[] {
    let out = this.polygons.slice();
    if (this.front) out = out.concat(this.front.allPolygons());
    if (this.back) out = out.concat(this.back.allPolygons());
    return out;
  }

  build(polygons: Polygon[]): void {
    if (!polygons.length) return;
    if (!this.plane) this.plane = this.choosePlane(polygons).clone();
    const front: Polygon[] = [];
    const back: Polygon[] = [];
    for (const poly of polygons) {
      // 共面多边形必须留在本节点（this.polygons），否则会被无限递归切分
      this.plane.splitPolygon(poly, this.polygons, this.polygons, front, back);
    }
    if (front.length) {
      if (!this.front) this.front = new Node();
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node();
      this.back.build(back);
    }
  }

  /** 从若干候选面中挑选让前后数量最均衡的切分平面，避免规则扫掠网格把 BSP 退化成链表 */
  private choosePlane(polygons: Polygon[]): CSGPlane {
    if (polygons.length <= 24) return polygons[0].plane;
    const candidates: Polygon[] = [polygons[0]];
    const tries = 11;
    for (let k = 1; k <= tries; k++) {
      candidates.push(polygons[Math.floor((k / (tries + 1)) * polygons.length)]);
    }
    let best = polygons[0].plane;
    let bestScore = Infinity;
    for (const cand of candidates) {
      let f = 0, b = 0, span = 0;
      for (const poly of polygons) {
        let hasF = false, hasB = false;
        for (const v of poly.vertices) {
          const t = v3.dot(cand.plane.normal, v.pos) - cand.plane.w;
          if (t > EPS) hasF = true;
          else if (t < -EPS) hasB = true;
        }
        if (hasF && hasB) span++;
        else if (hasF) f++;
        else if (hasB) b++;
      }
      // 跨度面代价高（会被切分），其次要求两侧均衡且最大侧尽量小
      const score = span * 8 + Math.max(f, b) + Math.abs(f - b) * 0.1;
      if (score < bestScore) { bestScore = score; best = cand.plane; }
    }
    return best;
  }
}

export class CSG {
  polygons: Polygon[];
  constructor(polygons: Polygon[]) {
    this.polygons = polygons;
  }

  static fromMesh(m: MeshData): CSG {
    const polys: Polygon[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const ia = m.indices[t] * 3, ib = m.indices[t + 1] * 3, ic = m.indices[t + 2] * 3;
      const verts: Vertex[] = [
        { pos: [m.positions[ia], m.positions[ia + 1], m.positions[ia + 2]] },
        { pos: [m.positions[ib], m.positions[ib + 1], m.positions[ib + 2]] },
        { pos: [m.positions[ic], m.positions[ic + 1], m.positions[ic + 2]] },
      ];
      polys.push(new Polygon(verts));
    }
    return new CSG(polys);
  }

  static fromPolygons(polys: Polygon[]): CSG {
    return new CSG(polys);
  }

  subtract(cutter: CSG): CSG {
    const a = new Node(this.polygons);
    const b = new Node(cutter.polygons);
    a.invert();
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    b.invert();
    a.build(b.allPolygons());
    a.invert();
    return CSG.fromPolygons(a.allPolygons());
  }

  union(other: CSG): CSG {
    const a = new Node(this.polygons);
    const b = new Node(other.polygons);
    a.clipTo(b);
    b.clipTo(a);
    b.invert();
    b.clipTo(a);
    a.build(b.allPolygons());
    return CSG.fromPolygons(a.allPolygons());
  }

  toMesh(name = 'csg'): MeshData {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const poly of this.polygons) {
      const base = positions.length / 3;
      for (const v of poly.vertices) positions.push(v.pos[0], v.pos[1], v.pos[2]);
      // 扇形三角化
      for (let i = 1; i < poly.vertices.length - 1; i++) {
        indices.push(base, base + i, base + i + 1);
      }
    }
    return { name, positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  }
}

/** 便捷：对 base 依次减去多个切割体网格 */
export function meshSubtractAll(base: MeshData, cutters: MeshData[], onProgress?: (msg: string) => void): MeshData {
  let csg = CSG.fromMesh(base);
  for (let i = 0; i < cutters.length; i++) {
    onProgress?.(`网格布尔 ${i + 1}/${cutters.length}`);
    const c = CSG.fromMesh(cutters[i]);
    csg = csg.subtract(c);
  }
  return csg.toMesh(base.name + '-guide');
}
