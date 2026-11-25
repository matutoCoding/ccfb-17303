// 全局领域模型类型。病例、规划方案、设置都持久化到 IndexedDB。
import { Vec3 } from './vec';
import { SerializedMesh } from './mesh';

export type Side = 'left' | 'right';
export type ModelKind = 'mandible' | 'fibula' | 'tumor' | 'nerve';

export interface AppSettings {
  bladeThickness: number; // 锯片厚度 mm
  kerfClearance: number; // 锯槽总间隙 mm（槽宽 = 锯片厚度 + 该值）
  pinDiameter: number; // 固定钉孔直径 mm
  guideWallThickness: number; // 导板底板厚度/最小壁厚 mm
  safetyMargin: number; // 肿瘤安全边界 mm
  printerPrecision: number; // 打印机精度（层厚/轮廓容差）mm
  plateBandWidth: number; // 导板贴骨带半宽 mm
}

export const DEFAULT_SETTINGS: AppSettings = {
  bladeThickness: 0.6,
  kerfClearance: 0.4,
  pinDiameter: 2.0,
  guideWallThickness: 2.5,
  safetyMargin: 10,
  printerPrecision: 0.1,
  plateBandWidth: 10,
};

export function slotWidth(s: AppSettings): number {
  return s.bladeThickness + s.kerfClearance;
}

/** 截骨平面（下颌骨或腓骨共用） */
export interface CutPlaneSpec {
  id: string;
  label: string;
  point: Vec3;
  normal: Vec3;
  /** 腓骨平面归属哪一段的哪一端 */
  segId?: string;
  end?: 'prox' | 'dist';
}

export interface SegmentTransform {
  /** 段中心相对自动排布基准的手动偏移（mm，世界坐标） */
  offset: Vec3;
  /** 手动旋转（相对基准朝向的附加四元数 xyzw） */
  quat: [number, number, number, number];
}

export interface FibulaSegmentSpec {
  id: string;
  index: number;
  lengthMm: number;
  wedgeProxDeg: number;
  wedgeDistDeg: number;
  /** 自动排布时的世界变换基准（段中心与轴向），手动调整叠加 offset/rot */
  baseCenter: Vec3;
  baseAxis: Vec3;
  adjust: SegmentTransform;
  /** 供体腓骨上的截取起点 t∈[0,1] */
  donorT0: number;
  donorT1: number;
}

export interface JointGap {
  jointIndex: number;
  position: Vec3;
  maxGapMm: number;
  meanGapMm: number;
  lateralMm: number;
  color: Vec3;
  /** 接触圆盘采样点与逐点缝隙，用于画彩色接触斑 */
  discCenter: Vec3;
  discNormal: Vec3;
  discRadius: number;
  samples: { p: Vec3; gap: number }[];
}

export interface GuideSpec {
  id: string;
  kind: 'mandible' | 'fibula';
  name: string;
  seatDir: Vec3;
  thickness: number;
  slotWidth: number;
  pinDiameter: number;
  pinPoints: Vec3[];
  /** 倒凹顶点（贴骨面局部索引/世界坐标） */
  undercutPoints: Vec3[];
  autoRelieve: boolean;
  /** 设置版本指纹：设置变更后用于提示需要重算 */
  settingsFingerprint: string;
  createdAt: number;
}

export interface VerificationRow {
  slotLabel: string;
  planLabel: string;
  angleDeg: number;
  offsetMm: number;
  anglePass: boolean;
  offsetPass: boolean;
}

export interface SweepHit {
  planeLabel: string;
  target: '下牙槽神经管' | '对侧骨皮质' | string;
  hitPoint: Vec3;
  depthMm: number;
  message: string;
}

export interface PlanRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  planes: CutPlaneSpec[];
  segments: FibulaSegmentSpec[];
  gaps: JointGap[];
  brownClass: string;
  pedicleDir: string; // 血管蒂朝向
  fibulaSide: Side;
  guideMandible?: GuideSpec;
  guideFibula?: GuideSpec;
  /** 导出记录 */
  exports: ExportRecord[];
  /** 校核截图 dataURL */
  screenshots: { name: string; dataUrl: string; at: number }[];
}

export interface ExportRecord {
  id: string;
  at: number;
  kind: 'mandible-guide' | 'fibula-guide';
  filename: string;
  triangles: number;
  watertight: boolean;
  manifold: boolean;
  selfIntersectFree: boolean;
  minWallMm: number;
  contourMaxDevMm?: number;
  contourPass?: boolean;
  stlSize: number;
}

export interface CaseModelSet {
  mandible?: SerializedMesh;
  fibula?: SerializedMesh;
  tumor?: SerializedMesh;
  nerve?: SerializedMesh;
  /** 导入体检报告（按模型 kind） */
  reports?: Record<string, ModelHealthRecord>;
}

export interface ModelHealthRecord {
  fileName: string;
  kind: ModelKind | string;
  importedAt: number;
  vertexCount: number;
  triangleCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  holeCount: number;
  flippedTriCountEstimate: number;
  degenerateTriCount: number;
  repaired: string[];
  rejected: string | null;
  injectedDefects?: string[];
}

export interface CaseRecord {
  id: string;
  name: string;
  side: Side;
  patientName: string;
  patientId: string;
  tumorStage: string; // 肿瘤分期
  brownClass: string; // Brown 缺损分类
  fibulaSide: Side; // 取哪侧腓骨
  pedicleDir: string; // 血管蒂朝向
  note: string;
  createdAt: number;
  updatedAt: number;
  models: CaseModelSet;
  plans: PlanRecord[];
  activePlanId: string;
}

export function settingsFingerprint(s: AppSettings): string {
  return [s.bladeThickness, s.kerfClearance, s.pinDiameter, s.guideWallThickness, s.printerPrecision].join('|');
}

export const TUMOR_STAGES = [
  '未分期',
  'T1（肿瘤≤2cm）',
  'T2（2–4cm）',
  'T3（>4cm）',
  'T4a（侵犯骨皮质/舌/皮肤）',
  'T4b（侵犯咀嚼肌间隙/颅底）',
];

export const BROWN_CLASSES = [
  'Brown Ⅰ类：单侧体部/角部局限缺损，未跨中线',
  'Brown Ⅱ类：单侧半下颌缺损（含升支；c=累及髁突）',
  'Brown Ⅲ类：前份缺损跨中线（双侧尖牙区之间）',
  'Brown Ⅳ类：双侧/次全下颌缺损',
];

export const PEDICLE_DIRS = ['朝向口腔侧（顺行）', '朝向颈部（下行）', '朝向前方', '朝向后方'];
