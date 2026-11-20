export function canCaptureTab() {
  return window.isSecureContext &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    Boolean(navigator.mediaDevices.getSupportedConstraints?.().displaySurface);
}

function playableFrame(video, track) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => fail("The tab did not produce a screenshot in time. Try again or upload an image."), 8000);
    function finish() {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("playing", ready);
      track.removeEventListener("ended", ended);
    }
    function fail(message) {
      finish();
      reject(new Error(message));
    }
    function ended() {
      fail("Tab sharing ended before a screenshot was ready.");
    }
    function ready() {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      finish();
      resolve();
    }
    video.addEventListener("loadeddata", ready);
    video.addEventListener("playing", ready);
    track.addEventListener("ended", ended);
    video.play().then(ready, () => fail("This browser could not read the selected tab. Upload a screenshot instead."));
  });
}

// Must be called in the click handler so the browser can show its own source
// picker. The caller separately previews the returned file and confirms upload.
export async function captureTabImage() {
  if (!canCaptureTab()) throw new Error("Tab capture is unavailable in this browser. Upload a screenshot instead.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { displaySurface: "browser" },
      selfBrowserSurface: "exclude",
      monitorTypeSurfaces: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude"
    });
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      throw new Error("Tab capture was cancelled or permission was declined. No screenshot was added.");
    }
    throw new Error("The browser could not open the tab picker. Upload a screenshot instead.");
  }

  function stop() {
    for (const track of stream.getTracks()) track.stop();
  }
  let video;
  let canvas;
  try {
    const track = stream.getVideoTracks()[0];
    if (track?.getSettings().displaySurface !== "browser") {
      throw new Error("Choose a single browser tab from the picker, or upload a screenshot.");
    }
    window.addEventListener("pagehide", stop, { once: true });
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await playableFrame(video, track);
    const scale = Math.min(1, 2400 / Math.max(video.videoWidth, video.videoHeight));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the screenshot. Upload an image instead.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } finally {
    stop();
    window.removeEventListener("pagehide", stop);
    if (video) video.srcObject = null;
  }

  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("This browser could not create the image. Upload a screenshot instead.");
  return new File([blob], "tab-screenshot.png", { type: "image/png" });
}
