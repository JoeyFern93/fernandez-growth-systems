// Fixed-camera tracker. All public coordinates are fractions of the decoded image.
// Feed it one timestamped ImageData per distinct analysis frame. No DOM or network.
(() => {
  'use strict';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const empty = state => ({ ball: null, players: [], state });

  class LocalBallTracker {
    constructor() { this.reset(); }

    reset() {
      this.width = this.height = 0;
      this.time = null;
      this.trails = [];
      this.active = null;
      this.hint = null;
      this.everTracked = false;
      this.last = empty('searching');
    }

    seed(x, y, time) {
      if (![x, y, time].every(Number.isFinite)) return;
      this.trails = [];
      this.active = null;
      this.hint = { x: clamp(x, 0, 1), y: clamp(y, 0, 1), time };
      this.last = empty('searching');
    }

    allocate(width, height) {
      this.width = width; this.height = height;
      const n = width * height;
      this.background = new Float32Array(n);
      this.tint = new Float32Array(n);
      this.reference = new Uint8Array(n);
      this.referenceTint = new Int16Array(n);
      this.snapshot = new Uint8Array(n);
      this.snapshotTint = new Int16Array(n);
      this.snapshotTime = -Infinity;
      this.motion = new Uint8Array(n);
      this.warm = new Uint8Array(n);
      this.queue = new Int32Array(n);
      this.changed = new Uint8Array(n);
      this.previous = new Uint8Array(n);
      this.radialSizes = [...new Set([2.5,4.5,7.5,12.5,20].map(v => Math.max(2,Math.round(v*width/768))))].map(radius => {
        const inner = Math.max(1,Math.round(radius*.48));
        const outer = Math.max(inner+2,Math.round(radius*1.5)), d = Math.round(outer*.707);
        return {radius,outer,inner:[0,-inner,inner,-inner*width,inner*width],
          ring:[outer,-outer,outer*width,-outer*width,d*width+d,d*width-d,-d*width+d,-d*width-d]};
      });
    }

    update(image, time) {
      const { width, height, data } = image;
      if (width < 8 || height < 8 || !Number.isFinite(time)) return empty('searching');
      if (this.time !== null && time === this.time && width === this.width && height === this.height) return this.last;
      const discontinuity = this.time !== null && (time < this.time || time - this.time > .35);
      if (discontinuity || (this.width && (width !== this.width || height !== this.height))) this.reset();
      if (width !== this.width || height !== this.height) this.allocate(width, height);
      const first = this.time === null, dt = first ? 0 : time - this.time;
      this.time = time;
      const n = width * height;
      // Estimate ordinary noise/compression shimmer on this frame. The occupancy
      // check below also rejects camera cuts and large exposure changes.
      let ordinary = 0, samples = 0;
      for (let i = 19; i < n; i += 157) {
        const k = i * 4, l = (data[k] + 2 * data[k + 1] + data[k + 2]) >> 2;
        ordinary += Math.min(16, Math.abs(l - this.previous[i])); samples++;
      }
      const threshold = 10 + Math.min(14, ordinary / Math.max(samples, 1) * 2);
      const alpha = first ? 1 : 1 - Math.exp(-dt / .25);
      const takeSnapshot = time - this.snapshotTime >= .078;
      if (takeSnapshot) {
        [this.reference,this.snapshot] = [this.snapshot,this.reference];
        [this.referenceTint,this.snapshotTint] = [this.snapshotTint,this.referenceTint];
        this.snapshotTime = time;
      }
      let moving = 0;
      for (let i = 0, k = 0; i < n; i++, k += 4) {
        const r = data[k], g = data[k + 1], b = data[k + 2];
        const l = (r + g + g + b) >> 2, tint = (r + g) * .5 - b;
        const d = l - this.background[i], dc = tint - this.tint[i];
        const recent = Math.max(Math.abs(l-this.reference[i]), Math.abs(tint-this.referenceTint[i])*.85);
        const foreground = !first && recent > threshold*.82 && Math.max(Math.abs(d), Math.abs(dc) * .85) > threshold;
        this.changed[i] = Math.abs(l - this.previous[i]) > 5;
        this.motion[i] = foreground;
        // A second segmentation can resolve a panel at a contact. Uncolored
        // balls use the primary motion segmentation and identical trajectory tests.
        this.warm[i] = foreground && tint > 19 && g - b > 12 && r - g < (g - b) * 1.6 + 3;
        moving += foreground; this.previous[i] = l;
        if (takeSnapshot) { this.snapshot[i] = l; this.snapshotTint[i] = tint; }
        if (first) { this.reference[i] = l; this.referenceTint[i] = tint; }
        this.background[i] += alpha * d; this.tint[i] += alpha * dc;
      }
      if (first || moving > n * .23) {
        this.active = null; this.trails = [];
        return this.last = empty(this.everTracked ? 'lost' : 'searching');
      }
      const candidates = [], bodies = [];
      this.findDiscs(data, candidates);
      this.collect(this.motion, data, candidates, bodies, false);
      this.collect(this.warm, data, candidates, bodies, true);
      for (const c of candidates) {
        // Eroding sleeves, fingers and shoes generate many compact moving fragments.
        // Prefer isolated flight to guesses on the edge of a large moving body.
        c.nearBody = bodies.some(p =>
          c.x >= p.left - .012 && c.x <= p.right + .012 &&
          c.y >= p.top - .022 && c.y <= p.bottom + .022);
        if (c.nearBody) c.quality -= c.disc ? .11 : .23;
      }
      candidates.sort((a, b) => b.quality - a.quality);
      const distinct = [];
      for (const c of candidates) {
        if (c.quality < .43 || distinct.length >= 70) break;
        if (distinct.every(p => this.distance(c, p) > Math.max(c.size, p.size) * .55)) distinct.push(c);
      }
      const observation = this.associate(distinct, time, dt);
      if (!observation) return this.last = empty(this.everTracked ? 'lost' : 'searching');
      this.everTracked = true;
      // Motion regions provide framing context only. They are not person IDs.
      const nearby = bodies.map(box => {
        const x = clamp(observation.x, box.left, box.right), y = clamp(observation.y, box.top, box.bottom);
        return { box, d: this.distance(observation, { x, y }) };
      }).filter(p => p.d < .21).sort((a,b) => a.d - b.d).slice(0, 2).map(p => p.box);
      return this.last = {
        ball: { x: observation.x, y: observation.y, confidence: clamp(observation.quality, .51, .97) },
        players: nearby, state: 'tracking'
      };
    }

    distance(a, b) { return Math.hypot(a.x - b.x, (a.y - b.y) * this.height / this.width); }

    // A rolling ball can touch its own shadow or a player's motion component.
    // Search those moving pixels for a small disc contrasting with its surround.
    // Comparing opposite directions rules out most edges, including court lines.
    findDiscs(data, candidates) {
      const w = this.width, h = this.height, luma = this.previous;
      const step = Math.max(2,Math.round(w/290)), cell = Math.max(4, Math.round(w/120));
      const cols = Math.ceil(w/cell), cells = new Map();
      for (let y = step; y < h-step; y += step) {
        for (let x = step, p = y*w+x; x < w-step; x+=step,p+=step) {
          if (!this.motion[p]) continue;
          const key = Math.floor(y/cell)*cols+Math.floor(x/cell);
          let best = cells.get(key);
          for (const scale of this.radialSizes) {
            const {radius, outer, inner, ring} = scale;
            if (x < outer || x >= w-outer || y < outer || y >= h-outer) continue;
            let center = 0;
            for (let j=0;j<5;j++) center += luma[p+inner[j]];
            center *= .2;
            let pos=0, neg=0, surround=0, tint=0, surroundSq=0, ringTint=0;
            for (let j=0;j<8;j++) {
              const v=luma[p+ring[j]], diff=v-center;
              surround+=v; surroundSq+=v*v; pos+=diff>12; neg+=diff< -12;
              const q=(p+ring[j])*4;
              ringTint+= Math.min(data[q]-data[q+2],2*data[q+1]-data[q+2]-data[q]);
            }
            const support = Math.max(pos,neg);
            if (support<7) continue;
            const contrast=Math.abs(surround*.125-center);
            if (contrast<24) continue;
            let light=0, dark=255;
            for (let j=0;j<5;j++) {
              const q=(p+inner[j])*4, r=data[q], g=data[q+1], b=data[q+2];
              const yellow = Math.min(r-b,2*g-b-r);
              tint=Math.max(tint,yellow); const l=luma[p+inner[j]];
              dark=Math.min(dark,l); light=Math.max(light,l);
            }
            const panel = clamp((light-dark-9)/46,0,1);
            const yellow = clamp((tint-Math.max(4,ringTint/8)-5)/38,0,1);
            const spread=Math.sqrt(Math.max(0,surroundSq/8-(surround/8)**2));
            // This supplemental split is for a yellow/dark panel against a
            // touching player or shadow. Uniform and other-colored balls use
            // the independent foreground detector. Faces, shoes and moving
            // edges alone must never introduce extra disc hypotheses.
            if (yellow < .65 || panel < .39 || spread > 34) continue;
            const quality=.53+.16*clamp((contrast-12)/64,0,1)+.09*(support-6)*.5+
              .11*panel+.075*yellow;
            if (!best || quality > best.quality) {
              best={x:x/w,y:y/h,size:radius*2/w,quality,yellow,disc:true, contrast, panel,spread,tint,ringTint:ringTint/8};
              cells.set(key,best);
            }
          }
        }
      }
      for (const c of cells.values()) candidates.push(c);
    }

    collect(mask, data, candidates, bodies, panels) {
      const w = this.width, h = this.height, n = w * h, queue = this.queue;
      // Avoid branchy neighbor checks inside the flood fill; the outermost
      // image pixels cannot contain a fully visible ball.
      mask.fill(0, 0, w); mask.fill(0, n - w);
      for (let i = w; i < n - w; i += w) mask[i] = mask[i + w - 1] = 0;
      const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
      for (let i = w; i < n - w; i++) {
        if (!mask[i]) continue;
        let end = 1, changed = 0;
        let left = w, right = 0, top = h, bottom = 0, sx = 0, sy = 0;
        queue[0] = i; mask[i] = 0;
        for (let j = 0; j < end; j++) {
          const p = queue[j], y = Math.floor(p / w), x = p - y * w;
          if (x < left) left = x; if (x > right) right = x;
          if (y < top) top = y; if (y > bottom) bottom = y;
          sx += x; sy += y; changed += this.changed[p];
          for (let k = 0; k < 8; k++) {
            const q = p + offsets[k];
            if (mask[q]) { mask[q] = 0; queue[end++] = q; }
          }
        }
        const bw = right - left + 1, bh = bottom - top + 1, span = Math.max(bw, bh);
        if (!panels && end >= Math.max(32, w * .15) && bh > h * .07 && bh > bw * .76) {
          bodies.push({left: left/w, right: right/w, top: top/h, bottom: bottom/h});
        }
        if (end < 4 || !changed || changed < end * .035 || span > w * .061 ||
            bw < 2 || bh < 2 || bw / bh < .38 || bw / bh > 2.75) continue;
        const cx = sx / end, cy = sy / end;
        const fill = end / (bw * bh);
        if (fill < .24 || cx < span * .55 || cy < span * .55 || cx >= w - span * .55 || cy >= h - span * .55) continue;
        const inner = [0, 0, 0], outer = [0, 0, 0];
        // Sample inside the current silhouette and its immediate surround.
        // This suppresses background trails left behind an actual moving ball.
        const stride = Math.max(1, Math.floor(end / 120));
        let innerSamples = 0;
        for (let j = 0; j < end; j += stride) {
          const k = queue[j] * 4;
          inner[0] += data[k]; inner[1] += data[k+1]; inner[2] += data[k+2]; innerSamples++;
        }
        for (let k = 0; k < 3; k++) inner[k] /= innerSamples;
        const radius = Math.max(3, span * .90);
        const ring = [];
        for (let j = 0; j < 12; j++) {
          const angle = j * Math.PI / 6;
          const x = clamp(Math.round(cx + radius * Math.cos(angle)), 0, w-1);
          const y = clamp(Math.round(cy + radius * Math.sin(angle)), 0, h-1);
          const k = (y*w+x)*4;
          ring.push(k);
          for (let c = 0; c < 3; c++) outer[c] += data[k+c] / 12;
        }
        const contrast = Math.hypot(inner[0]-outer[0],inner[1]-outer[1],inner[2]-outer[2]) / Math.sqrt(3);
        if (contrast < 10) continue;
        let outsideSpread = 0;
        for (const k of ring) outsideSpread += Math.abs(data[k+1]-outer[1]) / 12;
        const aspect = Math.min(bw/bh, bh/bw);
        const yellow = clamp(((inner[0]+inner[1])/2-inner[2] - ((outer[0]+outer[1])/2-outer[2]) - 8)/38,0,1);
        const quality = .28 + .25 * clamp(contrast / 60, 0, 1) + .15 * aspect +
          .10 * clamp(fill / .70, 0, 1) + .12 * clamp(1-outsideSpread/35,0,1) +
          .06 * yellow + .05 * clamp(changed / end * 3,0,1);
        candidates.push({x: cx/w, y: cy/h, size: span/w, quality, yellow, contrast, outsideSpread});
      }
    }

    associate(candidates, time, dt) {
      const aspect = this.height / this.width;
      if (this.hint && time - this.hint.time > 1.0) this.hint = null;
      const maxGap = clamp(dt*1.75,.095,.32);
      const paths = this.trails.filter(p => time-p.time < (p===this.active ? Math.max(.13,maxGap) : maxGap));
      const matches = [];
      for (const trail of paths) {
        const age = time - trail.time;
        const predicted = {x: trail.x + trail.vx * age, y: trail.y + trail.vy * age};
        const gate = Math.max(.010, trail.size * .90) + age * (trail.hits > 2 ? .56 : 1.7);
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i], error = this.distance(c, predicted);
          if (error > gate || c.size < trail.size * .32 || c.size > trail.size * 2.8) continue;
          const cost = error / gate + Math.abs(Math.log(c.size/trail.size)) * .19 - .23*c.quality;
          matches.push({trail, i, cost});
        }
      }
      matches.sort((a,b) => a.cost-b.cost);
      const seen = new Set(), used = new Set();
      for (const {trail, i} of matches) {
        if (seen.has(trail) || used.has(i)) continue;
        const c = candidates[i], age = time - trail.time;
        const gain = trail.hits < 2 ? 1 : .55;
        trail.vx += gain * ((c.x - trail.x)/age - trail.vx);
        trail.vy += gain * ((c.y - trail.y)/age - trail.vy);
        trail.hits++; trail.time = time; trail.x = c.x; trail.y = c.y;
        trail.size = .55*trail.size+.45*c.size; trail.mean = trail.mean*.60+c.quality*.40;
        trail.observation = c;
        seen.add(trail); used.add(i);
      }
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue;
        const c = candidates[i];
        paths.push({x:c.x,y:c.y,startX:c.x,startY:c.y,born:time,time,hits:1,size:c.size,mean:c.quality,vx:0,vy:0,observation:c});
      }
      this.trails = paths;
      if (this.active && seen.has(this.active) &&
          this.active.observation.quality >= .58 && this.active.mean >= .62) return this.active.observation;
      if (this.active && time - this.active.time < Math.max(.115,maxGap)) return null;
      this.active = null;
      let best = null, bestScore = -1;
      for (const p of paths) {
        if (p.time !== time) continue;
        const displacement = Math.hypot(p.x - p.startX, (p.y - p.startY)*aspect);
        const hinted = this.hint && this.distance(this.hint, p) < .04 + Math.min(.06, Math.max(0,time-this.hint.time)*.22);
        if (this.hint && !hinted) continue;
        const speed = Math.hypot(p.vx,p.vy*aspect);
        const age = time - p.born;
        const strongDisc = p.observation.disc && p.observation.panel>.5 && p.observation.yellow>.45;
        if (hinted ? p.hits < 2 || p.mean < .54 :
          (p.hits < 3 || age < .054 || displacement < Math.max(.005,p.size*.41) ||
           p.mean < (strongDisc ? .70 : .745) || (p.observation.nearBody && !strongDisc) || speed < .018)) continue;
        const score = p.mean + Math.min(.08, displacement) + (hinted ? .3 : 0);
        if (score > bestScore) { best = p; bestScore = score; }
      }
      if (best) { this.active = best; this.hint = null; return best.observation; }
      return null;
    }
  }

  if (typeof window !== 'undefined') window.LocalBallTracker = LocalBallTracker;
  else if (typeof self !== 'undefined') self.LocalBallTracker = LocalBallTracker;
  if (typeof module !== 'undefined' && module.exports) module.exports = LocalBallTracker;
})();
