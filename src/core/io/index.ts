// 模型文件分发解析：按扩展名选择 STL / PLY。
import { MeshData } from '../mesh';
import { parseSTL } from './stl';
import { parsePLY } from './ply';

export type SupportedExt = 'stl' | 'ply';

export function extOf(filename: string): SupportedExt | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  if (!m) return null;
  const e = m[1].toLowerCase();
  if (e === 'stl') return 'stl';
  if (e === 'ply') return 'ply';
  return null;
}

export function parseModelFile(buffer: ArrayBuffer, filename: string): MeshData {
  const ext = extOf(filename);
  if (ext === 'stl') return parseSTL(buffer, filename);
  if (ext === 'ply') return parsePLY(buffer, filename);
  // 无扩展名时嗅探
  const head = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, Math.min(200, buffer.byteLength)));
  if (/^ply/i.test(head)) return parsePLY(buffer, filename + '.ply');
  if (/solid|facet/i.test(head) || buffer.byteLength > 84) return parseSTL(buffer, filename + '.stl');
  throw new Error(`不支持的文件格式：${filename}（仅支持 STL / PLY）`);
}

export { parseSTL, writeBinarySTL } from './stl';
export { parsePLY } from './ply';
