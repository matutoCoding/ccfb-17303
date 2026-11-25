// WebGL2 小工具：着色器编译、程序链接、缓冲与 VAO。
export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error('Shader compile error', log, src);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

export interface MeshGL {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  indexType: number;
  buffers: WebGLBuffer[];
}

/** 上传 MeshData 到 GPU（位置/法线/颜色，交错或独立属性） */
export function uploadMesh(
  gl: WebGL2RenderingContext,
  m: { positions: Float32Array; normals?: Float32Array; colors?: Float32Array; indices: Uint32Array },
): MeshGL {
  const buffers: WebGLBuffer[] = [];
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer()!;
  buffers.push(posBuf);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  if (m.normals) {
    const nBuf = gl.createBuffer()!;
    buffers.push(nBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, nBuf);
    gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  } else {
    // 没有法线时给常量
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 0, 1, 0);
  }

  if (m.colors) {
    const cBuf = gl.createBuffer()!;
    buffers.push(cBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, cBuf);
    gl.bufferData(gl.ARRAY_BUFFER, m.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  } else {
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib3f(2, 0.8, 0.82, 0.85);
  }

  const iBuf = gl.createBuffer()!;
  buffers.push(iBuf);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, iBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, indexCount: m.indices.length, indexType: gl.UNSIGNED_INT, buffers };
}

export function makeLineVAO(gl: WebGL2RenderingContext, positions: Float32Array): { vao: WebGLVertexArrayObject; count: number } {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, count: positions.length / 3 };
}
