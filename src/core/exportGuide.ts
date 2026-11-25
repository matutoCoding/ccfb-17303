// 导板导出流水线：体素 SDF 重建（保证水密流形）-> 槽壁精确归位
// -> 流形/自交/壁厚校验 -> 二进制 STL。核心逻辑无 DOM 依赖，可在 Node 测试中验证。
import { MeshData, weldVertices, computeVertexNormals, cloneMesh } from './mesh';
import { writeBinarySTL, parseSTL } from './io/stl';
import { makeOBBMesh, makeCylinderMesh } from './primitives';
import { GuideBuildResult, CutterSpec } from './guide';
import { voxelizeGuideSolid } from './voxel';
import { validateGuideForExport, ValidationResult } from './validate';
import { CutPlaneSpec } from './types';
import { Vec3, makePlane } from './vec';

export interface ExportOutcome {
  ok: boolean;
  stl?: ArrayBuffer;
  /** 写出并重新读回的 STL 网格（端到端校核用，已焊接） */
  stlMesh?: MeshData;
  finalMesh?: MeshData;
  /** 轮廓比对基准：精修(snap)前的体素 CSG 网格，等同实时预览的切割定义 */
  referenceMesh?: MeshData;
  validation?: ValidationResult;
  error?: string;
  logs: string[];
}

export function cutterToMesh(c: CutterSpec): MeshData {
  if (c.kind === 'box') return makeOBBMesh(c.label, c.obb);
  return makeCylinderMesh(c.label, c.center, c.axis, c.radius, c.length);
}

/**
 * 把槽壁压平到精确规划壁平面，消除体素量化误差。
 * 按“质心落在壁面窄带内 + 三角形法线倾向槽法向”选中槽壁，再投影其顶点；
 * 共享顶点一起移动，拓扑仍水密。
 */
export function snapSlotWalls(m: MeshData, planes: CutPlaneSpec[], slotWidth: number, bandMm = 0.28): number {
  let snappedVerts = 0;
  const pos = m.positions;
  const T = m.indices.length / 3;
  const snapVerts = new Map<number, { n: Vec3; d: number; want: number }>();
  for (const pl of planes) {
    const plane = makePlane(pl.point, pl.normal);
    for (let t = 0; t < T; t++) {
      const i0 = m.indices[t * 3], i1 = m.indices[t * 3 + 1], i2 = m.indices[t * 3 + 2];
      const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
      const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const tnx = e1y * e2z - e1z * e2y, tny = e1z * e2x - e1x * e2z, tnz = e1x * e2y - e1y * e2x;
      const tnl = Math.hypot(tnx, tny, tnz);
      if (tnl < 1e-9) continue;
      const normalDot = Math.abs((tnx / tnl) * plane.n[0] + (tny / tnl) * plane.n[1] + (tnz / tnl) * plane.n[2]);
      if (normalDot < 0.4) continue;
      const ccx = (ax + bx + cx) / 3, ccy = (ay + by + cy) / 3, ccz = (az + bz + cz) / 3;
      const dc = plane.n[0] * ccx + plane.n[1] * ccy + plane.n[2] * ccz + plane.d;
      let wallSign = 0;
      if (Math.abs(dc - slotWidth / 2) <= bandMm) wallSign = 1;
      else if (Math.abs(dc + slotWidth / 2) <= bandMm) wallSign = -1;
      if (!wallSign) continue;
      const want = wallSign * slotWidth / 2;
      for (const vi of [i0, i1, i2]) snapVerts.set(vi, { n: plane.n, d: plane.d, want });
    }
  }
  for (const [vi, target] of snapVerts) {
    const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
    const val = target.n[0] * x + target.n[1] * y + target.n[2] * z + target.d;
    const shiftVal = target.want - val;
    pos[vi * 3] += target.n[0] * shiftVal;
    pos[vi * 3 + 1] += target.n[1] * shiftVal;
    pos[vi * 3 + 2] += target.n[2] * shiftVal;
    snappedVerts++;
  }
  computeVertexNormals(m);
  return snappedVerts;
}

/**
 * 完整导出。校验不过且未 allowUnsafe 时不产出 STL。
 */
export async function exportGuideSTL(
  guide: GuideBuildResult,
  planes: CutPlaneSpec[],
  slotWidth: number,
  minWallMm: number,
  opts: { allowUnsafe?: boolean; voxelMm?: number; onProgress?: (msg: string) => void } = {},
): Promise<ExportOutcome> {
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); opts.onProgress?.(m); };
  try {
    await new Promise((r) => setTimeout(r, 20));
    log('体素 SDF 重建水密导板…');
    const voxel = voxelizeGuideSolid(guide.plate, {
      voxelMm: opts.voxelMm ?? 0.26,
      maxCells: 7_000_000,
      cutters: guide.cutters,
      onProgress: log,
    });
    log(`体素网格 ${(voxel.indices.length / 3).toLocaleString()} 三角形`);

    // snap 前网格作为“体素 CSG 预览基准”
    const preSnap = cloneMesh(voxel);

    log('归位锯槽壁到精确规划平面…');
    const snapped = snapSlotWalls(voxel, planes, slotWidth);
    log(`归位槽壁顶点 ${snapped.toLocaleString()} 个`);

    log('导出前校验（流形/自交/壁厚）…');
    computeVertexNormals(voxel);
    const validation = validateGuideForExport(voxel, minWallMm);
    if (!validation.passed && !opts.allowUnsafe) {
      return { ok: false, error: validation.blockers.join('；'), logs, validation, finalMesh: voxel, referenceMesh: preSnap };
    }

    log('写二进制 STL…');
    const stl = writeBinarySTL(voxel);
    const stlRaw = parseSTL(stl, 'exported-guide.stl');
    const stlMesh = weldVertices(stlRaw, 1e-4).mesh;
    computeVertexNormals(stlMesh);

    return { ok: true, stl, stlMesh, finalMesh: voxel, referenceMesh: preSnap, validation, logs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
  }
}
