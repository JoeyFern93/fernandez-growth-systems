// This monitor only decides whether an unbuffered preview is live. None of
// its local observation times may be used as capture times in the replay.
export function playIncomingVideo(slot,room,onError) {
  const video=room.video,signal=room.controller.signal;
  let button,played=false,closed=false;
  function clear() {
    button?.remove();button=null;
    if(room.video===video)room.playBlocked=false;
  }
  function ready() {if(!closed){played=true;clear();}}
  function prompt() {
    if(closed || signal.aborted || room.video!==video || room.finishing || video.ended || button)return;
    room.playBlocked=true;
    button=document.createElement('button');button.type='button';button.className='receiver-play';
    button.textContent='Play camera';button.setAttribute('aria-label','Play '+slot.label+' on this display');
    button.onclick=attempt;slot.node.querySelector('.picture').append(button);
  }
  function paused() {if(played && video.paused)prompt();}
  function stop() {
    closed=true;clear();video.removeEventListener('playing',ready);video.removeEventListener('pause',paused);
    signal.removeEventListener('abort',stop);
  }
  function attempt() {
    if(closed || signal.aborted || room.video!==video)return;
    video.play().catch(error=>{
      if(closed || signal.aborted || room.video!==video || !video.isConnected)return;
      if(error.name==='NotAllowedError')prompt();
      else if(error.name!=='AbortError'){stop();onError(error);}
    });
  }
  video.addEventListener('playing',ready);video.addEventListener('pause',paused);
  signal.addEventListener('abort',stop,{once:true});attempt();
  return stop;
}
export function createLivePreview(video) {
  let previousCallback, previousCounter, firstCapture, previousCapture = -Infinity;
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
      firstCapture ??= captureTime;
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
    if (now >= nextPoll) {
      nextPoll = now + 150;
      poll(now);
    }
    if (!Number.isFinite(lastProgress)) return null;
    return now - lastProgress <= 1400 ? 'live' : 'stalled';
  }

  // Only capture stamps describe the replay timeline. Local progress is used
  // to distinguish a live camera from one that stopped delivering frames.
  function liveReason(time) {
    if (firstCapture === undefined) return 'Live only · replay timestamps unavailable';
    if (time < firstCapture) return 'Live · building delayed replay';
    if (time > previousCapture && performance.now() - lastTimedFrame >= 900) {
      return 'Live only · replay timestamps unavailable';
    }
    return null;
  }
  return {frame, state, liveReason, lastFrameAt: () => lastProgress};
}
