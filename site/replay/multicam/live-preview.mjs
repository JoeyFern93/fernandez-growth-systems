// This monitor only decides whether an unbuffered preview is live. None of
// its local observation times may be used as capture times in the replay.
export function createLivePreview(video) {
  let previousCallback, previousCounter, previousCapture = -Infinity;
  let lastProgress = -Infinity, lastTimedFrame = -Infinity, nextPoll = 0;
  let sample, previousPixels;

  function frame(info, captureTime) {
    const now = performance.now();
    const marker = info.rtpTimestamp ?? info.presentedFrames ?? info.mediaTime;
    if (Number.isFinite(marker)) {
      if (previousCallback !== undefined && marker !== previousCallback) lastProgress = now;
      previousCallback = marker;
    }
    if (Number.isFinite(captureTime) && captureTime > previousCapture) {
      previousCapture = captureTime;
      lastTimedFrame = now;
    }
  }

  function poll(now) {
    const quality = video.getVideoPlaybackQuality?.();
    const decoded = quality && Number.isFinite(quality.totalVideoFrames)
      ? quality.totalVideoFrames - (quality.droppedVideoFrames || 0)
      : video.webkitDecodedFrameCount;
    if (Number.isFinite(decoded)) {
      if (previousCounter !== undefined && decoded > previousCounter) lastProgress = now;
      previousCounter = decoded;
    }
    // While the native video is hidden under buffered replay, a browser can
    // report every frame as dropped even though the source pixels change.
    // Sampling also handles browsers with no decoder counter.
    if (now - lastProgress < 700) return;
    if (!sample) {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 9;
      sample = canvas.getContext('2d', {willReadFrequently: true});
    }
    if (!sample) return;
    try {
      sample.drawImage(video, 0, 0, 16, 9);
      const pixels = sample.getImageData(0, 0, 16, 9).data;
      if (previousPixels && pixels.some((value, i) => value !== previousPixels[i])) lastProgress = now;
      previousPixels = pixels;
    } catch { /* A frame may not be readable during a track switch. */ }
  }

  function state() {
    const now = performance.now();
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (video.paused || video.ended || track?.muted || track?.readyState === 'ended' ||
        video.readyState < 2 || !video.videoWidth) {
      return Number.isFinite(lastProgress) ? 'stalled' : null;
    }
    if (now - lastTimedFrame < 900) return null;
    if (now >= nextPoll) {
      nextPoll = now + 150;
      poll(now);
    }
    if (!Number.isFinite(lastProgress)) return null;
    return now - lastProgress <= 1400 ? 'live' : 'stalled';
  }

  return {frame, state};
}
