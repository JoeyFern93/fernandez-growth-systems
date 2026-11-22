(() => {
  'use strict';

  // Video-only WebM. Each encoded frame carries its source presentation time,
  // so asynchronous seeks and a slow screen do not alter the saved timeline.
  function bytes(value, length = 1) {
    while (value >= 256 ** length) length++;
    const result = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
      result[i] = value % 256;
      value = Math.floor(value / 256);
    }
    return result;
  }
  function element(id, ...parts) {
    const payload = new Blob(parts);
    let n = 1;
    while (payload.size >= 128 ** n - 1) n++;
    const size = bytes(payload.size, n);
    size[0] |= 1 << (8 - n);
    return new Blob([bytes(id), size, payload]);
  }
  function integer(id, value) {
    return element(id, bytes(value));
  }
  function webm(clusters, width, height, duration, codecId) {
    const header = element(0x1a45dfa3,
      integer(0x4286, 1), integer(0x42f7, 1), // EBML version and read version
      integer(0x42f2, 4), integer(0x42f3, 8), // Maximum ID and size lengths
      element(0x4282, 'webm'), integer(0x4287, 4), integer(0x4285, 2));
    // Segment timestamps use 100 microsecond ticks; encode duration as float64.
    const time = new DataView(new ArrayBuffer(8));
    time.setFloat64(0, duration * 10000);
    const info = element(0x1549a966, integer(0x2ad7b1, 100000), element(0x4489, time),
      element(0x4d80, 'Replay Studio'), element(0x5741, 'Replay Studio'));
    const video = element(0xe0, integer(0xb0, width), integer(0xba, height));
    const track = element(0x1654ae6b, element(0xae,
      integer(0xd7, 1), integer(0x73c5, 1), integer(0x83, 1), // Number, UID and video track type
      integer(0x9c, 0), element(0x86, codecId), video));
    const media = [];
    const cues = [];
    let offset = info.size + track.size;
    for (const cluster of clusters) {
      const content = element(0x1f43b675, integer(0xe7, cluster.start), ...cluster.blocks);
      media.push(content);
      if (cluster.key) {
        const trackPosition = element(0xb7, integer(0xf7, 1), integer(0xf1, offset));
        cues.push(element(0xbb, integer(0xb3, cluster.start), trackPosition));
      }
      offset += content.size;
    }
    const segment = element(0x18538067, info, track, ...media, element(0x1c53bb6b, ...cues));
    return new Blob([header, segment], { type: 'video/webm' });
  }
  async function create({ width, height, rate, bitrate, duration, maxBytes }) {
    if (!window.VideoEncoder || !window.VideoFrame) return null;
    let config = null;
    for (const codec of ['vp8', 'vp09.00.10.08']) {
      const proposed = { codec, width, height, bitrate, framerate: rate, latencyMode: 'quality' };
      try {
        if ((await VideoEncoder.isConfigSupported(proposed)).supported) {
          config = proposed;
          break;
        }
      } catch { /* The browser may support the other codec. */ }
    }
    if (!config) return null;
    let error;
    let written = 0, encoded = 0, submitted = 0, lastKey = -Infinity;
    const clusters = [];
    const encoder = new VideoEncoder({
      error(e) { error = e; },
      output(chunk) {
        if (error) return;
        written += chunk.byteLength;
        if (written > maxBytes) {
          error = new Error('Clip memory limit reached');
          return;
        }
        const stamp = Math.round(chunk.timestamp / 100);
        const key = chunk.type === 'key';
        let cluster = clusters.at(-1);
        if (!cluster || key || stamp - cluster.start > 30000) {
          cluster = { start: stamp, key, blocks: [] };
          clusters.push(cluster);
        }
        const pixels = new Uint8Array(chunk.byteLength);
        chunk.copyTo(pixels);
        const delta = stamp - cluster.start;
        // SimpleBlock header: track #1, signed 16-bit timestamp, keyframe flag.
        const blockHeader = new Uint8Array([0x81, delta >> 8, delta & 255, key ? 0x80 : 0]);
        cluster.blocks.push(element(0xa3, blockHeader, pixels));
        encoded++;
      }
    });
    try { encoder.configure(config); } catch { encoder.close(); return null; }
    return {
      async write(source, timestamp, span) {
        if (error) throw error;
        const micros = Math.round(timestamp * 1e6);
        const frame = new VideoFrame(source, { timestamp: micros, duration: Math.max(1, Math.round(span * 1e6)) });
        const key = timestamp - lastKey >= 2;
        try { encoder.encode(frame, { keyFrame: key }); } finally { frame.close(); }
        if (key) lastKey = timestamp;
        submitted++;
        if (encoder.encodeQueueSize >= 8) await encoder.flush();
      },
      async finish() {
        await encoder.flush();
        if (error) throw error;
        if (!encoded || encoded !== submitted) throw new Error('Encoded frames missing');
        return webm(clusters, width, height, duration, config.codec === 'vp8' ? 'V_VP8' : 'V_VP9');
      },
      close() {
        if (encoder.state !== 'closed') encoder.close();
        clusters.length = 0;
      }
    };
  }
  window.ReplayFrameExport = { create };
})();
