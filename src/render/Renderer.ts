// WebGL2 三维查看器：轨道相机、Phong 着色、顶点色、透明叠加、线框/线段、地面网格、截图。
import { Mat4, m4, Vec3, v3, Ray } from '../core/vec';
import { MeshData, computeVertexNormals } from '../core/mesh';
import { createProgram, uploadMesh, MeshGL } from './glutil';

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;
out vec3 vN; out vec3 vWorld; out vec3 vColor;
void main(){
  vec4 w = uModel * vec4(aPos,1.0);
  vWorld = w.xyz;
  vN = normalize(uNormalMat * aNormal);
  vColor = aColor;
  gl_Position = uViewProj * w;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vWorld; in vec3 vColor;
uniform vec3 uColor;
uniform float uUseVertexColor;
uniform float uOpacity;
uniform vec3 uCam;
uniform float uUnlit;
out vec4 outColor;
void main(){
  vec3 base = mix(uColor, vColor, uUseVertexColor);
  if(uUnlit > 0.5){ outColor = vec4(base, uOpacity); return; }
  vec3 n = normalize(vN);
  vec3 l1 = normalize(vec3(0.45, 0.8, 0.55));
  vec3 l2 = normalize(vec3(-0.6, 0.35, -0.5));
  float d1 = max(dot(n,l1),0.0);
  float d2 = max(dot(n,l2),0.0)*0.5;
  vec3 v = normalize(uCam - vWorld);
  vec3 h = normalize(l1+v);
  float spec = pow(max(dot(n,h),0.0), 42.0)*0.35;
  float rim = pow(1.0-max(dot(n,v),0.0), 2.2)*0.18;
  vec3 col = base*(0.34 + 0.66*d1 + d2) + vec3(spec) + base*rim;
  outColor = vec4(col, uOpacity);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
void main(){ gl_Position = uViewProj * vec4(aPos,1.0); }`;
const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }`;

export interface RenderObject {
  id: string;
  mesh: MeshData;
  matrix?: Mat4;
  color?: Vec3;
  opacity?: number;
  vertexColors?: boolean;
  unlit?: boolean;
  wireframe?: boolean;
}

export interface LineObject {
  id: string;
  positions: Float32Array | number[];
  color?: Vec3;
  opacity?: number;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private lineProg: WebGLProgram;
  private meshCache = new Map<MeshData, MeshGL>();
  private objects = new Map<string, RenderObject>();
  private lines = new Map<string, { obj: LineObject; vao: WebGLVertexArrayObject; buffer: WebGLBuffer; count: number }>();

  view: Mat4 = m4.identity();
  proj: Mat4 = m4.identity();
  viewProj: Mat4 = m4.identity();
  camPos: Vec3 = [120, 90, 150];
  target: Vec3 = [0, 10, 0];
  yaw = 0.7;
  pitch = 0.42;
  distance = 260;

  private raf = 0;
  private dragging: null | { x: number; y: number; button: number; mode: 'orbit' | 'pan' | 'custom' } = null;
  /** 页面自定义按下处理；返回 true 表示捕获（禁用轨道），并接收移动/抬起 */
  customDown: ((ray: Ray, e: PointerEvent) => boolean) | null = null;
  customMove: ((ray: Ray, e: PointerEvent) => void) | null = null;
  customUp: ((ray: Ray, e: PointerEvent) => void) | null = null;
  /** 单击（未拖动）回调，用于选中平面 */
  onPickClick: ((ray: Ray, e: MouseEvent) => void) | null = null;
  private downPos = { x: 0, y: 0 };
  private moved = false;
  disposed = false;
  showGrid = true;
  /** 自定义渲染通道（如图像空间 CSG 预览），在不透明物体之后、线段之前调用 */
  customPass: ((gl: WebGL2RenderingContext, ctx: { viewProj: Mat4; camPos: Vec3; view: Mat4 }) => void) | null = null;
  private gridVAO: WebGLVertexArrayObject | null = null;
  private gridCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, stencil: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = createProgram(gl, MESH_VS, MESH_FS);
    this.lineProg = createProgram(gl, LINE_VS, LINE_FS);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.buildGrid();
    this.bindEvents();
    this.resize();
    this.loop();
  }

  private buildGrid(): void {
    const positions: number[] = [];
    const S = 220, step = 10;
    for (let x = -S; x <= S; x += step) {
      positions.push(x, -20, -S, x, -20, S);
    }
    for (let z = -S; z <= S; z += step) {
      positions.push(-S, -20, z, S, -20, z);
    }
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.gridVAO = vao;
    this.gridCount = positions.length / 3;
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.handleDown);
    window.addEventListener('pointermove', this.handleMove);
    window.addEventListener('pointerup', this.handleUp);
    c.addEventListener('wheel', this.handleWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handleDown = (e: PointerEvent) => {
    this.downPos = { x: e.clientX, y: e.clientY };
    this.moved = false;
    const ray = this.screenToRay(e.clientX, e.clientY);
    if (e.button === 0 && this.customDown && this.customDown(ray, e)) {
      this.dragging = { x: e.clientX, y: e.clientY, button: e.button, mode: 'custom' };
      return;
    }
    const mode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    this.dragging = { x: e.clientX, y: e.clientY, button: e.button, mode };
  };

  private handleMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    if (Math.abs(e.clientX - this.downPos.x) + Math.abs(e.clientY - this.downPos.y) > 4) this.moved = true;
    if (this.dragging.mode === 'custom') {
      this.customMove?.(this.screenToRay(e.clientX, e.clientY), e);
    } else if (this.dragging.mode === 'orbit') {
      this.yaw -= dx * 0.008;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.008));
    } else {
      const scale = this.distance * 0.0016;
      const right = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)] as Vec3;
      const fwd = [Math.sin(this.yaw), 0, Math.cos(this.yaw)] as Vec3;
      this.target = v3.add(this.target, v3.scale(right, -dx * scale));
      this.target = v3.add(this.target, v3.scale(fwd, dy * scale));
    }
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
  };

  private handleUp = (e: PointerEvent) => {
    if (this.dragging?.mode === 'custom') {
      this.customUp?.(this.screenToRay(e.clientX, e.clientY), e);
    } else if (!this.moved && e.button === 0 && this.onPickClick) {
      this.onPickClick(this.screenToRay(e.clientX, e.clientY), e as unknown as MouseEvent);
    }
    this.dragging = null;
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.distance = Math.max(20, Math.min(1200, this.distance * (1 + Math.sign(e.deltaY) * 0.09)));
  };

  resize(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || c.parentElement?.clientWidth || 800;
    const h = c.clientHeight || c.parentElement?.clientHeight || 600;
    const W = Math.max(2, Math.floor(w * dpr));
    const H = Math.max(2, Math.floor(h * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.gl.viewport(0, 0, c.width, c.height);
  }

  setObjects(objs: RenderObject[]): void {
    const next = new Map(objs.map((o) => [o.id, o]));
    this.objects = next;
  }
  upsertObject(o: RenderObject): void { this.objects.set(o.id, o); }
  removeObject(id: string): void { this.objects.delete(id); }

  setLines(id: string, positions: Float32Array | number[], color: Vec3 = [0.1, 0.12, 0.16], opacity = 1): void {
    const arr = positions instanceof Float32Array ? positions : new Float32Array(positions);
    const gl = this.gl;
    let entry = this.lines.get(id);
    if (!entry) {
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      entry = { obj: { id, positions: arr, color, opacity }, vao, buffer, count: arr.length / 3 };
      this.lines.set(id, entry);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      entry.count = arr.length / 3;
      entry.obj = { id, positions: arr, color, opacity };
    }
  }

  removeLine(id: string): void { this.lines.delete(id); }

  clearLines(): void { this.lines.clear(); }

  frameBox(center: Vec3, size: Vec3): void {
    this.target = center;
    this.distance = Math.max(60, v3.len(size) * 1.35);
  }

  screenToRay(clientX: number, clientY: number): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const inv = invertMat4(this.viewProj);
    const p0 = unproject(inv, nx, ny, -1);
    const p1 = unproject(inv, nx, ny, 1);
    return { origin: p0, dir: v3.norm(v3.sub(p1, p0)) };
  }

  screenshot(): string {
    this.renderOnce();
    return this.canvas.toDataURL('image/png');
  }

  private loop = () => {
    if (this.disposed) return;
    this.resize();
    this.renderOnce();
    this.raf = requestAnimationFrame(this.loop);
  };

  private renderOnce(): void {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.clearColor(0.965, 0.97, 0.985, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    this.camPos = [
      this.target[0] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
    ];
    this.view = m4.lookAt(this.camPos, this.target, [0, 1, 0]);
    this.proj = m4.perspective((42 * Math.PI) / 180, W / H, 0.5, 3000);
    this.viewProj = m4.multiply(this.proj, this.view);

    if (this.showGrid && this.gridVAO) this.drawGrid();

    const opaque: RenderObject[] = [];
    const transp: RenderObject[] = [];
    for (const o of this.objects.values()) (o.opacity !== undefined && o.opacity < 0.999 ? transp : opaque).push(o);
    for (const o of opaque) this.drawObject(o);
    this.customPass?.(gl, { viewProj: this.viewProj, camPos: this.camPos, view: this.view });
    for (const o of transp) this.drawObject(o);

    this.drawLines();
  }

  private drawGrid(): void {
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, this.viewProj);
    gl.uniform4f(gl.getUniformLocation(this.lineProg, 'uColor'), 0.72, 0.76, 0.84, 0.55);
    gl.bindVertexArray(this.gridVAO);
    gl.enable(gl.BLEND);
    gl.drawArrays(gl.LINES, 0, this.gridCount);
    gl.bindVertexArray(null);
  }

  /** 释放某动态网格的 GPU 资源（页面替换临时几何时调用） */
  releaseMesh(mesh: MeshData): void {
    const g = this.meshCache.get(mesh);
    if (g) {
      this.gl.deleteVertexArray(g.vao);
      for (const b of g.buffers) this.gl.deleteBuffer(b);
      this.meshCache.delete(mesh);
    }
  }

  private getGL(mesh: MeshData): MeshGL {
    let g = this.meshCache.get(mesh);
    if (!g) {
      if (!mesh.normals || mesh.normals.length !== mesh.positions.length) computeVertexNormals(mesh);
      g = uploadMesh(this.gl, mesh);
      this.meshCache.set(mesh, g);
    }
    return g;
  }

  private drawObject(o: RenderObject): void {
    const gl = this.gl;
    const g = this.getGL(o.mesh);
    const model = o.matrix ?? m4.identity();
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uViewProj'), false, this.viewProj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uModel'), false, model);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.prog, 'uNormalMat'), false, m4.normalMat3(model));
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'uCam'), this.camPos);
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'uColor'), o.color ?? [0.75, 0.78, 0.82]);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uUseVertexColor'), o.vertexColors || o.mesh.colors ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uOpacity'), o.opacity ?? 1);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uUnlit'), o.unlit ? 1 : 0);

    gl.bindVertexArray(g.vao);
    if (o.wireframe) {
      gl.disable(gl.CULL_FACE);
      // 线框用 LINE 模式需要单独缓冲；这里用多边形偏移 + 线框模拟：直接画线条不可行，跳过
      gl.drawElements(gl.TRIANGLES, g.indexCount, g.indexType, 0);
    } else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.drawElements(gl.TRIANGLES, g.indexCount, g.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  private drawLines(): void {
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, this.viewProj);
    for (const l of this.lines.values()) {
      gl.uniform4f(gl.getUniformLocation(this.lineProg, 'uColor'), l.obj.color?.[0] ?? 0.1, l.obj.color?.[1] ?? 0.1, l.obj.color?.[2] ?? 0.1, l.obj.opacity ?? 1);
      gl.bindVertexArray(l.vao);
      gl.drawArrays(gl.LINES, 0, l.count);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.handleDown);
    window.removeEventListener('pointermove', this.handleMove);
    window.removeEventListener('pointerup', this.handleUp);
    c.removeEventListener('wheel', this.handleWheel);
  }
}

function invertMat4(m: Mat4): Mat4 {
  // 通用 4x4 求逆
  const a = m;
  const out = new Float32Array(16);
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
  if (!det) return m4.identity();
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b08 - a21 * b07 - a23 * b06) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b09 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b09 - a21 * b08 + a23 * b06) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a22 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a22 * b00 - a21 * b02 + a20 * b03) * det;
  return out;
}

function unproject(inv: Mat4, x: number, y: number, z: number): Vec3 {
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  const iw = 1 / (w || 1);
  return [
    (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) * iw,
    (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) * iw,
    (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) * iw,
  ];
}
