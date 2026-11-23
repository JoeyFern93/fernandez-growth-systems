(() => {
  'use strict';
  const timeoutMs = 2000;

  // Playback owns the media clock. Only the most recent presented frame is
  // considered; a slow analysis never builds a queue behind the video.
  class TrackAnalysisRunner {
    constructor(onObservation, onError) {
      this.onObservation = onObservation;
      this.onError = onError;
      this.epoch = 0;
      this.id = 0;
      this.reset();
    }

    stopWorker() {
      this.worker?.terminate();
      this.worker = null;
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
      this.pending = null;
      this.bitmapTransfer = false;
    }

    reset(seed = null) {
      this.epoch++;
      this.stopWorker();
      this.tracker = null;
      this.scaler = this.pixels = null;
      this.seedValue = seed;
      this.mode = 'idle';
      this.previousTime = -Infinity;
      this.localInterval = 1 / 15;
    }

    seed(x, y, time) { this.reset({ x, y, time }); }

    close() { this.reset(); this.mode = 'closed'; }

    get busy() { return this.mode === 'starting' || this.pending !== null; }

    useLocal() {
      this.stopWorker();
      this.mode = 'local';
      this.tracker = new window.LocalBallTracker();
      if (this.seedValue) this.tracker.seed(this.seedValue.x, this.seedValue.y, this.seedValue.time);
    }

    startWorker() {
      const inline = document.getElementById('volley-analysis-worker');
      const epoch = this.epoch;
      try {
        if (typeof Worker !== 'function') { this.useLocal(); return; }
        if (inline) this.blobUrl = URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' }));
        const worker = new Worker(this.blobUrl || 'analysis-worker.js');
        this.worker = worker;
        this.mode = 'starting';
        this.startedAt = performance.now();
        worker.onerror = () => { if (this.worker === worker) this.useLocal(); };
        worker.onmessageerror = worker.onerror;
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker || this.epoch !== epoch) return;
          if (data.type === 'ready') {
            worker.postMessage({ type: 'reset', epoch, seed: this.seedValue });
            this.bitmapTransfer = data.bitmap && typeof OffscreenCanvas === 'function';
            this.mode = 'worker';
            if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
            this.blobUrl = null;
          } else if (data.id === this.pending && data.epoch === epoch) {
            this.pending = null;
            if (data.type === 'result') this.onObservation(data.observations, data.time);
            else if (data.type === 'error') this.recoverWorker();
          }
        };
      } catch { this.useLocal(); }
    }

    recoverWorker() {
      if (this.bitmapTransfer) {
        this.bitmapTransfer = false;
        this.scaler = null;
        this.pending = null;
      } else this.useLocal();
    }

    canvasContext(width, height, readable) {
      const canvas = !readable && this.bitmapTransfer ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: readable });
      if (!ctx) throw new Error('Frame sampling is unavailable');
      return ctx;
    }

    capture(video, width, height) {
      if (!this.scaler || this.scaler.canvas.width !== width || this.scaler.canvas.height !== height) {
        this.scaler = this.canvasContext(width, height, false);
      }
      // Scale on the GPU before crossing to CPU-readable memory, including on
      // browsers that cannot pass an ImageBitmap to the worker.
      this.scaler.drawImage(video, 0, 0, width, height);
      if (this.bitmapTransfer) return { bitmap: this.scaler.canvas.transferToImageBitmap() };
      if (!this.pixels || this.pixels.canvas.width !== width || this.pixels.canvas.height !== height) {
        this.pixels = this.canvasContext(width, height, true);
      }
      this.pixels.drawImage(this.scaler.canvas, 0, 0);
      return { buffer: this.pixels.getImageData(0, 0, width, height).data.buffer };
    }

    analyze(video, time, fps = 30) {
      if (this.mode === 'closed' || this.mode === 'failed' || !Number.isFinite(time) ||
          !video.videoWidth || !video.videoHeight || video.seeking || video.readyState < 2) return false;
      if (time < this.previousTime - .002) this.reset();
      if (this.mode === 'idle') this.startWorker();
      const clock = performance.now();
      if (this.busy && clock - this.startedAt > timeoutMs) this.useLocal();
      const interval = Math.max(1 / (fps || 30), this.mode === 'local' ? this.localInterval : 0);
      if (this.busy || time - this.previousTime < interval - .002) return false;
      const local = this.mode === 'local';
      const scale = Math.min(1, (local ? 640 : 896) / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      this.previousTime = time;
      let frame;
      try {
        frame = this.capture(video, width, height);
        if (local) {
          const pixels = { width, height, data: new Uint8ClampedArray(frame.buffer) };
          const result = this.tracker.update(pixels, time);
          // Reserve most of the UI thread for playback on older devices.
          const budget = Math.min(.25, Math.max(1 / 15, (performance.now() - clock) / 140));
          this.localInterval = Math.max(budget, this.localInterval * .9);
          this.onObservation(result, time);
        } else {
          const id = ++this.id;
          this.startedAt = clock;
          this.pending = id;
          this.worker.postMessage({ type: 'frame', epoch: this.epoch, id, time, width, height, ...frame }, [frame.bitmap || frame.buffer]);
        }
        return true;
      } catch (error) {
        frame?.bitmap?.close();
        if (!local) this.recoverWorker();
        else { this.mode = 'failed'; this.onError(error); }
        return false;
      }
    }
  }
  window.TrackAnalysisRunner = TrackAnalysisRunner;
})();
