// 截骨平面操纵器线框、平面填充、缝隙彩色圆盘等几何构造。
import { CutPlaneSpec, JointGap } from '../core/types';
import { Vec3, v3, planeBasis, Mat4 } from '../core/vec';
import { MeshData, buildMesh } from '../core/mesh';

/** 单位 XY 平面（法线 +Z）的四边形 MeshData，多平面共用，靠矩阵定位 */
export function unitQuadMesh(): MeshData {
  return buildMesh('unit-quad', [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], [0, 1, 2, 0, 2, 3]);
}

/** 以 u/v/n 为列、center 为平移，并在 u/v 方向缩放的刚体矩阵 */
export function basisMatrix(u: Vec3, v: Vec3, n: Vec3, center: Vec3, su: number, sv: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = u[0] * su; m[1] = u[1] * su; m[2] = u[2] * su; m[3] = 0;
  m[4] = v[0] * sv; m[5] = v[1] * sv; m[6] = v[2] * sv; m[7] = 0;
  m[8] = n[0]; m[9] = n[1]; m[10] = n[2]; m[11] = 0;
  m[12] = center[0]; m[13] = center[1]; m[14] = center[2]; m[15] = 1;
  return m;
}

/** 平面边框 + 法向手柄 + 半透明填充面（返回线顶点与填充网格） */
export function planeGizmo(pl: CutPlaneSpec, size = 22): { linePositions: number[]; fill: MeshData } {
  const { u, v, n } = planeBasis(pl.normal);
  const c = pl.point;
  const corners: Vec3[] = [
    v3.add(v3.add(c, v3.scale(u, -size)), v3.scale(v, -size * 0.7)),
    v3.add(v3.add(c, v3.scale(u, size)), v3.scale(v, -size * 0.7)),
    v3.add(v3.add(c, v3.scale(u, size)), v3.scale(v, size * 0.7)),
    v3.add(v3.add(c, v3.scale(u, -size)), v3.scale(v, size * 0.7)),
  ];
  const lp: number[] = [];
  const seg = (a: Vec3, b: Vec3) => lp.push(...a, ...b);
  for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4]);
  // 法向箭头
  const tip = v3.add(c, v3.scale(n, size * 1.15));
  seg(c, tip);
  const ah = size * 0.18;
  seg(tip, v3.add(v3.add(tip, v3.scale(n, -ah)), v3.scale(u, ah * 0.6)));
  seg(tip, v3.add(v3.add(tip, v3.scale(n, -ah)), v3.scale(u, -ah * 0.6)));
  // 中心十字
  seg(v3.add(c, v3.scale(u, -2)), v3.add(c, v3.scale(u, 2)));
  seg(v3.add(c, v3.scale(v, -2)), v3.add(c, v3.scale(v, 2)));

  const fill = buildMesh('plane-fill',
    [
      ...corners[0], ...corners[1], ...corners[2], ...corners[3],
    ],
    [0, 1, 2, 0, 2, 3],
  );
  return { linePositions: lp, fill };
}

/** 用两个正交圆环做旋转手柄 */
export function rotationRings(pl: CutPlaneSpec, radius = 26): number[] {
  const { u, v, n } = planeBasis(pl.normal);
  const out: number[] = [];
  const N = 48;
  const ring = (a: Vec3, b: Vec3) => {
    let prev: Vec3 | null = null;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const p = v3.add(pl.point, v3.add(v3.scale(a, Math.cos(t) * radius), v3.scale(b, Math.sin(t) * radius)));
      if (prev) out.push(...prev, ...p);
      prev = p;
    }
  };
  ring(u, v);
  ring(u, n);
  return out;
}

/** 关节缝隙彩色接触斑（带逐顶点颜色的圆盘） */
export function gapDiscMesh(gap: JointGap): MeshData {
  const R = gap.discRadius;
  const { u, v } = planeBasis(gap.discNormal);
  const c = gap.discCenter;
  const positions: number[] = [...c];
  const colors: number[] = [...gap.color];
  const SEG = 40;
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const rr = i === SEG ? R : R;
    const p = v3.add(c, v3.add(v3.scale(u, Math.cos(a) * rr), v3.scale(v, Math.sin(a) * rr)));
    positions.push(...p);
    // 边缘按缝隙大小稍微变深
    const edge = 0.85;
    colors.push(gap.color[0] * edge, gap.color[1] * edge, gap.color[2] * edge);
  }
  const indices: number[] = [];
  for (let i = 1; i <= SEG; i++) indices.push(0, i, i + 1);
  return buildMesh('gap-disc', positions, indices, colors);
}

/** 高亮球/点集合（神经管被切位置、扫查命中点） */
export function markerPoints(name: string, points: Vec3[], color: Vec3 = [1, 0.8, 0]): MeshData {
  // 用小八面体合并表示标记
  const pos: number[] = [];
  const idx: number[] = [];
  for (const c of points) {
    const r = 2.2;
    const base = pos.length / 3;
    const verts: Vec3[] = [
      v3.add(c, [r, 0, 0]), v3.add(c, [-r, 0, 0]),
      v3.add(c, [0, r, 0]), v3.add(c, [0, -r, 0]),
      v3.add(c, [0, 0, r]), v3.add(c, [0, 0, -r]),
    ];
    for (const x of verts) pos.push(...x);
    const faces = [
      [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
      [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
    ];
    for (const f of faces) idx.push(base + f[0], base + f[1], base + f[2]);
  }
  const m = buildMesh(name, pos, idx);
  const colors = new Float32Array((pos.length / 3) * 3);
  for (let i = 0; i < pos.length / 3; i++) colors.set(color, i * 3);
  m.colors = colors;
  return m;
}
