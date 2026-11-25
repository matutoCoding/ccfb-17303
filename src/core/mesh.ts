// 统一网格数据结构与常用几何工具。核心模块不依赖 DOM/WebGL，可在 Node 测试中运行。
import { Vec3, v3, Mat4, box3, Box3 } from './vec';

export interface MeshData {
  id?: string;
  name: string;
  positions: Float32Array; // 顶点坐标 V*3
  indices: Uint32Array; // 三角形索引 T*3
  normals?: Float32Array; // 顶点法线 V*3
  colors?: Float32Array; // 顶点颜色 rgb V*3
  /** 标记哪些三角形被翻转（用于演示坏模型 / 检查结果） */
  flippedTris?: Uint8Array;
}

export function triangleCount(m: MeshData): number {
  return m.indices.length / 3;
}
export function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

export function cloneMesh(m: MeshData): MeshData {
  return {
    id: m.id,
    name: m.name,
    positions: new Float32Array(m.positions),
    indices: new Uint32Array(m.indices),
    normals: m.normals ? new Float32Array(m.normals) : undefined,
    colors: m.colors ? new Float32Array(m.colors) : undefined,
    flippedTris: m.flippedTris ? new Uint8Array(m.flippedTris) : undefined,
  };
}

/** 面积加权顶点法线 */
export function computeVertexNormals(m: MeshData): Float32Array {
  const n = m.positions.length;
  const normals = new Float32Array(n);
  const p = m.positions;
  const idx = m.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
    const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < n; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-12) {
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    } else {
      normals[i + 1] = 1;
    }
  }
  m.normals = normals;
  return normals;
}

export function getTriangleVerts(m: MeshData, t: number): [Vec3, Vec3, Vec3] {
  const i = t * 3;
  const ia = m.indices[i] * 3, ib = m.indices[i + 1] * 3, ic = m.indices[i + 2] * 3;
  const p = m.positions;
  return [
    [p[ia], p[ia + 1], p[ia + 2]],
    [p[ib], p[ib + 1], p[ib + 2]],
    [p[ic], p[ic + 1], p[ic + 2]],
  ];
}

export function triangleNormal(m: MeshData, t: number): Vec3 {
  const [a, b, c] = getTriangleVerts(m, t);
  return v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
}

export function boundingBox(m: MeshData): Box3 {
  const b = box3.empty();
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    box3.includePoint(b, [p[i], p[i + 1], p[i + 2]]);
  }
  return b;
}

export function transformMesh(m: MeshData, mat: Mat4): MeshData {
  const out = cloneMesh(m);
  const p = out.positions;
  for (let i = 0; i < p.length; i += 3) {
    const q = m4point(mat, p[i], p[i + 1], p[i + 2]);
    p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2];
  }
  if (out.normals) {
    const nm = m4normal3(mat);
    const n = out.normals;
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i], y = n[i + 1], z = n[i + 2];
      n[i] = nm[0] * x + nm[3] * y + nm[6] * z;
      n[i + 1] = nm[1] * x + nm[4] * y + nm[7] * z;
      n[i + 2] = nm[2] * x + nm[5] * y + nm[8] * z;
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
  }
  return out;
}

function m4point(m: Mat4, x: number, y: number, z: number): Vec3 {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}
function m4normal3(m: Mat4): Float32Array {
  // 刚体场景下直接用旋转块即可
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

export function translateMesh(m: MeshData, d: Vec3): MeshData {
  const out = cloneMesh(m);
  const p = out.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] += d[0]; p[i + 1] += d[1]; p[i + 2] += d[2];
  }
  return out;
}

/** 顶点焊接：把量化后相同的顶点合并，返回新的 indexed 网格与旧->新映射 */
export function weldVertices(m: MeshData, eps = 1e-4): { mesh: MeshData; remap: Uint32Array } {
  const p = m.positions;
  const inv = 1 / eps;
  const keyMap = new Map<string, number>();
  const newPositions: number[] = [];
  const remap = new Uint32Array(p.length / 3);
  for (let v = 0; v < p.length / 3; v++) {
    const key =
      Math.round(p[v * 3] * inv) + ',' +
      Math.round(p[v * 3 + 1] * inv) + ',' +
      Math.round(p[v * 3 + 2] * inv);
    let nv = keyMap.get(key);
    if (nv === undefined) {
      nv = newPositions.length / 3;
      keyMap.set(key, nv);
      newPositions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
    }
    remap[v] = nv;
  }
  const oldIdx = m.indices;
  const newIndices = new Uint32Array(oldIdx.length);
  for (let i = 0; i < oldIdx.length; i++) newIndices[i] = remap[oldIdx[i]];
  const mesh: MeshData = {
    name: m.name,
    positions: new Float32Array(newPositions),
    indices: newIndices,
  };
  return { mesh, remap };
}

/** 合并多个网格（颜色可选） */
export function mergeMeshes(parts: MeshData[], name = 'merged'): MeshData {
  let vlen = 0, ilen = 0;
  let hasColor = true;
  for (const p of parts) {
    vlen += p.positions.length;
    ilen += p.indices.length;
    if (!p.colors) hasColor = false;
  }
  const positions = new Float32Array(vlen);
  const indices = new Uint32Array(ilen);
  const colors = hasColor ? new Float32Array(vlen) : undefined;
  let vo = 0, io = 0, base = 0;
  for (const p of parts) {
    positions.set(p.positions, vo);
    if (colors && p.colors) colors.set(p.colors, vo);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + base;
    vo += p.positions.length;
    io += p.indices.length;
    base += p.positions.length / 3;
  }
  return { name, positions, indices, colors };
}

/** 直接由顶点数组与三角形数组构造并算法线 */
export function buildMesh(
  name: string,
  positions: number[] | Float32Array,
  indices: number[] | Uint32Array,
  colors?: number[] | Float32Array,
): MeshData {
  const m: MeshData = {
    name,
    positions: positions instanceof Float32Array ? positions : new Float32Array(positions),
    indices: indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
    colors: colors ? (colors instanceof Float32Array ? colors : new Float32Array(colors)) : undefined,
  };
  computeVertexNormals(m);
  return m;
}

/** 深拷贝为可结构化存储的普通对象（IndexedDB 用） */
export function meshToJSON(m: MeshData): SerializedMesh {
  return {
    name: m.name,
    positions: m.positions.buffer.slice(0) as ArrayBuffer,
    indices: m.indices.buffer.slice(0) as ArrayBuffer,
    normals: m.normals ? (m.normals.buffer.slice(0) as ArrayBuffer) : undefined,
    colors: m.colors ? (m.colors.buffer.slice(0) as ArrayBuffer) : undefined,
  };
}

export interface SerializedMesh {
  name: string;
  positions: ArrayBuffer;
  indices: ArrayBuffer;
  normals?: ArrayBuffer;
  colors?: ArrayBuffer;
}

export function meshFromJSON(s: SerializedMesh): MeshData {
  return {
    name: s.name,
    positions: new Float32Array(s.positions),
    indices: new Uint32Array(s.indices),
    normals: s.normals ? new Float32Array(s.normals) : undefined,
    colors: s.colors ? new Float32Array(s.colors) : undefined,
  };
}

/** 给网格所有顶点染统一颜色 */
export function withColor(m: MeshData, c: Vec3): MeshData {
  const out = cloneMesh(m);
  const n = vertexCount(out);
  out.colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out.colors[i * 3] = c[0];
    out.colors[i * 3 + 1] = c[1];
    out.colors[i * 3 + 2] = c[2];
  }
  return out;
}
