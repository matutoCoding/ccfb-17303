// 参数化基本体：有向盒（锯槽切割体）、圆柱（钉孔）。
import { MeshData, buildMesh } from './mesh';
import { Vec3 } from './vec';

export interface OBB {
  center: Vec3;
  axes: [Vec3, Vec3, Vec3]; // u,v,n 正交单位轴
  half: Vec3; // 三个方向半长
}

export function makeOBBMesh(name: string, obb: OBB): MeshData {
  const { center, axes, half } = obb;
  const [u, v, n] = axes;
  const signs: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const positions: number[] = [];
  for (const [su, sv, sn] of signs) {
    positions.push(
      center[0] + u[0] * su * half[0] + v[0] * sv * half[1] + n[0] * sn * half[2],
      center[1] + u[1] * su * half[0] + v[1] * sv * half[1] + n[1] * sn * half[2],
      center[2] + u[2] * su * half[0] + v[2] * sv * half[1] + n[2] * sn * half[2],
    );
  }
  // 六个面（朝外绕向）
  const faces = [
    [0, 3, 2, 1], // -n
    [4, 5, 6, 7], // +n
    [0, 1, 5, 4], // -v
    [3, 7, 6, 2], // +v
    [1, 2, 6, 5], // +u
    [0, 4, 7, 3], // -u
  ];
  const indices: number[] = [];
  for (const f of faces) indices.push(f[0], f[1], f[2], f[0], f[2], f[3]);
  return buildMesh(name, positions, indices);
}

export function makeCylinderMesh(
  name: string,
  center: Vec3,
  axis: Vec3,
  radius: number,
  length: number,
  segments = 24,
): MeshData {
  const nAxis = axis;
  const ref = Math.abs(nAxis[1]) < 0.9 ? ([0, 1, 0] as Vec3) : ([1, 0, 0] as Vec3);
  const u = norm(cross(ref, nAxis));
  const vv = cross(nAxis, u);
  const positions: number[] = [];
  const indices: number[] = [];
  const h = length / 2;
  for (let end = 0; end < 2; end++) {
    const along = end === 0 ? -h : h;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const ca = Math.cos(a) * radius, sa = Math.sin(a) * radius;
      positions.push(
        center[0] + nAxis[0] * along + u[0] * ca + vv[0] * sa,
        center[1] + nAxis[1] * along + u[1] * ca + vv[1] * sa,
        center[2] + nAxis[2] * along + u[2] * ca + vv[2] * sa,
      );
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i, b = (i + 1) % segments;
    const c = segments + i, d = segments + ((i + 1) % segments);
    indices.push(a, c, b, b, c, d);
  }
  const c0 = positions.length / 3;
  positions.push(center[0] - nAxis[0] * h, center[1] - nAxis[1] * h, center[2] - nAxis[2] * h);
  for (let i = 0; i < segments; i++) indices.push(c0, (i + 1) % segments, i);
  const c1 = positions.length / 3;
  positions.push(center[0] + nAxis[0] * h, center[1] + nAxis[1] * h, center[2] + nAxis[2] * h);
  for (let i = 0; i < segments; i++) indices.push(c1, segments + i, segments + ((i + 1) % segments));
  return buildMesh(name, positions, indices);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
