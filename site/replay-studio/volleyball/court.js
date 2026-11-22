/* Synthetic input for Volleyball Mode. The crop controller only receives observations. */
(() => {
  'use strict';
  const duration = 16;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const lerp = (a, b, u) => a + (b - a) * u;
  const full = { x: 0, y: 0, size: 1 };
  const touches = [
    [0, .25, .90], [1.55, .65, .12], [2.85, .39, .38], [3.9, .72, .46],
    [4.75, .68, .59], [6.05, .29, .86], [7.4, .46, .59], [8.55, .29, .53],
    [9.4, .52, .39], [10.55, .78, .17], [11.9, .59, .42], [13.05, .77, .45],
    [14.05, .38, .72], [15.3, .28, .64], [16, .48, .57]
  ];
  const positions = [[.25,.88],[.7,.82],[.47,.68],[.25,.56],[.71,.56],[.46,.59],
    [.65,.13],[.25,.15],[.78,.28],[.39,.40],[.72,.44],[.49,.44]];

  function project(x, depth, z, angle) {
    if (angle === 'sideline') {
      const near = .2 + .8 * x;
      return { x: .50 + (depth - .5) * (.69 + .22 * near), y: .57 + (x - .5) * .36 - z * (.11 + .035 * near) };
    }
    return { x: .50 + (x - .5) * (.45 + .57 * depth), y: .37 + .55 * depth - z * (.076 + .071 * depth) };
  }

  function mockFrame(time, angle = 'baseline') {
    const t = clamp(time, 0, duration);
    let next = touches.findIndex(k => k[0] > t);
    if (next < 0) next = touches.length - 1;
    const a = touches[next - 1], b = touches[next];
    const u = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
    const bx = lerp(a[1], b[1], u), depth = lerp(a[2], b[2], u);
    const height = 1.2 + (2.35 + .25 * Math.sin(next)) * 4 * u * (1-u);
    const ball = project(bx, depth, height, angle);
    const nearNet = Math.abs(depth - .5) < .115;
    const players = positions.map(([x,z], id) => {
      const px = x + .12 * (bx - x) + .018 * Math.sin(t * 1.65 + id * 2);
      const pz = z + .12 * (depth - z) + .012 * Math.cos(t * 1.9 + id);
      const feet = project(px, pz, 0, angle), head = project(px, pz, .94, angle);
      const w = (feet.y - head.y) * .22;
      return { id, px, pz, feet, head, left: feet.x - w, right: feet.x + w,
        top: head.y - .012, bottom: feet.y + .005, distance: Math.hypot(px-bx, pz-depth) };
    });
    const byDistance = players.slice().sort((p,q) => p.distance - q.distance);
    let involved = byDistance.slice(0,2);
    if (nearNet) involved = [byDistance.find(p => p.pz < .5), byDistance.find(p => p.pz >= .5)];
    const occluded = t >= 6 && t < 6.8;
    const glare = t >= 10.2 && t < 10.65;
    const observations = [];
    if (!occluded && !glare) observations.push({ x: ball.x + .0015*Math.sin(t*16),
      y: ball.y + .001*Math.cos(t*23), confidence: .94, color: .50 + .48*Math.sin(t*4) });
    if (glare || (t >= 3 && t < 4)) observations.push({ x: .91, y: .17, confidence: .65, color: .99 });
    return { ball, players, involved, nearNet, occluded, glare, observations };
  }

  function selectCandidate(candidates, previous, time) {
    const age = previous ? time - previous.time : Infinity;
    let best, top = -Infinity;
    for (const c of candidates) {
      if (c.confidence < (age > .10 ? .80 : .60)) continue;
      const distance = previous ? Math.hypot(c.x - previous.x, c.y - previous.y) : 0;
      if (age < .35 && distance > .048 + age * 1.35) continue;
      const score = c.confidence - (age < .35 ? distance*.7 : 0) + .018 * clamp(c.color || 0,0,1);
      if (score > top) { top = score; best = c; }
    }
    return best;
  }

  // All coordinates are fractions of the original frame, so a square in these
  // coordinates preserves the original display aspect ratio at any output size.
  function advance(state, obs, time, dt, angle) {
    const chosen = selectCandidate(obs.candidates, state.last, time);
    if (chosen) state.last = { x: chosen.x, y: chosen.y, time };
    const lost = !state.last || time - state.last.time > .10;
    const old = state.crop;
    let size = 1, cx = .5, cy = .5, bounds;
    if (!lost) {
      const p = state.last;
      let left = p.x - .03, right = p.x + .03, top = p.y - .045, bottom = p.y + .045;
      for (const player of obs.players) {
        left = Math.min(left, player.left - .035); right = Math.max(right, player.right + .035);
        top = Math.min(top, player.top - .025); bottom = Math.max(bottom, player.bottom + .035);
      }
      const margin = angle === 'sideline' ? .075 : .045;
      size = clamp(Math.max(right-left + margin, bottom-top + margin, obs.nearNet ? .73 : .60), .6, 1);
      cx = (left + right) / 2; cy = (top + bottom) / 2;
      bounds = { left: clamp(left,0,1), right: clamp(right,0,1), top: clamp(top,0,1), bottom: clamp(bottom,0,1) };
    }
    const ease = tau => 1 - Math.exp(-dt/tau);
    let side = lerp(old.size, size, ease(lost ? .080 : size > old.size ? .14 : .38));
    if (bounds) side = Math.max(side, bounds.right-bounds.left, bounds.bottom-bounds.top);
    let x = lerp(old.x+old.size/2, cx, ease(lost ? .08 : .23)) - side/2;
    let y = lerp(old.y+old.size/2, cy, ease(lost ? .08 : .23)) - side/2;
    if (bounds) {
      x = clamp(x, bounds.right-side, bounds.left);
      y = clamp(y, bounds.bottom-side, bounds.top);
    }
    state.crop = { x: clamp(x,0,1-side), y: clamp(y,0,1-side), size: side };
    return { crop: state.crop, detected: chosen, lost };
  }

  function analyzeMock(angle='baseline', fps=30) {
    if (!['baseline','sideline'].includes(angle) || ![30,60].includes(fps)) throw new RangeError('Unknown angle or analysis rate');
    const frames = [], state = { last: null, crop: full };
    for (let i=0;i<=duration*fps;i++) {
      const t=i/fps, scene=mockFrame(t,angle);
      frames.push(advance(state, { candidates:scene.observations, players:scene.involved, nearNet:scene.nearNet }, t,1/fps,angle));
    }
    return { angle, fps, frames };
  }
  const cache = new Map();
  function analysis(angle,fps) {
    const key=angle+fps;
    if (!cache.has(key)) cache.set(key, analyzeMock(angle,fps));
    return cache.get(key);
  }
  function cropAt(data,time) {
    const n=clamp(time,0,duration)*data.fps, i=Math.floor(n);
    const a=data.frames[i].crop, b=data.frames[Math.min(i+1,data.frames.length-1)].crop;
    return { x:lerp(a.x,b.x,n-i), y:lerp(a.y,b.y,n-i), size:lerp(a.size,b.size,n-i) };
  }

  function renderMock(canvas, time, {angle='baseline',view='full',fps=30}={}) {
    const ctx=canvas.getContext('2d'), W=960, H=540;
    const t=clamp(time,0,duration), scene=mockFrame(t,angle);
    const crop=view==='follow'?cropAt(analysis(angle,fps),t):full;
    const pt=(x,d,z=0)=>project(x,d,z,angle);
    const dot=(p,r,color)=>{ctx.fillStyle=color;ctx.beginPath();ctx.arc(p.x*W,p.y*H,r,0,2*Math.PI);ctx.fill();};
    function line(points,color,width,close=false,fill=null) {
      ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x*W,p.y*H):ctx.moveTo(p.x*W,p.y*H));
      if(close)ctx.closePath(); if(fill){ctx.fillStyle=fill;ctx.fill();}
      if(width){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
    }
    ctx.save(); ctx.setTransform(canvas.width/W/crop.size,0,0,canvas.height/H/crop.size,-crop.x*canvas.width/crop.size,-crop.y*canvas.height/crop.size);
    const wall=ctx.createLinearGradient(0,0,0,H);wall.addColorStop(0,'#15383a');wall.addColorStop(.33,'#356560');wall.addColorStop(.34,'#8eb3a4');wall.addColorStop(1,'#285f5a');
    ctx.fillStyle=wall;ctx.fillRect(0,0,W,H);
    for(let i=0;i<7;i++) {ctx.fillStyle=i%2?'#497370':'#527c73';ctx.fillRect(0,95+i*9,W,6);}
    const tile=(x0,z0,x1,z1)=>[pt(x0,z0),pt(x1,z0),pt(x1,z1),pt(x0,z1)];
    line(tile(0,0,1,1),'#f5e8c8',3,true,'#d59c65');
    for(let i=0;i<12;i++) line(tile(0,i/12,1,(i+1)/12),null,0,true,i%2?'#dba673':'#d7a06a');
    line(tile(0,0,1,1),'#fff4d6',2.6,true);
    [1/3,.5,2/3].forEach(z=>line([pt(0,z),pt(1,z)],'#fff3d8',2));
    function drawPerson(p) {
      const f=p.feet,h=p.head, v=f.y-h.y, shirt=p.id<6?'#1b676d':'#ab463f', s=Math.sin(t*6+p.id)*.003;
      const n=(x,y)=>({x:f.x+x,y:h.y+y*v});
      line([n(-.010+s,1),n(-.004,.62),n(.005,.63),n(.012-s,1)],'#1b3039',4.0);
      line([n(-.018,.47),n(-.010,.28),n(.01,.28),n(.02,.46)],'#81573c',3.7);
      line([n(-.011,.23),n(.01,.23),n(.007,.59),n(-.007,.59)],null,0,true,shirt);
      dot(n(0,.11),Math.max(2.5,v*H*.105),'#b7835f');
    }
    const people=scene.players.slice().sort((a,b)=>a.feet.y-b.feet.y);
    const drawNet=()=>{
      for(let i=0;i<=25;i++)line([pt(i/25,.5,1.01),pt(i/25,.5,1.65)],'#48605e',.7);
      for(let i=0;i<=4;i++)line([pt(0,.5,1.01+i*.16),pt(1,.5,1.01+i*.16)],'#546764',.8);
      line([pt(-.045,.5,1.65),pt(1.045,.5,1.65)],'#f4eddb',3);
      [-.045,1.045].forEach(x=>line([pt(x,.5),pt(x,.5,1.72)],'#173e42',4));
    };
    if(angle==='baseline'){
      people.filter(p=>p.pz<.5).forEach(drawPerson);drawNet();people.filter(p=>p.pz>=.5).forEach(drawPerson);
    }else{drawNet();people.forEach(drawPerson);}
    if(!scene.occluded) {
      const b=scene.ball,r=5.7;
      dot(b,r,'#242a23');dot(b,r-1,'#f8df41');
      ctx.strokeStyle='#242a23';ctx.lineWidth=1.6;ctx.beginPath();
      ctx.ellipse(b.x*W,b.y*H,r*.51,r*.83,t*3,0,Math.PI*2);ctx.stroke();
    }
    if(scene.glare) {
      const g=ctx.createRadialGradient(.91*W,.17*H,2,.91*W,.17*H,75);
      g.addColorStop(0,'rgba(255,255,223,.92)');g.addColorStop(1,'rgba(255,255,223,0)');
      ctx.fillStyle=g;ctx.fillRect(.91*W-75,.17*H-75,150,150);
    }
    ctx.restore();
    return {time:t,crop};
  }
  const api={duration,renderMock,mockFrame,selectCandidate,advance,analyzeMock,cropAt};
  if(typeof module==='object' && module.exports) module.exports=api;
  if(typeof window==='object') window.FGSVolleyball=api;
})();
