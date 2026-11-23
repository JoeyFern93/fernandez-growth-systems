// All times are monotonic milliseconds. Keep the lowest RTT sample from each
// five-second window so queuing bursts do not dominate the drift estimate.
export class ClockMap {
  constructor() { this.points=[]; }
  add(t0,p1,p2,t3) {
    if (![t0,p1,p2,t3].every(Number.isFinite) || t3<t0 || p2<p1) return;
    const rtt=t3-t0-(p2-p1);
    if (rtt<0 || rtt>250) return;
    const point={tv:(t0+t3)/2,phone:(p1+p2)/2,rtt};
    const last=this.points.at(-1);
    if(last && Math.floor(last.tv/5000)===Math.floor(point.tv/5000)) {
      if(last.rtt<=rtt)return;
      this.points.pop();
    }
    this.points.push(point);
    if(this.points.length>120)this.points.shift();
  }
  fit(now) {
    const pts=this.points, last=pts.at(-1);
    if(!last || now-last.tv>15000)return null;
    const p=pts.reduce((v,x)=>v+x.phone,0)/pts.length;
    const t=pts.reduce((v,x)=>v+x.tv,0)/pts.length;
    let xx=0,xy=0;
    for(const x of pts){xx+=(x.phone-p)**2;xy+=(x.phone-p)*(x.tv-t);}
    const slope=xx>0 && last.tv-pts[0].tv>=15000 ? xy/xx : 1;
    if(Math.abs(slope-1)>0.002)return null;
    const residual=Math.max(...pts.map(x=>Math.abs(x.tv-t-(x.phone-p)*slope)));
    return {slope,p,t,uncertainty:last.rtt/2+residual, phoneTime:tv=>p+(tv-t)/slope,
      tvTime:phone=>t+(phone-p)*slope};
  }
}

export class AngleBuffer {
  constructor(duration=20000,byteLimit=32*1024*1024) {
    this.frames=[];this.duration=duration;this.byteLimit=byteLimit;this.bytes=0;
  }
  add(frame) {
    if(!Number.isFinite(frame.time) || frame.size>this.byteLimit || (this.frames.at(-1)?.time??-Infinity)>=frame.time)return;
    this.frames.push(frame);this.bytes+=frame.size;
    this.trim(frame.time);
  }
  trim(now) {
    while(this.frames.length && (now-this.frames[0].time>this.duration || this.bytes>this.byteLimit)) {
      this.bytes-=this.frames.shift().size;
    }
  }
  nearest(time,tolerance=50) {
    let lo=0,hi=this.frames.length;
    while(lo<hi) {
      const mid=Math.floor((lo+hi)/2);
      if(this.frames[mid].time<time)lo=mid+1;else hi=mid;
    }
    const a=this.frames[lo-1],b=this.frames[lo];
    const frame=(!b || (a && time-a.time<=b.time-time)) ? a : b;
    return frame && Math.abs(frame.time-time)<=tolerance ? frame : null;
  }
}

export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
