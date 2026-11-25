// 基础三维数学：Vec3 / Mat4 / 平面 / 射线。全部使用毫米单位。
// 刻意保持无 DOM 依赖，方便在 Node (vitest) 中直接验证精度。

export type Vec3 = [number, number, number];

export const v3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return [x, y, z];
  },
  clone(a: Vec3): Vec3 {
    return [a[0], a[1], a[2]];
  },
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
  },
  mulAdd(a: Vec3, b: Vec3, s: number): Vec3 {
    return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  },
  dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  },
  len(a: Vec3): number {
    return Math.hypot(a[0], a[1], a[2]);
  },
  dist(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  dist2(a: Vec3, b: Vec3): number {
    const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return x * x + y * y + z * z;
  },
  norm(a: Vec3): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-12) return [0, 1, 0];
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  },
  min(a: Vec3, b: Vec3): Vec3 {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  },
  max(a: Vec3, b: Vec3): Vec3 {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  },
  absMax(a: Vec3): number {
    return Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
  },
  equals(a: Vec3, b: Vec3, eps = 1e-9): boolean {
    return v3.dist2(a, b) <= eps * eps;
  },
};

/** 由法线 n 与平面上一点 p 定义平面: n·x + d = 0 */
export interface Plane {
  n: Vec3;
  p: Vec3;
  d: number;
}

export function makePlane(p: Vec3, normal: Vec3): Plane {
  const n = v3.norm(normal);
  return { n, p: v3.clone(p), d: -v3.dot(n, p) };
}

export function planeSignedDistance(pl: Plane, x: Vec3): number {
  return pl.n[0] * x[0] + pl.n[1] * x[1] + pl.n[2] * x[2] + pl.d;
}

/** 两平面夹角（度，取锐角 0..90） */
export function planeAngleDeg(a: Plane, b: Plane): number {
  const c = Math.min(1, Math.abs(v3.dot(a.n, b.n)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** 两平面的偏移：b 原点到 a 平面的有符号距离绝对值（要求近平行） */
export function planeOffset(a: Plane, b: Plane): number {
  return Math.abs(planeSignedDistance(a, b.p));
}

/** 平面的局部正交基 (u,v,n) */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3; n: Vec3 } {
  const nn = v3.norm(n);
  const ref = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] as Vec3 : [1, 0, 0] as Vec3;
  const u = v3.norm(v3.cross(ref, nn));
  const v = v3.cross(nn, u);
  return { u, v, n: nn };
}

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

export function rayFromTargets(origin: Vec3, target: Vec3): Ray {
  return { origin: v3.clone(origin), dir: v3.norm(v3.sub(target, origin)) };
}

export function rayPoint(r: Ray, t: number): Vec3 {
  return v3.mulAdd(r.origin, r.dir, t);
}

/** 射线与平面交点参数 t，无交返回 null */
export function rayPlane(r: Ray, pl: Plane): number | null {
  const denom = v3.dot(pl.n, r.dir);
  if (Math.abs(denom) < 1e-9) return null;
  const t = -(v3.dot(pl.n, r.origin) + pl.d) / denom;
  return t;
}

/** 射线与无限直线（轴 a + t*dir）最近点参数，返回射线上 t 与轴上 s */
export function rayAxisClosest(r: Ray, a: Vec3, axis: Vec3): { tr: number; ta: number } {
  const u = v3.norm(axis);
  const w0 = v3.sub(r.origin, a);
  const b = v3.dot(u, r.dir);
  const d = v3.dot(u, w0);
  const e = v3.dot(r.dir, w0);
  const denom = 1 - b * b;
  if (denom < 1e-10) {
    return { tr: -e, ta: d + b * -e };
  }
  const tr = (b * d - e) / denom;
  const ta = d + b * tr;
  return { tr, ta };
}

// ---------------- Mat4 (列主序, 与 WebGL 一致) ----------------

export type Mat4 = Float32Array;

export const m4 = {
  create(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  identity(): Mat4 {
    return m4.create();
  },
  translation(x: number, y: number, z: number): Mat4 {
    const m = m4.create();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  },
  fromTranslation(v: Vec3): Mat4 {
    return m4.translation(v[0], v[1], v[2]);
  },
  scaling(x: number, y: number, z: number): Mat4 {
    const m = m4.create();
    m[0] = x; m[5] = y; m[10] = z;
    return m;
  },
  multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },
  perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },
  ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
    const out = m4.create();
    out[0] = 2 / (r - l);
    out[5] = 2 / (t - b);
    out[10] = -2 / (f - n);
    out[12] = -(r + l) / (r - l);
    out[13] = -(t + b) / (t - b);
    out[14] = -(f + n) / (f - n);
    return out;
  },
  lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let len = Math.hypot(z0, z1, z2);
    if (len === 0) { z2 = 1; } else { z0 /= len; z1 /= len; z2 /= len; }
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len === 0) { x0 = 1; x1 = 0; x2 = 0; } else { x0 /= len; x1 /= len; x2 /= len; }
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    const out = new Float32Array(16);
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
  },
  /** 绕任意轴旋转 */
  fromAxisAngle(axis: Vec3, rad: number): Mat4 {
    const a = v3.norm(axis);
    const x = a[0], y = a[1], z = a[2];
    const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
    const out = m4.create();
    out[0] = t * x * x + c;
    out[1] = t * x * y + s * z;
    out[2] = t * x * z - s * y;
    out[4] = t * x * y - s * z;
    out[5] = t * y * y + c;
    out[6] = t * y * z + s * x;
    out[8] = t * x * z + s * y;
    out[9] = t * y * z - s * x;
    out[10] = t * z * z + c;
    return out;
  },
  rotationX(rad: number): Mat4 {
    const c = Math.cos(rad), s = Math.sin(rad);
    const m = m4.create();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  },
  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
  transformDir(m: Mat4, p: Vec3): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    return [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
  },
  /** 法线矩阵（刚体变换下直接取旋转部分即可，这里给完整逆转置） */
  normalMat3(m: Mat4): Float32Array {
    // 求逆再转置的 3x3
    const a = m;
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    det = 1 / det;
    const inv = new Float32Array(9);
    inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    inv[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    inv[2] = (a10 * b10 - a11 * b08 + a12 * b07) * det;
    inv[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    inv[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    inv[5] = (a01 * b08 - a00 * b10 - a02 * b07) * det;
    inv[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    inv[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    inv[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    // 转置输出（列主序 mat3 给 uniformMatrix3fv）
    return new Float32Array([inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]);
  },
};

/** 射线 vs 三角形（Möller–Trumbore），返回 t 或 null */
export function rayTriangle(
  r: Ray,
  a: Vec3, b: Vec3, c: Vec3,
): number | null {
  const eps = 1e-9;
  const e1 = v3.sub(b, a);
  const e2 = v3.sub(c, a);
  const p = v3.cross(r.dir, e2);
  const det = v3.dot(e1, p);
  if (det > -eps && det < eps) return null;
  const invDet = 1 / det;
  const tv = v3.sub(r.origin, a);
  const u = v3.dot(tv, p) * invDet;
  if (u < 0 || u > 1) return null;
  const q = v3.cross(tv, e1);
  const v = v3.dot(r.dir, q) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = v3.dot(e2, q) * invDet;
  return t > eps ? t : null;
}

export interface Box3 { min: Vec3; max: Vec3 }

export const box3 = {
  empty(): Box3 {
    return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  },
  includePoint(b: Box3, p: Vec3): void {
    for (let i = 0; i < 3; i++) {
      if (p[i] < b.min[i]) b.min[i] = p[i];
      if (p[i] > b.max[i]) b.max[i] = p[i];
    }
  },
  center(b: Box3): Vec3 {
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  },
  size(b: Box3): Vec3 {
    return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  },
  isEmpty(b: Box3): boolean {
    return !isFinite(b.min[0]);
  },
};

/** 角度转弧度 */
export const rad = (deg: number) => (deg * Math.PI) / 180;
export const deg = (r: number) => (r * 180) / Math.PI;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
