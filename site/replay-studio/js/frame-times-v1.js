// Presentation timestamps for video recorded in this app. Never retain frame pixels.
(() => {
  'use strict';
  const boxName = (data,p) => String.fromCharCode(...data.subarray(p,p+4));
  function vint(data,p,keepMarker=false) {
    const first = data[p];
    if (!first) return null;
    let width=1, mask=128;
    while (!(first & mask)) { width++; mask >>= 1; }
    if (p+width > data.length) return null;
    let value=keepMarker ? first : first & (mask-1);
    for (let i=1;i<width;i++) value = value*256 + data[p+i];
    return {value,width};
  }
  function unsigned(data,p,n) {
    let value=0;
    for (let i=0;i<n;i++) value=value*256+data[p+i];
    return value;
  }
  function lowerBound(times,value) {
    let a=0,b=times.length;
    while(a<b) { const mid=(a+b)>>>1; if(times[mid]<value) a=mid+1; else b=mid; }
    return a;
  }
  function boxes(data,start,end,visit) {
    for(let p=start;p+8<=end;) {
      const size=unsigned(data,p,4);
      if(size<8 || p+size>end) return;
      visit(boxName(data,p+4),p+8,p+size);
      p+=size;
    }
  }
  const ebmlMasters = new Set([0x18538067,0x1549a966,0x1654ae6b,0xae,0x1f43b675,0xa0]);
  class FrameTimes {
    constructor() {
      this.offset=0; this.times=[]; this.pending=new Uint8Array(); this.skip=0; this.format='';
      this.timeScale=1000000; this.cluster=0; this.track=null; this.id=null; this.type=null;
      this.mp4Scale=0; this.defaultDuration=0; this.disabled=false;
    }
    startSegment(offset) {
      const times=this.times;
      Object.assign(this,new FrameTimes());
      this.times=times;
      this.offset=offset;
    }
    insert(t) {
      t+=this.offset;
      if(!Number.isFinite(t) || this.times.length>=600000) return;
      const values=this.times;
      if(!values.length || t>values[values.length-1]) values.push(t);
      else {
        const i=lowerBound(values,t);
        if(values[i]!==t) values.splice(i,0,t);
      }
    }
    discardBefore(seconds) {
      const i=lowerBound(this.times,seconds);
      if(i>1) this.times.splice(0,i-1);
    }
    frameAt(time,direction,start,end) {
      const pts=this.times;
      if(pts.length<2 || time<pts[0]-0.002 || time>pts[pts.length-1]+0.15) return null;
      // Return a time just inside the frame, so millisecond-rounded seeks select it.
      const current=Math.max(0,lowerBound(pts,time+0.00005)-1);
      const i=Math.min(pts.length-1,Math.max(0,current+direction));
      const inset=Math.min(0.001,(pts[i+1]-pts[i] || 0.004)/4);
      return Math.max(start,Math.min(end,pts[i]+inset));
    }
    push(input) {
      if(this.disabled) return;
      let bytes=input instanceof Uint8Array ? input : new Uint8Array(input);
      if(this.skip) { const n=Math.min(this.skip,bytes.length); this.skip-=n; bytes=bytes.subarray(n); }
      if(!bytes.length) return;
      if(this.pending.length) {
        const joined=new Uint8Array(this.pending.length+bytes.length);
        joined.set(this.pending); joined.set(bytes,this.pending.length); bytes=joined;
      }
      let p=0;
      if(!this.format && bytes.length>=8) this.format=bytes[0]===0x1a ? 'webm' : 'mp4';
      while(this.format && p<bytes.length) {
        const used=this.format==='webm' ? this.ebml(bytes,p) : this.mp4(bytes,p);
        if(!used) break;
        if(used<0 || !Number.isFinite(used)) { this.disabled=true;break; }
        p+=used;
      }
      this.skip=Math.max(0,p-bytes.length);
      // Retain only incomplete headers or index boxes. Skip large media payloads directly.
      if(bytes.length-p>4*1024*1024) this.disabled=true;
      this.pending=this.disabled ? new Uint8Array() : bytes.slice(Math.min(bytes.length,p));
    }
    ebml(data,p) {
      const id=vint(data,p,true);
      if(!id) return 0;
      const size=vint(data,p+id.width);
      if(!size) return 0;
      const header=id.width+size.width, offset=p+header, n=size.value;
      if(ebmlMasters.has(id.value)) {
        if(id.value===0xae) { this.id=null;this.type=null; }
        if(id.value===0x1f43b675) this.cluster=0;
        return header;
      }
      if([0x2ad7b1,0xd7,0x83,0xe7].includes(id.value) && n>0 && n<=8) {
        if(offset+n>data.length) return 0;
        const v=unsigned(data,offset,n);
        if(id.value===0x2ad7b1) this.timeScale=v;
        if(id.value===0xd7) this.id=v;
        if(id.value===0x83) this.type=v;
        if(id.value===0xe7) this.cluster=v;
        if(this.id!==null && this.type===1) this.track=this.id;
      } else if(id.value===0xa3 || id.value===0xa1) {
        const track=vint(data,offset);
        if(!track || offset+track.width+3>data.length) return 0;
        if(n<track.width+3) return -1;
        const pos=offset+track.width;
        const value=(data[pos]<<8) | data[pos+1];
        const signed=value>=32768 ? value-65536 : value;
        if((this.track===null || this.track===track.value) && !(data[pos+2]&6)) {
          this.insert((this.cluster+signed)*this.timeScale/1e9);
        }
      }
      return header+n;
    }
    mp4(data,p) {
      if(p+8>data.length) return 0;
      let size=unsigned(data,p,4), head=8;
      const type=boxName(data,p+4);
      if(size===1) { if(p+16>data.length) return 0;size=unsigned(data,p+8,8);head=16; }
      if(size<head || !Number.isSafeInteger(size)) return -1;
      if(type!=='moov' && type!=='moof') return size;
      if(size>4*1024*1024) return -1;
      if(p+size>data.length) return 0;
      if(type==='moov') this.mp4Header(data,p+head,p+size);
      else boxes(data,p+head,p+size,(name,b,e)=>{if(name==='traf') this.mp4TrackFragment(data,b,e);});
      return size;
    }
    mp4Header(data,start,end) {
      const defaults=new Map();
      boxes(data,start,end,(type,b,e)=>{
        if(type==='mvex') boxes(data,b,e,(name,c,d)=>{
          if(name==='trex' && d-c>=24) defaults.set(unsigned(data,c+4,4),unsigned(data,c+12,4));
        });
        if(type!=='trak') return;
        let id=0,scale=0,video=false;
        boxes(data,b,e,(name,c,d)=>{
          if(name==='tkhd') id=unsigned(data,c+(data[c]===1?20:12),4);
          if(name==='mdia') boxes(data,c,d,(field,x,y)=>{
            if(field==='mdhd') scale=unsigned(data,x+(data[x]===1?20:12),4);
            if(field==='hdlr' && y-x>=12) video=boxName(data,x+8)==='vide';
          });
        });
        if(video && id && scale) { this.track=id;this.mp4Scale=scale; }
      });
      this.defaultDuration=defaults.get(this.track)||0;
    }
    mp4TrackFragment(data,start,end) {
      if(!this.mp4Scale) return;
      let track=0, duration=this.defaultDuration, time=0;
      boxes(data,start,end,(type,p,endPos)=>{
        const flags=unsigned(data,p+1,3);
        if(type==='tfhd') {
          track=unsigned(data,p+4,4);
          if(flags&8) duration=unsigned(data,p+8+(flags&1?8:0)+(flags&2?4:0),4);
        } else if(type==='tfdt') time=unsigned(data,p+4,data[p]===1?8:4);
        else if(type==='trun' && track===this.track) {
          const count=unsigned(data,p+4,4);
          if(count>100000) return;
          let off=p+8+(flags&1?4:0)+(flags&4?4:0);
          for(let n=0;n<count;n++) {
            let dt=duration,composition=0;
            if(flags&0x100) {dt=unsigned(data,off,4);off+=4;}
            if(flags&0x200) off+=4;
            if(flags&0x400) off+=4;
            if(flags&0x800) {
              composition=unsigned(data,off,4);off+=4;
              if(data[p]===1 && composition>=0x80000000) composition-=0x100000000;
            }
            if(off>endPos || !dt) break;
            this.insert((time+composition)/this.mp4Scale);
            time+=dt;
          }
        }
      });
    }
  }
  window.ReplayFrameTimes=FrameTimes;
})();
