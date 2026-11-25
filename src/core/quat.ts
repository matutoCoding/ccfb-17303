// 最小四元数工具（xyzw）与 Mat4 互转。
import { Vec3, Mat4, m4, v3 } from './vec';

export type Quat = [number, number, number, number];

export const q = {
  identity(): Quat {
    return [0, 0, 0, 1];
  },
  clone(a: Quat): Quat {
    return [a[0], a[1], a[2], a[3]];
  },
  fromAxisAngle(axis: Vec3, rad: number): Quat {
    const n = v3.norm(axis);
    const s = Math.sin(rad / 2);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)];
  },
  /** 把单位向量 a 旋转到单位向量 b 的最短弧四元数 */
  fromVectors(a: Vec3, b: Vec3): Quat {
    const na = v3.norm(a), nb = v3.norm(b);
    let dot = v3.dot(na, nb);
    if (dot < -0.999999) {
      const ref = Math.abs(na[0]) < 0.9 ? ([1, 0, 0] as Vec3) : ([0, 1, 0] as Vec3);
      const axis = v3.norm(v3.cross(na, ref));
      return q.fromAxisAngle(axis, Math.PI);
    }
    const cr = v3.cross(na, nb);
    const qq: Quat = [cr[0], cr[1], cr[2], 1 + dot];
    const l = Math.hypot(qq[0], qq[1], qq[2], qq[3]);
    return [qq[0] / l, qq[1] / l, qq[2] / l, qq[3] / l];
  },
  multiply(a: Quat, b: Quat): Quat {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  rotateVec(qq: Quat, p: Vec3): Vec3 {
    // q * p * q^-1 的展开
    const [x, y, z, w] = qq;
    const vx = p[0], vy = p[1], vz = p[2];
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [
      vx + w * tx + (y * tz - z * ty),
      vy + w * ty + (z * tx - x * tz),
      vz + w * tz + (x * ty - y * tx),
    ];
  },
  toMat4(qq: Quat): Mat4 {
    const [x, y, z, w] = qq;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const out = m4.create();
    out[0] = 1 - (yy + zz);
    out[1] = xy + wz;
    out[2] = xz - wy;
    out[4] = xy - wz;
    out[5] = 1 - (xx + zz);
    out[6] = yz + wx;
    out[8] = xz + wy;
    out[9] = yz - wx;
    out[10] = 1 - (xx + yy);
    return out;
  },
  fromEuler(x: number, y: number, z: number): Quat {
    const qx = q.fromAxisAngle([1, 0, 0], x);
    const qy = q.fromAxisAngle([0, 1, 0], y);
    const qz = q.fromAxisAngle([0, 0, 1], z);
    return q.multiply(qz, q.multiply(qy, qx));
  },
};

/** 段的完整模型矩阵：平移(offset+baseCenter) × 手动四元数 × X轴->baseAxis */
export function segmentMatrix(
  baseCenter: Vec3,
  baseAxis: Vec3,
  offset: Vec3,
  quatAdjust: Quat,
): Mat4 {
  const baseQ = q.fromVectors([1, 0, 0], baseAxis);
  const rotQ = q.multiply(quatAdjust, baseQ);
  const r = q.toMat4(rotQ);
  const c = v3.add(baseCenter, offset);
  r[12] = c[0];
  r[13] = c[1];
  r[14] = c[2];
  return r;
}

export function segmentCurrentAxis(baseAxis: Vec3, quatAdjust: Quat): Vec3 {
  return v3.norm(q.rotateVec(quatAdjust, baseAxis));
}
