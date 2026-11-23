// In the downloadable HTML the same tracker is already included in this worker.
if (!self.LocalBallTracker) importScripts('tracker.js');

(() => {
  'use strict';
  let tracker, epoch = 0, canvas, context;

  function reset(nextEpoch, seed) {
    epoch = nextEpoch;
    tracker = new self.LocalBallTracker();
    if (seed) tracker.seed(seed.x, seed.y, seed.time);
  }

  try {
    canvas = new OffscreenCanvas(1, 1);
    context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  } catch { /* The caller can transfer RGBA pixels instead. */ }

  self.onmessage = ({ data }) => {
    const { type, epoch: frameEpoch, width, height, time, id, bitmap } = data;
    if (type === 'reset') { reset(frameEpoch, data.seed); return; }
    if (type !== 'frame') return;
    const reply = { epoch: frameEpoch, id, time };
    try {
      if (!tracker || frameEpoch !== epoch) { self.postMessage({ ...reply, type: 'skip' }); return; }
      const start = performance.now();
      let pixels;
      if (bitmap) {
        if (!context) throw new Error('Bitmap reading unavailable');
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.drawImage(bitmap, 0, 0, width, height);
        pixels = context.getImageData(0, 0, width, height);
      } else {
        pixels = { width, height, data: new Uint8ClampedArray(data.buffer) };
      }
      const observations = tracker.update(pixels, time);
      self.postMessage({ ...reply, type: 'result', observations, costMs: performance.now() - start });
    } catch {
      self.postMessage({ ...reply, type: 'error' });
    } finally {
      bitmap?.close();
    }
  };
  self.postMessage({ type: 'ready', bitmap: Boolean(context) });
})();
