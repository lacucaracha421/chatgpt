// Approved Paperback FINAL geometry. Printed artwork belongs only to the front.
// One reusable mesh; paper layers are shaded, never modelled sheet by sheet.
type Vec = number[];
type Surface = (u: number, v: number) => Vec;
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const sub = (a: Vec, b: Vec) => a.map((v, i) => v - b[i]);
const cross = (a: Vec, b: Vec) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = (a: Vec) => { const length = Math.hypot(...a) || 1; return a.map(v => v / length); };
export function makePaperback(ratio = .704, depth = .16) {
  const vertices: number[] = [], indices: number[] = [];
  const w = 2 * ratio, half = depth / 2, cover = .0055;
  function surface(fn: Surface, nu: number, nv: number, kind: number, reverse = false) {
    const start = vertices.length / 9, eps = .0001;
    for (let y = 0; y <= nv; y++) for (let x = 0; x <= nu; x++) {
      const u = x/nu, v = y/nv, p = fn(u,v);
      const du = sub(fn(clamp(u+eps,0,1),v),fn(clamp(u-eps,0,1),v));
      const dv = sub(fn(u,clamp(v+eps,0,1)),fn(u,clamp(v-eps,0,1)));
      let normal = norm(cross(du,dv)); if (reverse) normal = normal.map(n => -n);
      vertices.push(...p,...normal,u,v,kind);
    }
    for (let y = 0; y < nv; y++) for (let x = 0; x < nu; x++) {
      const a = start+y*(nu+1)+x, b = a+1, c = a+nu+2, d = a+nu+1;
      if (reverse) indices.push(a,c,b,a,d,c); else indices.push(a,b,c,a,c,d);
    }
  }
  function xy(u: number, v: number) {
    const y = (v-.5)*2, radius = .014, cap = Math.max(0,Math.abs(y)-(1-radius));
    const inset = radius-Math.sqrt(Math.max(0,radius*radius-cap*cap));
    return [(u-.5)*(w-2*inset),y];
  }
  function shell(side: number, inner = false): Surface {
    return (u,v) => {
      const [x,y] = xy(u,v), dist = x+w/2;
      const groove = .006*Math.exp(-Math.pow((dist-.052)/.021,2));
      const bow = .006*Math.sin(u*Math.PI)*Math.pow(Math.cos((v-.5)*Math.PI),2)+.004*Math.pow(u,12);
      return [x,y,side*(half+.012+bow-groove+(inner?0:cover))];
    };
  }
  for (const side of [1,-1]) {
    const f = shell(side), g = shell(side,true);
    surface(f,36,12,side===1?0:4,side<0); surface(g,36,6,2,side>0);
    for (const edge of [0,1,2,3]) surface((t,s) => {
      const uv = edge===0?[t,0]:edge===1?[1,t]:edge===2?[1-t,1]:[0,1-t];
      const a = f(uv[0],uv[1]), b = g(uv[0],uv[1]);
      return a.map((p,i) => p*(1-s)+b[i]*s);
    },edge%2?12:36,1,3,side<0);
  }
  surface((u,v) => [-w/2-.005-.012*Math.sin(u*Math.PI),(v-.5)*2,(u-.5)*(depth+.032)],24,8,4,true);
  const e = [w/2-.013,1-.014,half-.001], rad = .004;
  for (let axis=0;axis<3;axis++) for (const sign of [-1,1]) {
    const a = (axis+1)%3, b = (axis+2)%3;
    surface((u,v) => {
      const p = [0,0,0]; p[axis]=sign*e[axis]; p[a]=(u-.5)*2*e[a]; p[b]=(v-.5)*2*e[b];
      const q=p.map((value,i)=>clamp(value,-e[i]+rad,e[i]-rad)), d=norm(sub(p,q));
      return q.map((value,i)=>value+d[i]*rad);
    },axis===0?14:axis===1?28:20,axis===0?18:axis===1?20:16,axis===2?2:1,sign<0);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), triangles: indices.length/3 };
}
