// 图像空间 CSG 实时预览：深度剥离得到骨板前后深度层 -> 片元级切割体剔除成孔
// -> 模板标记骨板覆盖区 -> 仅绘制落在前后深度层之间的切割体内壁（锯槽壁/钉孔壁）。
// 拖动锯槽时只更新 uniform，不跑任何网格布尔。
import { MeshData } from '../core/mesh';
import { createProgram, uploadMesh, MeshGL } from './glutil';
import { makeOBBMesh, makeCylinderMesh } from '../core/primitives';
import { CutterSpec } from '../core/guide';
import { Mat4, Vec3 } from '../core/vec';

const MAX_C = 16;

const PEEEL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
void main(){ gl_Position = uViewProj * vec4(aPos,1.0); }`;
const PEEL_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform float uHasPrev;
out vec4 o;
void main(){
  float z = gl_FragCoord.z;
  if(uHasPrev > 0.5){
    float p = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).r;
    if(z <= p + 0.00008) discard;
  }
  o = vec4(z, 0.0, 0.0, 1.0);
}`;

const PLATE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aN;
uniform mat4 uViewProj;
out vec3 vP; out vec3 vN;
void main(){ vP=aPos; vN=aN; gl_Position=uViewProj*vec4(aPos,1.0); }`;

const PLATE_FS = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN;
uniform vec3 uCam;
uniform int uCount;
uniform float uType[${MAX_C}];
uniform vec3 uCenter[${MAX_C}];
uniform vec3 uA0[${MAX_C}];
uniform vec3 uA1[${MAX_C}];
uniform vec3 uA2[${MAX_C}];
uniform vec4 uParam[${MAX_C}]; // box: hx,hy,hz ; cyl: radius,length
out vec4 o;
bool insideCutter(int i){
  vec3 d = vP - uCenter[i];
  if(uType[i] < 0.5){
    return abs(dot(d,uA0[i])) < uParam[i].x
        && abs(dot(d,uA1[i])) < uParam[i].y
        && abs(dot(d,uA2[i])) < uParam[i].z;
  } else {
    float ax = dot(d, uA2[i]);
    float r2 = dot(d,d) - ax*ax;
    return abs(ax) < uParam[i].y*0.5 && r2 < uParam[i].x*uParam[i].x;
  }
}
void main(){
  for(int i=0;i<${MAX_C};i++){ if(i>=uCount) break; if(insideCutter(i)) discard; }
  vec3 n = normalize(vN);
  vec3 l = normalize(vec3(0.4,0.85,0.5));
  float d = max(dot(n,l),0.0);
  vec3 col = vec3(0.62,0.78,0.95)*(0.38+0.62*d);
  o = vec4(col, 0.96);
}`;

const WALL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aN;
uniform mat4 uViewProj;
out vec3 vP; out vec3 vN;
void main(){ vP=aPos; vN=aN; gl_Position=uViewProj*vec4(aPos,1.0); }`;
const WALL_FS = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN;
uniform sampler2D uDepth0;
uniform sampler2D uDepth1;
uniform vec3 uCam;
uniform vec3 uWallColor;
out vec4 o;
void main(){
  ivec2 uv = ivec2(gl_FragCoord.xy);
  float z0 = texelFetch(uDepth0, uv, 0).r;
  float z1 = texelFetch(uDepth1, uv, 0).r;
  float z = gl_FragCoord.z;
  // 仅保留骨板前后深度层之间的切割壁
  if(!(z > z0 + 0.00015 && z < z1 - 0.00015)) discard;
  vec3 n = normalize(vN);
  if(!gl_FrontFacing) n = -n;
  vec3 l = normalize(vec3(0.4,0.85,0.5));
  float d = max(abs(dot(n,l)),0.0);
  vec3 v = normalize(uCam - vP);
  float spec = pow(max(dot(n, normalize(l+v)),0.0), 30.0)*0.4;
  vec3 col = uWallColor*(0.4+0.6*d) + spec;
  o = vec4(col, 1.0);
}`;

interface CutterGL { spec: CutterSpec; gl: MeshGL; mesh: MeshData }

export class CsgPreview {
  private gl: WebGL2RenderingContext;
  private peelProg: WebGLProgram;
  private plateProg: WebGLProgram;
  private wallProg: WebGLProgram;
  private plateGL: MeshGL | null = null;
  private cutters: CutterGL[] = [];
  private fbos: { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer }[] = [];
  private W = 2; private H = 2;
  private cutterUniforms: {
    type: Float32Array; center: Float32Array; a0: Float32Array; a1: Float32Array; a2: Float32Array; param: Float32Array;
  };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.peelProg = createProgram(gl, PEEEL_VS, PEEL_FS);
    this.plateProg = createProgram(gl, PLATE_VS, PLATE_FS);
    this.wallProg = createProgram(gl, WALL_VS, WALL_FS);
    this.cutterUniforms = {
      type: new Float32Array(MAX_C),
      center: new Float32Array(MAX_C * 3),
      a0: new Float32Array(MAX_C * 3), a1: new Float32Array(MAX_C * 3), a2: new Float32Array(MAX_C * 3),
      param: new Float32Array(MAX_C * 4),
    };
    this.ensureFbos(4, 4);
  }

  setGuide(plate: MeshData, cutters: CutterSpec[]): void {
    this.plateGL = uploadMesh(this.gl, plate);
    this.setCutters(cutters);
  }

  /** 仅更新切割体（锯槽宽度/位置拖动时调用）：不重建骨板、不跑任何布尔 */
  setCutters(cutters: CutterSpec[]): void {
    for (const old of this.cutters) this.gl.deleteVertexArray(old.gl.vao);
    this.cutters = cutters.slice(0, MAX_C).map((spec) => {
      const mesh = spec.kind === 'box'
        ? makeOBBMesh(spec.label, spec.obb)
        : makeCylinderMesh(spec.label, spec.center, spec.axis, spec.radius, spec.length, 20);
      return { spec, mesh, gl: uploadMesh(this.gl, mesh) };
    });
    const u = this.cutterUniforms;
    u.type.fill(0); u.center.fill(0); u.a0.fill(0); u.a1.fill(0); u.a2.fill(0); u.param.fill(0);
    this.cutters.forEach((c, i) => {
      const s = c.spec;
      u.type[i] = s.kind === 'box' ? 0 : 1;
      if (s.kind === 'box') {
        u.center.set(s.obb.center, i * 3);
        u.a0.set(s.obb.axes[0], i * 3); u.a1.set(s.obb.axes[1], i * 3); u.a2.set(s.obb.axes[2], i * 3);
        u.param.set([s.obb.half[0], s.obb.half[1], s.obb.half[2], 0], i * 4);
      } else {
        u.center.set(s.center, i * 3);
        u.a2.set(s.axis, i * 3);
        u.param.set([s.radius, s.length, 0, 0], i * 4);
      }
    });
  }

  private ensureFbos(W: number, H: number): void {
    if (this.W === W && this.H === H && this.fbos.length === 2) return;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); gl.deleteRenderbuffer(f.depth); }
    this.fbos = [];
    this.W = W; this.H = H;
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.warn('peel fbo incomplete');
      }
      this.fbos.push({ fbo, tex, depth });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(viewProj: Mat4, camPos: Vec3, canvasW: number, canvasH: number): void {
    if (!this.plateGL) return;
    const gl = this.gl;
    this.ensureFbos(canvasW, canvasH);

    // ---- 深度剥离两层 ----
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    const drawPeel = (idx: number, prevTex: WebGLTexture | null, hasPrev: number) => {
      const f = this.fbos[idx];
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.viewport(0, 0, this.W, this.H);
      gl.clearColor(1, 0, 0, 1); // R=1 -> 远于任何片元
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.peelProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.peelProg, 'uViewProj'), false, viewProj);
      gl.uniform1f(gl.getUniformLocation(this.peelProg, 'uHasPrev'), hasPrev);
      if (prevTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevTex);
        gl.uniform1i(gl.getUniformLocation(this.peelProg, 'uPrev'), 0);
      }
      gl.bindVertexArray(this.plateGL!.vao);
      gl.drawElements(gl.TRIANGLES, this.plateGL!.indexCount, this.plateGL!.indexType, 0);
      gl.bindVertexArray(null);
    };
    drawPeel(0, null, 0);
    drawPeel(1, this.fbos[0].tex, 1);

    // ---- 回到默认帧缓冲 ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 模板：完整骨板覆盖区写 1（不写颜色/深度）
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.useProgram(this.plateProg); // 仅借用 VAO/矩阵；用一个极简绘制即可
    gl.uniformMatrix4fv(gl.getUniformLocation(this.plateProg, 'uViewProj'), false, viewProj);
    // 直接用 peel 程序画模板更稳妥
    gl.useProgram(this.peelProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.peelProg, 'uViewProj'), false, viewProj);
    gl.uniform1f(gl.getUniformLocation(this.peelProg, 'uHasPrev'), 0);
    gl.bindVertexArray(this.plateGL.vao);
    gl.drawElements(gl.TRIANGLES, this.plateGL.indexCount, this.plateGL.indexType, 0);
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);

    // ---- 画带切割剔除的骨板 ----
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(this.plateProg);
    const U = this.cutterUniforms;
    gl.uniformMatrix4fv(gl.getUniformLocation(this.plateProg, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.plateProg, 'uCam'), camPos);
    gl.uniform1i(gl.getUniformLocation(this.plateProg, 'uCount'), this.cutters.length);
    gl.uniform1fv(gl.getUniformLocation(this.plateProg, 'uType[0]'), U.type);
    gl.uniform3fv(gl.getUniformLocation(this.plateProg, 'uCenter[0]'), U.center);
    gl.uniform3fv(gl.getUniformLocation(this.plateProg, 'uA0[0]'), U.a0);
    gl.uniform3fv(gl.getUniformLocation(this.plateProg, 'uA1[0]'), U.a1);
    gl.uniform3fv(gl.getUniformLocation(this.plateProg, 'uA2[0]'), U.a2);
    gl.uniform4fv(gl.getUniformLocation(this.plateProg, 'uParam[0]'), U.param);
    gl.bindVertexArray(this.plateGL.vao);
    gl.drawElements(gl.TRIANGLES, this.plateGL.indexCount, this.plateGL.indexType, 0);
    gl.bindVertexArray(null);

    // ---- 画切割内壁（深度剥离区间 + 模板） ----
    gl.disable(gl.CULL_FACE);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.useProgram(this.wallProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.wallProg, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.wallProg, 'uCam'), camPos);
    gl.uniform3f(gl.getUniformLocation(this.wallProg, 'uWallColor'), 1.0, 0.55, 0.18);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    gl.uniform1i(gl.getUniformLocation(this.wallProg, 'uDepth0'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex);
    gl.uniform1i(gl.getUniformLocation(this.wallProg, 'uDepth1'), 1);
    for (const c of this.cutters) {
      gl.bindVertexArray(c.gl.vao);
      gl.drawElements(gl.TRIANGLES, c.gl.indexCount, c.gl.indexType, 0);
    }
    gl.bindVertexArray(null);

    // 复位状态
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.activeTexture(gl.TEXTURE0);
  }
}
