// 程序化生成测试用解剖模型（单位 mm）：
// 左右侧下颌骨（马蹄形体部 + 升支 + 髁突）、腓骨、肿瘤、下牙槽神经管，
// 以及一个人为注入破洞和翻转面的“问题腓骨”。
import { MeshData, buildMesh, mergeMeshes } from './mesh';
import { Vec3, v3 } from './vec';

// ---------------- 通用扫掠管 ----------------

interface SweepOptions {
  radialSegments?: number;
  radiusA: number | ((t: number) => number); // 第一标架方向半径
  radiusB: number | ((t: number) => number); // 第二标架方向半径
  threeLobe?: number; // 腓骨三棱截面强度
  cap?: boolean;
}

function radAt(r: number | ((t: number) => number), t: number): number {
  return typeof r === 'function' ? r(t) : r;
}

export function sweepTube(name: string, points: Vec3[], opts: SweepOptions): MeshData {
  const R = opts.radialSegments ?? 18;
  const n = points.length;
  const positions: number[] = [];
  const indices: number[] = [];
  let prevSide: Vec3 | null = null;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = points[i];
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[Math.min(n - 1, i + 1)];
    const tangent = v3.norm(v3.sub(p1, p0));
    // 稳健标架：优先用世界 Y 作为参考，升支段切线接近 Y 时换 Z
    const ref = Math.abs(tangent[1]) > 0.92 ? ([0, 0, 1] as Vec3) : ([0, 1, 0] as Vec3);
    let side = v3.norm(v3.cross(tangent, ref));
    if (prevSide && v3.dot(side, prevSide) < 0) side = v3.scale(side, -1);
    prevSide = side;
    const up2 = v3.cross(side, tangent);
    const ra = radAt(opts.radiusA, t);
    const rb = radAt(opts.radiusB, t);
    for (let j = 0; j < R; j++) {
      const a = (j / R) * Math.PI * 2;
      let mod = 1;
      if (opts.threeLobe) mod = 1 + opts.threeLobe * Math.cos(3 * a + 0.6);
      const ca = Math.cos(a) * ra * mod;
      const sa = Math.sin(a) * rb * mod;
      positions.push(
        p[0] + side[0] * ca + up2[0] * sa,
        p[1] + side[1] * ca + up2[1] * sa,
        p[2] + side[2] * ca + up2[2] * sa,
      );
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * R + j;
      const b = i * R + (j + 1) % R;
      const c = (i + 1) * R + j;
      const d = (i + 1) * R + (j + 1) % R;
      indices.push(a, c, b, b, c, d);
    }
  }
  if (opts.cap !== false) {
    // 两端盖
    const startCenter = positions.length / 3;
    positions.push(...points[0]);
    for (let j = 0; j < R; j++) indices.push(startCenter, (j + 1) % R, j);
    const endCenter = positions.length / 3;
    positions.push(...points[n - 1]);
    const base = (n - 1) * R;
    for (let j = 0; j < R; j++) indices.push(endCenter, base + j, base + (j + 1) % R);
  }
  return buildMesh(name, positions, indices);
}

// ---------------- 下颌弓参数 ----------------

export const ARCH = {
  width: 48, // 左右半宽
  zBase: -10,
  zDepth: 65, // 颏部前伸
  phiMax: 1.72, // 体部末端（下颌角附近）
  bodyY: 0,
};

/** 下颌体马蹄弓上的点；phi=0 为颏部，正负为左右侧 */
export function archPoint(phi: number): Vec3 {
  return [
    ARCH.width * Math.sin(phi),
    ARCH.bodyY + 1.5 * Math.cos(phi * 2),
    ARCH.zBase + ARCH.zDepth * Math.cos(phi),
  ];
}

export function archTangent(phi: number): Vec3 {
  const e = 0.001;
  return v3.norm(v3.sub(archPoint(phi + e), archPoint(phi - e)));
}

/** 颊舌向（弓平面法向的水平标架） */
export function archSide(phi: number): Vec3 {
  const t = archTangent(phi);
  return v3.norm(v3.cross(t, [0, 1, 0]));
}

/** 完整下颌骨路径：左髁突 -> 左升支 -> 下颌体 -> 右升支 -> 右髁突 */
function mandiblePath(): Vec3[] {
  const pts: Vec3[] = [];
  // 左升支（从上到下）
  const leftRamus: Vec3[] = [
    [-43, 58, -33], // 髁突顶
    [-46, 50, -30],
    [-48, 38, -27],
    [-49.5, 24, -23],
    [-50, 10, -19],
    [-49, -4, -16.5], // 下颌角
  ];
  pts.push(...leftRamus);
  // 体部：phi 从 -phiMax 到 +phiMax
  const SAMPLES = 96;
  for (let i = 0; i <= SAMPLES; i++) {
    const phi = -ARCH.phiMax + (2 * ARCH.phiMax * i) / SAMPLES;
    pts.push(archPoint(phi));
  }
  // 右升支（从下到上，镜像）
  const rightRamus: Vec3[] = [
    [49, -4, -16.5],
    [50, 10, -19],
    [49.5, 24, -23],
    [48, 38, -27],
    [46, 50, -30],
    [43, 58, -33],
  ];
  pts.push(...rightRamus);
  return pts;
}

export function generateMandible(): MeshData {
  const path = mandiblePath();
  const nBody = 97; // 与上面 SAMPLES+1 对齐
  const leftRamusLen = 6;
  const mesh = sweepTube('mandible', path, {
    radialSegments: 22,
    radiusA: (t) => {
      // t 为整条路径参数；体部约在中间段
      const idx = Math.round(t * (path.length - 1));
      if (idx < leftRamusLen || idx > leftRamusLen + nBody - 1) {
        // 升支：前后向宽（第二半径大），内外侧薄
        return 7.5 + 2 * Math.sin(t * Math.PI);
      }
      // 体部颊舌向厚度
      return 8.5 + 1.2 * Math.cos((t - 0.5) * Math.PI * 2);
    },
    radiusB: (t) => {
      const idx = Math.round(t * (path.length - 1));
      if (idx < leftRamusLen || idx > leftRamusLen + nBody - 1) {
        // 升支前后径宽，髁突处膨大
        const top = idx < leftRamusLen ? leftRamusLen - idx : idx - (leftRamusLen + nBody - 1);
        return 15 + top * 1.6;
      }
      // 体部上下高度
      return 13.5 + 1.5 * Math.cos(t * Math.PI * 2);
    },
  });
  mesh.name = '下颌骨';
  return mesh;
}

// ---------------- 肿瘤（噪声二十面体球） ----------------

export function generateTumor(center?: Vec3, radius = 17, seed = 7): MeshData {
  const ico = icosphere(2);
  let positions = ico.positions as Float32Array;
  const c = center ?? archPoint(-0.55);
  // 确定性伪噪声
  const rand = mulberry32(seed);
  const displace = new Map<number, number>();
  const p = positions.slice();
  for (let i = 0; i < p.length; i += 3) {
    const dir = v3.norm([p[i], p[i + 1], p[i + 2]]);
    const key = Math.round(dir[0] * 20) * 1000 + Math.round(dir[1] * 20) * 100 + Math.round(dir[2] * 20);
    let d = displace.get(key);
    if (d === undefined) { d = 0.72 + rand() * 0.55; displace.set(key, d); }
    const r = radius * d;
    p[i] = c[0] + dir[0] * r;
    p[i + 1] = c[1] - 2 + dir[1] * r * 0.92;
    p[i + 2] = c[2] + 4 + dir[2] * r * 0.9;
  }
  const m = buildMesh('肿瘤', p, ico.indices);
  return m;
}

/** 肿瘤默认中心：某一侧体部、略偏颊侧 */
export function defaultTumorCenter(side: 'left' | 'right'): Vec3 {
  const phi = side === 'left' ? -0.62 : 0.62;
  const ap = archPoint(phi);
  const sd = archSide(phi);
  return v3.add(ap, v3.scale(sd, 9));
}

// ---------------- 下牙槽神经管（左右各一） ----------------

export function generateNerve(): MeshData {
  const tubes: MeshData[] = [];
  for (const side of [-1, 1]) {
    const pts: Vec3[] = [];
    const phi0 = side * 1.5;
    const phi1 = side * 0.28;
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const phi = phi0 + (phi1 - phi0) * (i / N);
      const a = archPoint(phi);
      // 神经管位于体部中偏下、偏舌侧
      const sd = archSide(phi);
      pts.push([a[0] - sd[0] * 1.5, a[1] - 3.5, a[2] - sd[2] * 1.5]);
    }
    tubes.push(sweepTube(side < 0 ? '左下牙槽神经' : '右下牙槽神经', pts, {
      radialSegments: 10, radiusA: 1.7, radiusB: 1.7,
    }));
  }
  return mergeMeshes(tubes, '下牙槽神经管');
}

// ---------------- 腓骨 ----------------

export const FIBULA_LENGTH = 330;
export const DISTAL_RESERVE_MM = 60; // 远端保踝 6cm

export function fibulaPoint(t: number): Vec3 {
  // 沿 X 轴 -L/2..L/2，带轻微生理弯曲
  const x = -FIBULA_LENGTH / 2 + t * FIBULA_LENGTH;
  const bow = 5 * Math.sin(t * Math.PI); // 中点弯曲
  return [x, bow, 2.5 * Math.sin(t * Math.PI * 1.4)];
}

export function generateFibula(): MeshData {
  const N = 120;
  const pts: Vec3[] = [];
  for (let i = 0; i < N; i++) pts.push(fibulaPoint(i / (N - 1)));
  const m = sweepTube('腓骨', pts, {
    radialSegments: 20,
    threeLobe: 0.1,
    radiusA: (t) => {
      let r = 6.2 + 0.8 * Math.sin(t * Math.PI * 2);
      if (t < 0.07) r += (1 - t / 0.07) * 6.5; // 腓骨头膨大
      if (t > 0.9) r += ((t - 0.9) / 0.1) * 4.5; // 外踝端膨大
      return r;
    },
    radiusB: (t) => {
      let r = 7.2 + 0.6 * Math.cos(t * Math.PI * 2);
      if (t < 0.07) r += (1 - t / 0.07) * 5;
      if (t > 0.9) r += ((t - 0.9) / 0.1) * 5.5;
      return r;
    },
  });
  m.name = '腓骨';
  return m;
}

/** 生成带破洞 + 翻转面的“问题腓骨”，并返回注入缺陷的说明 */
export function generateBrokenFibula(): { mesh: MeshData; injected: string[] } {
  const src = generateFibula();
  const m: MeshData = {
    ...src,
    positions: new Float32Array(src.positions),
    indices: new Uint32Array(src.indices),
  };
  const injected: string[] = [];
  const p = m.positions;
  const triCount = m.indices.length / 3;

  // 1) 挖 3 个洞：删除中心落在指定球内的三角形
  const holes: { c: Vec3; r: number }[] = [
    { c: [-40, 2, 1], r: 8.5 },
    { c: [35, 3, 0], r: 7.5 },
    { c: [95, 4, 2], r: 9 },
  ];
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = m.indices[t * 3] * 3;
    const ib = m.indices[t * 3 + 1] * 3;
    const ic = m.indices[t * 3 + 2] * 3;
    const cx = (p[ia] + p[ib] + p[ic]) / 3;
    const cy = (p[ia + 1] + p[ib + 1] + p[ic + 1]) / 3;
    const cz = (p[ia + 2] + p[ib + 2] + p[ic + 2]) / 3;
    let inHole = false;
    for (const h of holes) {
      if (Math.hypot(cx - h.c[0], cy - h.c[1], cz - h.c[2]) < h.r) { inHole = true; break; }
    }
    if (inHole) { removed++; continue; }
    kept.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]);
  }
  m.indices = Uint32Array.from(kept);
  injected.push(`注入 3 处破洞（删除 ${removed} 个三角面）`);

  // 2) 翻转一块连续区域的三角形绕向（位置不动，交换索引）
  let flipped = 0;
  const target: Vec3 = [10, 5, 0];
  for (let t = 0; t < m.indices.length; t += 3) {
    const ia = m.indices[t] * 3;
    const ib = m.indices[t + 1] * 3;
    const ic = m.indices[t + 2] * 3;
    const cx = (p[ia] + p[ib] + p[ic]) / 3;
    const cy = (p[ia + 1] + p[ib + 1] + p[ic + 1]) / 3;
    const cz = (p[ia + 2] + p[ib + 2] + p[ic + 2]) / 3;
    if (Math.hypot(cx - target[0], cy - target[1], cz - target[2]) < 16) {
      const tmp = m.indices[t + 1];
      m.indices[t + 1] = m.indices[t + 2];
      m.indices[t + 2] = tmp;
      flipped++;
    }
  }
  injected.push(`翻转 ${flipped} 个三角面的绕向（法线朝内）`);
  m.name = '问题腓骨(带破洞翻转面)';
  return { mesh: m, injected };
}

// ---------------- 二十面体球 ----------------

function icosphere(detail: number): { positions: Float32Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => v3.norm(v as Vec3));
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const midCache = new Map<string, number>();
    const nextFaces: number[][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const m = v3.norm(v3.scale(v3.add(verts[a], verts[b]), 0.5));
      verts.push(m);
      const idx = verts.length - 1;
      midCache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => positions.set(v, i * 3));
  const indices = Uint32Array.from(faces.flat());
  return { positions, indices };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
