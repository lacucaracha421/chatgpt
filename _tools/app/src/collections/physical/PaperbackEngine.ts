import { makePaperback } from "./paperbackGeometry";
import { vertexShader, fragmentShader, shadowVertex, shadowFragment } from "./paperbackShaders";
import { loadCoverImage } from "./loadCoverImage";
export const PAPERBACK_FINAL = { depth: .12, rx: .13, ry: .34, rz: .005, bakeRy: .40 } as const;
export type BookTexture = { texture: WebGLTexture; ratio: number; bytes: number };
export type BookPose = { rx?: number; ry?: number; rz?: number; width: number; height: number; zoom?: number; bake?: boolean };
function multiply(a: ArrayLike<number>, b: ArrayLike<number>) {
  const out = new Float32Array(16);
  for(let j=0;j<4;j++) for(let i=0;i<4;i++) for(let k=0;k<4;k++) out[j*4+i]+=a[k*4+i]*b[j*4+k];
  return out;
}
function rotation(rx: number, ry: number, rz: number) {
  const x=[1,0,0,0,0,Math.cos(rx),Math.sin(rx),0,0,-Math.sin(rx),Math.cos(rx),0,0,0,0,1];
  const y=[Math.cos(ry),0,-Math.sin(ry),0,0,1,0,0,Math.sin(ry),0,Math.cos(ry),0,0,0,0,1];
  const z=[Math.cos(rz),Math.sin(rz),0,0,-Math.sin(rz),Math.cos(rz),0,0,0,0,1,0,0,0,0,1];
  return multiply(z,multiply(y,x));
}
function camera(aspect: number, zoom: number) {
  const f=1/Math.tan(.49/2)*zoom,n=.1,far=30;
  return multiply([f/aspect,0,0,0,0,f,0,0,0,0,(far+n)/(n-far),-1,0,0,2*far*n/(n-far),0],[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-5.7,1]);
}
/** One shared instance is owned by collectibleRuntime, never by a tile. */
export class PaperbackEngine {
  readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram; private shadow!: WebGLProgram;
  private vao!: WebGLVertexArrayObject; private vbo!: WebGLBuffer; private ebo!: WebGLBuffer;
  private shadowVao!: WebGLVertexArrayObject; private shadowVbo!: WebGLBuffer;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private shadowVP: WebGLUniformLocation | null = null;
  private textures = new Map<string, BookTexture>();
  private indexCount = 0; private meshBytes = 0; private textureBytes = 0;
  disposed = false; frames = 0; liveFrames = 0; bakeFrames = 0;
  constructor(readonly canvas: HTMLCanvasElement) {
    if (typeof WebGL2RenderingContext === "undefined") throw new Error("WebGL2 unavailable");
    const gl = canvas.getContext("webgl2", { alpha:true, antialias:true, premultipliedAlpha:false, depth:true, stencil:false, preserveDrawingBuffer:false, powerPreference:"low-power" });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    try { this.initialize(); } catch(error) { this.dispose(); throw error; }
  }
  private compile(vertex: string, fragment: string) {
    const g = this.gl, shaders: WebGLShader[] = [], program = g.createProgram();
    if (!program) throw new Error("WebGL program allocation failed");
    try {
      for (const [kind, source] of [[g.VERTEX_SHADER,vertex],[g.FRAGMENT_SHADER,fragment]] as const) {
        const shader = g.createShader(kind); if (!shader) throw new Error("Shader allocation failed");
        shaders.push(shader); g.shaderSource(shader,source); g.compileShader(shader);
        if (!g.getShaderParameter(shader,g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(shader)||"Shader compilation failed");
        g.attachShader(program,shader);
      }
      g.linkProgram(program);
      if (!g.getProgramParameter(program,g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(program)||"Shader link failed");
      return program;
    } catch(error) { g.deleteProgram(program); throw error; }
    finally { for(const shader of shaders) g.deleteShader(shader); }
  }
  private initialize() {
    const g = this.gl;
    this.program=this.compile(vertexShader,fragmentShader); this.shadow=this.compile(shadowVertex,shadowFragment);
    for(const name of ["uModel","uVP","uShape","uCover","uDepth"]) this.uniforms[name]=g.getUniformLocation(this.program,name);
    this.vao=g.createVertexArray()!; this.vbo=g.createBuffer()!; this.ebo=g.createBuffer()!;
    g.bindVertexArray(this.vao); g.bindBuffer(g.ARRAY_BUFFER,this.vbo); g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,this.ebo);
    for(const [location,size,offset] of [[0,3,0],[1,3,12],[2,2,24],[3,1,32]]) { g.enableVertexAttribArray(location); g.vertexAttribPointer(location,size,g.FLOAT,false,36,offset); }
    const mesh=makePaperback(); this.indexCount=mesh.indices.length; this.meshBytes=mesh.vertices.byteLength+mesh.indices.byteLength;
    g.bufferData(g.ARRAY_BUFFER,mesh.vertices,g.STATIC_DRAW); g.bufferData(g.ELEMENT_ARRAY_BUFFER,mesh.indices,g.STATIC_DRAW);
    this.shadowVao=g.createVertexArray()!; this.shadowVbo=g.createBuffer()!; g.bindVertexArray(this.shadowVao);
    g.bindBuffer(g.ARRAY_BUFFER,this.shadowVbo); g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]),g.STATIC_DRAW);
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0,2,g.FLOAT,false,0,0); this.shadowVP=g.getUniformLocation(this.shadow,"uVP");
  }
  async texture(key: string, src: string, maxEdge: number, signal?: AbortSignal): Promise<BookTexture> {
    const id=`${key}|${maxEdge}`, cached=this.textures.get(id);
    if(cached) { this.textures.delete(id); this.textures.set(id,cached); return cached; }
    const image=await loadCoverImage(src,signal), canvas=document.createElement("canvas");
    try {
      if(this.disposed||signal?.aborted) throw new DOMException("Cancelled","AbortError");
      const scale=Math.min(1,maxEdge/Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext("2d"); if(!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const bytes=Math.ceil(canvas.width*canvas.height*4*4/3);
      while(this.textures.size>=4||this.textureBytes+bytes>12*1024*1024) { const first=this.textures.keys().next().value; if(first===undefined) break; this.dropTexture(first); }
      const g=this.gl; if(g.isContextLost()) throw new Error("Context lost");
      const texture=g.createTexture(); if(!texture) throw new Error("Texture allocation failed");
      g.bindTexture(g.TEXTURE_2D,texture); g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL,true);
      try { g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,canvas); } catch(error) { g.deleteTexture(texture); throw error; }
      g.generateMipmap(g.TEXTURE_2D); g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.LINEAR_MIPMAP_LINEAR); g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.LINEAR);
      g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
      const entry={texture,ratio:image.naturalWidth/image.naturalHeight,bytes}; this.textures.set(id,entry); this.textureBytes+=bytes; return entry;
    } finally { image.src=""; canvas.width=canvas.height=0; }
  }
  draw(entry: BookTexture, pose: BookPose) {
    const g=this.gl; if(this.disposed||g.isContextLost()) throw new Error("Book renderer unavailable");
    const width=Math.max(1,Math.round(pose.width)),height=Math.max(1,Math.round(pose.height));
    if(this.canvas.width!==width) this.canvas.width=width;
    if(this.canvas.height!==height) this.canvas.height=height;
    g.viewport(0,0,width,height); g.clearColor(0,0,0,0); g.clear(g.COLOR_BUFFER_BIT|g.DEPTH_BUFFER_BIT);
    g.enable(g.DEPTH_TEST); g.depthFunc(g.LEQUAL); g.disable(g.CULL_FACE);
    const vp=camera(width/height,pose.zoom??1.08);
    g.enable(g.BLEND); g.blendFuncSeparate(g.SRC_ALPHA,g.ONE_MINUS_SRC_ALPHA,g.ONE,g.ONE_MINUS_SRC_ALPHA); g.depthMask(false);
    g.useProgram(this.shadow); g.bindVertexArray(this.shadowVao); g.uniformMatrix4fv(this.shadowVP,false,vp); g.drawArrays(g.TRIANGLES,0,6);
    g.depthMask(true); g.disable(g.BLEND); g.useProgram(this.program); g.bindVertexArray(this.vao);
    g.uniformMatrix4fv(this.uniforms.uVP,false,vp);
    g.uniformMatrix4fv(this.uniforms.uModel,false,rotation(pose.rx??PAPERBACK_FINAL.rx,pose.ry??PAPERBACK_FINAL.ry,pose.rz??PAPERBACK_FINAL.rz));
    g.uniform3f(this.uniforms.uShape,entry.ratio/.704,1,PAPERBACK_FINAL.depth/.16);
    g.uniform1f(this.uniforms.uDepth,PAPERBACK_FINAL.depth);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D,entry.texture); g.uniform1i(this.uniforms.uCover,0);
    g.drawElements(g.TRIANGLES,this.indexCount,g.UNSIGNED_SHORT,0);
    this.frames++; if(pose.bake) this.bakeFrames++; else this.liveFrames++;
  }
  private dropTexture(key: string) { const entry=this.textures.get(key); if(!entry) return; this.gl.deleteTexture(entry.texture); this.textureBytes-=entry.bytes; this.textures.delete(key); }
  clearTextures() { for(const key of [...this.textures.keys()]) this.dropTexture(key); }
  stats() { return { contexts:this.disposed?0:1, triangles:this.indexCount/3, meshBytes:this.meshBytes, textureCount:this.textures.size, textureBytes:this.textureBytes, frames:this.frames, liveFrames:this.liveFrames, bakeFrames:this.bakeFrames }; }
  shrink() { this.canvas.width=this.canvas.height=2; }
  dispose() {
    if(this.disposed) return; this.disposed=true; this.clearTextures(); const g=this.gl;
    for(const buffer of [this.vbo,this.ebo,this.shadowVbo]) if(buffer) g.deleteBuffer(buffer);
    for(const vao of [this.vao,this.shadowVao]) if(vao) g.deleteVertexArray(vao);
    for(const program of [this.program,this.shadow]) if(program) g.deleteProgram(program);
    this.shrink();
  }
}
