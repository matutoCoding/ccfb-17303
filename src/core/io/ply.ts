// PLY 解析：支持 ascii 与 binary_little/big_endian，提取 x/y/z 与面索引（triangle fan 展开）。
import { MeshData, computeVertexNormals } from '../mesh';

interface Prop {
  name: string;
  kind: string; // 标量类型，或 'list'
  countType?: string;
  indexType?: string;
}

export function parsePLY(buffer: ArrayBuffer, name = 'model.ply'): MeshData {
  const bytes = new Uint8Array(buffer);
  let headerEnd = -1;
  for (let i = 0; i + 10 <= bytes.length; i++) {
    if (
      bytes[i] === 101 && bytes[i + 1] === 110 && bytes[i + 2] === 100 &&
      bytes[i + 3] === 95 && bytes[i + 4] === 104 && bytes[i + 5] === 101 &&
      bytes[i + 6] === 97 && bytes[i + 7] === 100 && bytes[i + 8] === 101 && bytes[i + 9] === 114
    ) {
      let j = i + 10;
      while (j < bytes.length && bytes[j] !== 10) j++;
      headerEnd = j + 1;
      break;
    }
  }
  if (headerEnd < 0) throw new Error(`PLY 头部无法识别：${name}`);
  const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd));
  if (!/^ply/i.test(headerText)) throw new Error(`不是合法 PLY 文件：${name}`);

  let format: 'ascii' | 'binary_le' | 'binary_be' = 'ascii';
  const vertexProps: Prop[] = [];
  const faceProps: Prop[] = [];
  let vertexCount = 0;
  let faceCount = 0;
  let section: 'none' | 'vertex' | 'face' = 'none';

  for (const rawLine of headerText.split(/\r?\n/)) {
    const tok = rawLine.trim().split(/\s+/).filter(Boolean);
    if (tok[0] === 'format') {
      format = tok[1] === 'ascii' ? 'ascii' : tok[1] === 'binary_little_endian' ? 'binary_le' : 'binary_be';
    } else if (tok[0] === 'element') {
      if (tok[1] === 'vertex') { vertexCount = parseInt(tok[2], 10); section = 'vertex'; }
      else if (tok[1] === 'face') { faceCount = parseInt(tok[2], 10); section = 'face'; }
      else section = 'none';
    } else if (tok[0] === 'property') {
      if (tok[1] === 'list' && tok.length >= 5) {
        const prop: Prop = { name: tok[4], kind: 'list', countType: tok[2], indexType: tok[3] };
        if (section === 'face') faceProps.push(prop);
      } else if (tok.length >= 3) {
        const prop: Prop = { name: tok[2], kind: tok[1] };
        if (section === 'vertex') vertexProps.push(prop);
      }
    }
  }

  if (vertexCount <= 0) throw new Error(`PLY 中没有顶点：${name}`);
  if (format === 'ascii') return parseAsciiPLY(buffer, headerEnd, vertexCount, faceCount, vertexProps, name);
  return parseBinaryPLY(buffer, headerEnd, format === 'binary_le', vertexCount, faceCount, vertexProps, faceProps, name);
}

function typeSize(t: string): number {
  switch (t) {
    case 'char': case 'uchar': case 'int8': case 'uint8': return 1;
    case 'short': case 'ushort': case 'int16': case 'uint16': return 2;
    case 'int': case 'uint': case 'int32': case 'uint32': case 'float': case 'float32': return 4;
    case 'double': case 'float64': return 8;
    default: return 4;
  }
}

function readVal(dv: DataView, off: number, t: string, le: boolean): number {
  switch (t) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    default: return dv.getFloat32(off, le);
  }
}

function parseBinaryPLY(
  buffer: ArrayBuffer, start: number, le: boolean,
  vertexCount: number, faceCount: number,
  vertexProps: Prop[], faceProps: Prop[], name: string,
): MeshData {
  const dv = new DataView(buffer);
  let off = start;
  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    let x = 0, y = 0, z = 0;
    for (const prop of vertexProps) {
      const val = readVal(dv, off, prop.kind, le);
      off += typeSize(prop.kind);
      if (prop.name === 'x') x = val;
      else if (prop.name === 'y') y = val;
      else if (prop.name === 'z') z = val;
    }
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
  }
  const indices: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    for (const prop of faceProps) {
      if (prop.kind === 'list') {
        const count = readVal(dv, off, prop.countType ?? 'uchar', le);
        off += typeSize(prop.countType ?? 'uchar');
        const ids: number[] = [];
        for (let k = 0; k < count; k++) {
          ids.push(readVal(dv, off, prop.indexType ?? 'int', le));
          off += typeSize(prop.indexType ?? 'int');
        }
        for (let k = 1; k < count - 1; k++) indices.push(ids[0], ids[k], ids[k + 1]);
      } else {
        off += typeSize(prop.kind);
      }
    }
  }
  const m: MeshData = { name, positions, indices: Uint32Array.from(indices) };
  computeVertexNormals(m);
  return m;
}

function parseAsciiPLY(
  buffer: ArrayBuffer, start: number,
  vertexCount: number, faceCount: number,
  vertexProps: Prop[], name: string,
): MeshData {
  const text = new TextDecoder('utf-8').decode(buffer.slice(start));
  const lines = text.split(/\r?\n/);
  let li = 0;
  const nextNonEmpty = (): string[] => {
    while (li < lines.length && lines[li].trim() === '') li++;
    return (lines[li++] ?? '').trim().split(/\s+/).filter(Boolean);
  };
  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const parts = nextNonEmpty().map(Number);
    // 按头部属性名取值；缺省退回前 3 列
    let col = 0;
    let x = 0, y = 0, z = 0;
    for (const prop of vertexProps) {
      if (prop.kind === 'list') { col += 1 + (parts[col] ?? 0); continue; }
      const val = parts[col++] ?? 0;
      if (prop.name === 'x') x = val;
      else if (prop.name === 'y') y = val;
      else if (prop.name === 'z') z = val;
    }
    if (vertexProps.length === 0) { x = parts[0]; y = parts[1]; z = parts[2]; }
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
  }
  const indices: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const parts = nextNonEmpty().map(Number);
    // 标准 PLY 面行：<顶点数> i0 i1 i2 ...（首列即 list 计数），做 triangle fan 展开
    const count = parts[0] ?? 0;
    const ids = parts.slice(1, 1 + count);
    for (let k = 1; k < ids.length - 1; k++) indices.push(ids[0], ids[k], ids[k + 1]);
  }
  const m: MeshData = { name, positions, indices: Uint32Array.from(indices) };
  computeVertexNormals(m);
  return m;
}
