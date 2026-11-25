// STL 二进制 / ASCII 解析与二进制写出。纯函数，Node 与浏览器通用。
import { MeshData, computeVertexNormals } from '../mesh';

export function parseSTL(buffer: ArrayBuffer, name = 'model.stl'): MeshData {
  const bytes = new Uint8Array(buffer);
  // 先尝试二进制：80 字节头 + uint32 面数，文件长度严格匹配 84 + 50*n
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    if (84 + triCount * 50 === bytes.length) {
      return parseBinarySTL(dv, triCount, name);
    }
  }
  // 否则按 ASCII 解析
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/^\s*solid/i.test(text) && text.includes('facet')) {
    return parseAsciiSTL(text, name);
  }
  // 某些二进制 STL 头部恰好以 solid 开头但长度匹配已在上面处理；走到这里尝试二进制兜底
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    if (triCount > 0 && 84 + triCount * 50 <= bytes.length + 4096) {
      return parseBinarySTL(dv, triCount, name);
    }
  }
  throw new Error(`STL 无法识别：${name}（既不是合法二进制也不是 ASCII STL）`);
}

function parseBinarySTL(dv: DataView, triCount: number, name: string): MeshData {
  const positions = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    // normal 12 bytes 跳过
    off += 12;
    for (let k = 0; k < 9; k++) {
      positions[t * 9 + k] = dv.getFloat32(off, true);
      off += 4;
    }
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
    off += 2; // attribute
  }
  const m: MeshData = { name, positions, indices };
  computeVertexNormals(m);
  return m;
}

function parseAsciiSTL(text: string, name: string): MeshData {
  const verts: number[] = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(text)) !== null) {
    verts.push(parseFloat(mm[1]), parseFloat(mm[2]), parseFloat(mm[3]));
  }
  if (verts.length < 9) throw new Error(`ASCII STL 中没有找到顶点：${name}`);
  const triCount = verts.length / 9;
  const indices = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
  }
  const m: MeshData = { name, positions: new Float32Array(verts), indices };
  computeVertexNormals(m);
  return m;
}

/** 写出二进制 STL（索引网格展开为三角形汤） */
export function writeBinarySTL(m: MeshData): ArrayBuffer {
  const triCount = m.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  const header = new TextEncoder().encode('fibula-guide-planner binary STL');
  new Uint8Array(buffer, 0, Math.min(80, header.length)).set(header.subarray(0, Math.min(80, header.length)));
  dv.setUint32(80, triCount, true);
  const p = m.positions;
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const ia = m.indices[t * 3] * 3;
    const ib = m.indices[t * 3 + 1] * 3;
    const ic = m.indices[t * 3 + 2] * 3;
    // 面法线
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const e1x = p[ib] - ax, e1y = p[ib + 1] - ay, e1z = p[ib + 2] - az;
    const e2x = p[ic] - ax, e2y = p[ic + 1] - ay, e2z = p[ic + 2] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    off += 12;
    dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
    dv.setFloat32(off, p[ib], true); dv.setFloat32(off + 4, p[ib + 1], true); dv.setFloat32(off + 8, p[ib + 2], true); off += 12;
    dv.setFloat32(off, p[ic], true); dv.setFloat32(off + 4, p[ic + 1], true); dv.setFloat32(off + 8, p[ic + 2], true); off += 12;
    dv.setUint16(off, 0, true); off += 2;
  }
  return buffer;
}
