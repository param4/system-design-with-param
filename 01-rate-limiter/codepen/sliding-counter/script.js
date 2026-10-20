(function(){
const W=10, LIMIT=5, CAP=5, RATE=LIMIT/W, SPAN=20, LEAK=1/RATE;
const T0=performance.now()-22000; // clock starts at 22s so the timeline has history
const now=()=> (performance.now()-T0)/1000;
const fmt=t=>t.toFixed(1);

const ALG={
  fixed:{
    title:"Fixed window",
    init:()=>({ws:-1,count:0}),
    roll(s,t){const ws=Math.floor(t/W)*W; if(ws!==s.ws){s.ws=ws;s.count=0;}},
    req(s,t){this.roll(s,t); if(s.count<LIMIT){s.count++;return"ok";} return"bad";},
    view(s,t){this.roll(s,t); return `<span>window ${fmt(s.ws)}–${fmt(s.ws+W)} s</span><span>count ${cells(s.count,LIMIT)} ${s.count}/${LIMIT}</span><span class="muted">resets in ${fmt(s.ws+W-t)} s</span>`;}
  },
  log:{
    title:"Sliding log",
    init:()=>({log:[]}),
    prune(s,t){s.log=s.log.filter(x=>x>t-W);},
    req(s,t){this.prune(s,t); if(s.log.length<LIMIT){s.log.push(t);return"ok";} return"bad";},
    view(s,t){this.prune(s,t); const chips=s.log.map(x=>`<span class="chip">−${fmt(t-x)}s</span>`).join("")||'<span class="muted">empty</span>';
      const next=s.log.length>=LIMIT?`<span class="muted">next slot in ${fmt(s.log[0]+W-t)} s</span>`:"";
      return `<span>log ${s.log.length}/${LIMIT}</span><span>${chips}</span>${next}`;}
  },
  counter:{
    title:"Sliding counter",
    init:()=>({ws:-1,curr:0,prev:0}),
    roll(s,t){const ws=Math.floor(t/W)*W; if(ws!==s.ws){s.prev=(ws-s.ws===W)?s.curr:0; s.curr=0; s.ws=ws;}},
    est(s,t){return s.prev*(1-(t-s.ws)/W)+s.curr;},
    req(s,t){this.roll(s,t); if(this.est(s,t)<LIMIT){s.curr++;return"ok";} return"bad";},
    view(s,t){this.roll(s,t); const w=1-(t-s.ws)/W, e=this.est(s,t);
      return `<span>prev ${s.prev} × ${(w*100).toFixed(0)}% + curr ${s.curr}</span><span>= <strong>${e.toFixed(2)}</strong> / ${LIMIT}</span><span class="${e>=LIMIT?'stat-bad':'stat-ok'}">${e>=LIMIT?'next → 429':'next → allowed'}</span>`;}
  },
  token:{
    title:"Token bucket",
    init:t=>({tokens:CAP,last:t}),
    refill(s,t){s.tokens=Math.min(CAP,s.tokens+(t-s.last)*RATE); s.last=t;},
    req(s,t){this.refill(s,t); if(s.tokens>=1){s.tokens-=1;return"ok";} return"bad";},
    view(s,t){this.refill(s,t); const wait=s.tokens>=1?0:(1-s.tokens)/RATE;
      return `<span>bucket ${cells(s.tokens,CAP)}</span><span>tokens ${s.tokens.toFixed(2)} / ${CAP}</span><span class="muted">+${RATE} per s${wait?` · next token in ${fmt(wait)} s`:""}</span>`;}
  },
  leaky:{
    title:"Leaky bucket",
    init:()=>({q:[],next:0}),
    tick(s,t){while(s.q.length&&t>=s.next){const e=s.q.shift(); e.status="ok"; e.served=s.next; s.next+=LEAK;}},
    req(s,t,e){this.tick(s,t); if(!s.q.length&&t>=s.next){s.next=t+LEAK; e.served=t; return"ok";}
      if(s.q.length<CAP){s.q.push(e);return"queued";} return"bad";},
    view(s,t){this.tick(s,t);
      return `<span>queue ${cells(s.q.length,CAP,true)} ${s.q.length}/${CAP}</span><span class="muted">${s.q.length?`next drip in ${fmt(Math.max(0,s.next-t))} s`:"idle"} · drains 1 per ${LEAK} s</span>`;}
  }
};
function cells(v,n,q){let h='<span class="cells">';for(let i=0;i<n;i++){const f=Math.max(0,Math.min(1,v-i));h+=`<span class="cell${q?' q':''}"><i style="height:${(f*100).toFixed(0)}%"></i></span>`;}return h+'</span>';}

const sims=[];
function build(el){
  const kind=el.dataset.sim, a=ALG[kind];
  el.innerHTML=`<div class="sim-top"><span class="sim-label">Simulator · ${a.title} · 5 per 10 s</span>
    <div class="btns"><button type="button" class="primary" data-a="one">Send 1</button><button type="button" data-a="burst">Burst of 8</button><button type="button" class="attack" data-a="edge">Edge attack</button><button type="button" data-a="reset">Reset</button></div></div>
    <canvas aria-label="${a.title} timeline of the last 20 seconds"></canvas>
    <div class="state" aria-live="off"></div>
    <div class="note"></div>`;
  const s={kind,a,el,cv:el.querySelector("canvas"),stateEl:el.querySelector(".state"),note:el.querySelector(".note"),ev:[],st:null,timers:[]};
  s.reset=()=>{s.timers.forEach(clearTimeout);s.timers=[];s.ev=[];s.st=a.init(now());s.note.textContent="";};
  s.send=(t)=>{t=t??now(); const e={t,lane:0,status:null};
    const near=s.ev.filter(x=>Math.abs(x.t-t)<0.45).length; e.lane=near%5;
    e.status=a.req(s.st,t,e); s.ev.push(e); if(s.ev.length>300)s.ev.splice(0,100);};
  s.edge=(B)=>{const t=now(); if(B==null){B=Math.ceil(t/W)*W; if(B-t<1.3)B+=W;}
    [-.5,-.4,-.3,-.2,-.1,.1,.2,.3,.4,.5].forEach(d=>{s.timers.push(setTimeout(()=>s.send(),(B+d-now())*1000));});
    s.note.textContent=`Edge attack armed: 5 requests just before t=${B}s, 5 just after.`;
    s.timers.push(setTimeout(()=>{s.note.textContent=summary(s);},(B+0.8-now())*1000));
    return B;};
  el.addEventListener("click",ev=>{const b=ev.target.closest("button");if(!b)return;
    const act=b.dataset.a;
    if(act==="one")s.send();
    if(act==="burst"){for(let i=0;i<8;i++)s.timers.push(setTimeout(()=>s.send(),i*60));}
    if(act==="edge")s.edge();
    if(act==="reset")s.reset();});
  // sample traffic
  s.st=a.init(0);
  [1.0,1.3,1.6,4.0,8.6,9.0,9.2,9.4,9.6,10.2,10.4,10.6,10.8,11.0,15.5,18.0,18.3,18.6,18.9,19.2,19.5,21.0].forEach(t=>{if(a.tick)a.tick(s.st,t); s.send(t);});
  sims.push(s);
}
function summary(s){const ok=s.ev.filter(e=>e.status==="ok").length,bad=s.ev.filter(e=>e.status==="bad").length,q=s.ev.filter(e=>e.status==="queued").length;
  return `So far: ${ok} allowed, ${bad} rejected${q?`, ${q} waiting in queue`:""}.`;}

document.querySelectorAll(".sim").forEach(build);

function draw(s,t,c){
  const cv=s.cv, dpr=window.devicePixelRatio||1, w=cv.clientWidth, h=cv.clientHeight;
  if(!w)return;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);}
  const g=cv.getContext("2d"); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
  const L=6,R=w-14, base=h-24, top=10, t0=t-SPAN;
  const X=v=>L+(v-t0)/SPAN*(R-L);
  const shade=(a,b,col)=>{const x1=Math.max(L,X(a)),x2=Math.min(R,X(b)); if(x2>x1){g.fillStyle=col;g.fillRect(x1,top-4,x2-x1,base-top+4);}};
  g.font="11px "+c.mono;
  const st=s.st;
  if(s.kind==="fixed"){shade(st.ws,st.ws+W,c.cyanSoft);}
  if(s.kind==="log"){shade(t-W,t,c.violetSoft); g.fillStyle=c.violet; g.fillText("last 10 s",X(t-W)+4,top+8);}
  if(s.kind==="counter"){shade(st.ws,t,c.cyanSoft); shade(t-W,st.ws,c.violetSoft); g.fillStyle=c.violet; const wt=1-(t-st.ws)/W;
    if(X(st.ws)-X(t-W)>60)g.fillText(`prev × ${(wt*100).toFixed(0)}%`,X(t-W)+4,top+8);}
  // window boundaries
  g.strokeStyle=c.line; g.setLineDash([3,4]); g.lineWidth=1;
  for(let b=Math.ceil(t0/W)*W;b<=t;b+=W){const x=X(b); g.beginPath(); g.moveTo(x,top-4); g.lineTo(x,base); g.stroke();}
  g.setLineDash([]);
  // axis
  g.strokeStyle=c.line; g.beginPath(); g.moveTo(L,base); g.lineTo(R,base); g.stroke();
  g.fillStyle=c.muted;
  for(let k=Math.ceil(t0/5)*5;k<=t;k+=5){const x=X(k); g.fillRect(x,base,1,4); g.fillText(k+"s",Math.min(x-8,R-28),base+16);}
  g.fillStyle=c.cyan; g.fillRect(R,top-4,2,base-top+4);
  // events
  const laneY=l=>base-12-l*15;
  for(const e of s.ev){ if(e.t<t0-1 && !(e.served && e.served>t0))continue;
    const x=X(e.t), y=laneY(e.lane);
    if(e.status==="bad"){g.strokeStyle=c.bad; g.lineWidth=2; g.beginPath(); g.moveTo(x-4,y-4);g.lineTo(x+4,y+4);g.moveTo(x+4,y-4);g.lineTo(x-4,y+4); g.stroke();}
    else if(s.kind==="leaky" && (e.status==="queued" || (e.served!=null && e.served-e.t>0.05))){
      g.strokeStyle=c.warn; g.lineWidth=2; g.beginPath(); g.arc(x,y,4.5,0,7); g.stroke();
      if(e.status==="ok"){const xs=X(Math.min(e.served,t)); g.setLineDash([2,3]); g.beginPath(); g.moveTo(x+5,y); g.lineTo(xs-5,y); g.stroke(); g.setLineDash([]);
        g.fillStyle=c.ok; g.beginPath(); g.arc(xs,y,4.5,0,7); g.fill();}
      else {g.setLineDash([2,3]); g.beginPath(); g.moveTo(x+5,y); g.lineTo(R,y); g.stroke(); g.setLineDash([]);}
    }
    else {g.fillStyle=c.ok; g.beginPath(); g.arc(x,y,4.5,0,7); g.fill();}
  }
}
function colors(){const cs=getComputedStyle(document.documentElement),v=n=>cs.getPropertyValue(n).trim();
  return {ok:v("--ok"),bad:v("--bad"),warn:v("--warn"),cyan:v("--cyan"),violet:v("--violet"),line:v("--line"),muted:v("--muted"),cyanSoft:v("--cyan-soft"),violetSoft:v("--violet-soft"),mono:v("--f-mono")};}
let lastState=0;
function frame(){const t=now(), c=colors(), doState=performance.now()-lastState>120;
  for(const s of sims){ if(s.a.tick)s.a.tick(s.st,t); draw(s,t,c); if(doState)s.stateEl.innerHTML=s.a.view(s.st,t);}
  if(doState)lastState=performance.now();
  requestAnimationFrame(frame);}
requestAnimationFrame(frame);

})();
