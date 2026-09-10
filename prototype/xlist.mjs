import fs from 'node:fs'; import { absolutize } from './geom.mjs';
const EPS=1e-6, cr=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
const pi=(p1,p2,p3,p4)=>{const d1=cr(p3,p4,p1),d2=cr(p3,p4,p2),d3=cr(p1,p2,p3),d4=cr(p1,p2,p4);return((d1>EPS&&d2<-EPS)||(d1<-EPS&&d2>EPS))&&((d3>EPS&&d4<-EPS)||(d3<-EPS&&d4>EPS));};
for (const v of process.argv.slice(2)) {
  const {ports,edges}=absolutize(JSON.parse(fs.readFileSync(`/tmp/elk-proto/out-${v}.json`,'utf8')));
  const nm=e=>`${ports.get(e.src).node}>${ports.get(e.tgt).node}`; const cnt={};
  for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){const a=edges[i],b=edges[j];
    for(let p=0;p<a.pts.length-1;p++)for(let q=0;q<b.pts.length-1;q++)if(pi(a.pts[p],a.pts[p+1],b.pts[q],b.pts[q+1])){const k=nm(a)+' x '+nm(b);cnt[k]=(cnt[k]||0)+1;}}
  console.log(v, JSON.stringify(cnt));
}
