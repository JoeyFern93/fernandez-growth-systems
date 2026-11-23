// Direct an already decoded local replay. Observation and presentation clocks are
// separate because a result can arrive after its source frame has been displayed.
(() => {
  'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const middle = () => ({ x: .5, y: .5 });
  const full = () => ({ x: 0, y: 0, size: 1 });
  const separation = (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * .70);
  const validPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

  // Limit speed and acceleration and leave enough distance to come to rest.
  function move(axis, target, speed, acceleration, dt) {
    const error = target - axis.value;
    const wanted = Math.sign(error) * Math.min(speed, Math.sqrt(2 * acceleration * Math.abs(error)));
    axis.velocity += clamp(wanted - axis.velocity, -acceleration * dt, acceleration * dt);
    const step = axis.velocity * dt;
    if (step * error >= 0 && Math.abs(step) >= Math.abs(error)) {
      axis.value = target;
      axis.velocity = 0;
    } else {
      axis.value += step;
    }
  }
  class VolleyballDirector {
    constructor() { this.reset(); }
    reset() {
      this.x = { value: .5, velocity: 0 };
      this.y = { value: .5, velocity: 0 };
      this.size = { value: 1, velocity: 0 };
      this.target = middle();
      this.targetSize = 1;
      this.lastObservation = -Infinity;
      this.lastFrame = null;
      this.lastHit = null;
      this.lastEvidenceTime = -Infinity;
      this.hadTrack = false;
      this.pending = null;
      this.absent = false;
      this.wideUntil = -Infinity;
      this.contextUntil = -Infinity;
      this.contextSize = 0;
    }
    restore(snapshot, time) {
      this.reset();
      if (!snapshot?.crop || !Number.isFinite(time)) return;
      const { x, y, size } = snapshot.crop;
      this.size.value = this.targetSize = clamp(size, .74, 1);
      this.x.value = x + this.size.value / 2;
      this.y.value = y + this.size.value / 2;
      this.target = { x: this.x.value, y: this.y.value };
      this.lastFrame = time;
      this.lastObservation = time;
      if (snapshot.state === 'tracking' || validPoint(snapshot.ball)) {
        this.lastEvidenceTime = time - clamp(snapshot.age || 0, 0, .25);
      }
      if (validPoint(snapshot.ball)) this.lastHit = { ...snapshot.ball, t: this.lastEvidenceTime, vx: 0, vy: 0 };
      this.hadTrack = snapshot.state !== 'searching' || Boolean(this.lastHit);
    }
    observe(observation, time, angle = 'baseline') {
      if (!Number.isFinite(time) || time <= this.lastObservation) return;
      this.lastObservation = time;
      const p = observation?.ball;
      this.absent = true;
      if (!validPoint(p)) return;
      const prev = this.lastHit, dt = prev ? time - prev.t : Infinity;
      // Same flight can resume after a brief missed detection. A spatially
      // unrelated observation always needs a fresh, consistent sequence.
      const travel = prev ? separation(p, prev) : Infinity;
      const plausible = dt <= .19 && travel <= .023 + 2.20 * dt &&
        separation(p, { x: prev.x + prev.vx * dt, y: prev.y + prev.vy * dt }) <= .035 + 1.18 * dt;
      if (!plausible) {
        const probe = this.pending;
        const gap = probe ? time - probe.t : Infinity;
        if (!probe || gap > .15 || separation(p, probe) > .022 + 1.85 * gap) {
          this.pending = { x: p.x, y: p.y, t: time, start: time, count: 1 };
          return;
        }
        probe.x = p.x; probe.y = p.y; probe.t = time; probe.count++;
        if (probe.count < 2 || time - probe.start < .058) return;
      }
      this.pending = null;
      this.absent = false;
      const vx = plausible ? .45 * prev.vx + .55 * (p.x - prev.x) / dt : 0;
      const vy = plausible ? .45 * prev.vy + .55 * (p.y - prev.y) / dt : 0;
      this.lastHit = { x: p.x, y: p.y, confidence: p.confidence, t: time, vx, vy };
      this.lastEvidenceTime = time;
      this.hadTrack = true;
      // Pad for players and keep both sides visible around contacts. Large
      // moving boxes may indicate a passer; they never instantly recenter a shot.
      const nearNet = p.y >= .24 && p.y <= .62;
      if (nearNet) this.wideUntil = time + .55;
      let left = p.x - .06, right = p.x + .06, top = p.y - .09, bottom = p.y + .09;
      for (const box of observation.players || []) {
        if (![box.left, box.right, box.top, box.bottom].every(Number.isFinite)) continue;
        left = Math.min(left, box.left - .025); right = Math.max(right, box.right + .025);
        top = Math.min(top, box.top - .025); bottom = Math.max(bottom, box.bottom + .025);
      }
      const span = clamp(Math.max(right - left, bottom - top) + .08, 0, 1);
      if (time >= this.contextUntil || span > this.contextSize) {
        this.contextSize = span;
        this.contextUntil = time + .42;
      }
      this.targetSize = Math.max(angle === 'sideline' ? .81 : .77, this.contextSize,
        time < this.wideUntil ? .84 : 0);
      // Keep the previous aim while the action is comfortably within frame.
      // Pan only far enough to carry the ball back toward the safe interior.
      const s = this.targetSize;
      const focusX = p.x * .7 + ((left + right) / 2) * .3;
      const focusY = p.y * .7 + ((top + bottom) / 2) * .3;
      this.target.x = clamp(clamp(this.target.x, focusX - s * .14, focusX + s * .14), s / 2, 1 - s / 2);
      this.target.y = clamp(clamp(this.target.y, focusY - s * .14, focusY + s * .14), s / 2, 1 - s / 2);
      if (observation.players?.length) {
        // Bias toward the full observed bodies if that fits in this crop.
        // The presentation controller still applies the same speed limits.
        this.target.x = clamp(this.target.x, clamp(right - s/2, s/2, 1 - s/2), clamp(left + s/2, s/2, 1 - s/2));
        this.target.y = clamp(this.target.y, clamp(bottom - s/2, s/2, 1 - s/2), clamp(top + s/2, s/2, 1 - s/2));
      }
    }
    frame(time) {
      if (!Number.isFinite(time)) return { crop: full(), ball: null, state: 'searching' };
      const age = Math.max(0, time - this.lastEvidenceTime);
      const lost = age > .25;
      // Give an ordinary one- or two-frame dropout no influence on framing.
      // After a sustained loss, open the shot and return its center to midcourt.
      const targetSize = lost ? 1 : this.targetSize;
      const cx = lost ? .5 : this.target.x, cy = lost ? .5 : this.target.y;
      let remaining = this.lastFrame === null ? 0 : clamp(time - this.lastFrame, 0, .10);
      while (remaining > .000001) {
        const dt = Math.min(remaining, 1 / 120);
        remaining -= dt;
        move(this.size, targetSize, targetSize > this.size.value ? .46 : .23, 1.8, dt);
        const edge = this.size.value / 2;
        move(this.x, clamp(cx, edge, 1 - edge), .22, 1.1, dt);
        move(this.y, clamp(cy, edge, 1 - edge), .25, 1.3, dt);
        this.x.value = clamp(this.x.value, edge, 1 - edge);
        this.y.value = clamp(this.y.value, edge, 1 - edge);
      }
      this.lastFrame = Math.max(this.lastFrame ?? time, time);
      const size = this.size.value;
      const crop = { x: this.x.value - size / 2, y: this.y.value - size / 2, size };
      // Preserve observed coordinates. A brief hold bridges display cadence,
      // but a missing result suppresses the marker quickly on a fast-moving ball.
      const markerAge = this.absent && this.lastHit
        ? clamp(.068 - Math.hypot(this.lastHit.vx, this.lastHit.vy * .7) * .027, .030, .068)
        : .13;
      const ball = age <= markerAge && this.lastHit
        ? { x: this.lastHit.x, y: this.lastHit.y, confidence: this.lastHit.confidence } : null;
      return { crop, ball, age: Math.min(age, 1), state: lost ? (this.hadTrack ? 'lost' : 'searching') : 'tracking' };
    }
  }
  if (typeof window !== 'undefined') window.VolleyballDirector = VolleyballDirector;
  if (typeof module !== 'undefined' && module.exports) module.exports = VolleyballDirector;
})();
