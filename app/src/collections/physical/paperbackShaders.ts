// Material and lighting from the approved FINAL; no fabricated spine/back printing.
export const vertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal; layout(location=2) in vec2 aUV; layout(location=3) in float aKind;
uniform mat4 uModel; uniform mat4 uVP; uniform vec3 uShape;
out vec3 vWorld; out vec3 vNormal; out vec3 vLocal; out vec2 vUV; flat out int vKind;
void main(){ vec3 p=aPos*uShape; vec3 n=normalize(aNormal/uShape); p.x*=-1.0; n.x*=-1.0;
 vec4 w=uModel*vec4(p,1.0); vWorld=w.xyz; vNormal=mat3(uModel)*n; vLocal=aPos*uShape;
 vUV=vec2(1.0-aUV.x,aUV.y); vKind=int(aKind+.1); gl_Position=uVP*w; }`;
export const fragmentShader = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec3 vLocal; in vec2 vUV; flat in int vKind;
uniform sampler2D uCover; uniform float uDepth; out vec4 outColor;
const float PI=3.14159265;
vec3 light(vec3 base,vec3 N,vec3 V,vec3 L,vec3 C,float rough,float f0){
 vec3 H=normalize(V+L); float nl=max(dot(N,L),0.0),nv=max(dot(N,V),.01),nh=max(dot(N,H),0.0),vh=max(dot(V,H),0.0);
 float a=rough*rough,a2=a*a,d=a2/(PI*pow(nh*nh*(a2-1.0)+1.0,2.0)+.00001),k=pow(rough+1.0,2.0)/8.0;
 float g=(nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k)); float f=f0+(1.0-f0)*pow(1.0-vh,5.0);
 return (base/PI+d*g*f/(4.0*nl*nv+.0001))*C*nl;
}
void main(){
 vec3 N=normalize(vNormal),V=normalize(vec3(0.0,0.0,5.7)-vWorld); if(dot(N,V)<0.0)N=-N;
 vec3 base; float rough=.8,f0=.025;
 if(vKind==0){base=pow(texture(uCover,vUV).rgb,vec3(2.2)); rough=.33; f0=.033;}
 else if(vKind==1){
  float q=(vLocal.z/uDepth+.5)*142.0; float aa=1.0-smoothstep(.15,.8,fwidth(q));
  float fine=cos(q*6.283)*.022*aa; float folds=sin(q*.39)*.014+sin(q*.18+vLocal.y*7.0)*.004;
  float edgeAO=1.0-.16*pow(clamp(abs(vLocal.z)/(uDepth*.5),0.0,1.0),9.0);
  base=pow(vec3(.82,.81,.77)+fine+folds,vec3(2.2))*edgeAO; rough=.94; f0=.012;
 } else if(vKind==2){base=pow(vec3(.78,.77,.73),vec3(2.2));}
 else if(vKind==3){base=pow(vec3(.69,.69,.64),vec3(2.2)); rough=.65;}
 else {base=pow(vec3(.23,.25,.25),vec3(2.2)); rough=.33; f0=.033;}
 vec3 L1=normalize(vec3(-2.2,3.0,4.2));
 vec3 color=base*(.34+.09*max(N.y,0.0));
 color+=light(base,N,V,L1,vec3(1.65,1.6,1.50),rough,f0);
 color+=light(base,N,V,normalize(vec3(4.0,.6,3.0)),vec3(.50,.57,.65),rough,f0);
 color+=light(base,N,V,normalize(vec3(-1.0,3.0,-3.0)),vec3(.7,.7,.67),rough,f0);
 if(vKind==0||vKind==4){
  vec3 R=reflect(-V,N); float panel=pow(max(dot(R,normalize(vec3(-.50,.7,1.6))),0.0),mix(22.0,85.0,1.0-rough));
  float fres=.03+.20*pow(1.0-max(dot(N,V),0.0),5.0); color+=vec3(1.0,.98,.93)*panel*fres*2.0*.82;
 }
 outColor=vec4(pow(max(color,vec3(0.0)),vec3(1.0/2.2)),1.0);
}`;
export const shadowVertex = `#version 300 es
precision highp float; layout(location=0) in vec2 a; uniform mat4 uVP; out vec2 v;
void main(){v=a;gl_Position=uVP*vec4(a.x*1.1,-1.03,a.y*.85,1.0);}`;
export const shadowFragment = `#version 300 es
precision highp float; in vec2 v; out vec4 outColor;
void main(){float a=exp(-v.x*v.x*3.1-v.y*v.y*20.0)*.35+exp(-v.x*v.x*3.9-v.y*v.y*130.0)*.23;outColor=vec4(0.0,0.0,0.0,a);}`;
