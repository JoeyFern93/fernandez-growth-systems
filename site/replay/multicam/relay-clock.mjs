// Align each browser's monotonic clock to the pairing service clock. Device
// wall clocks, time zones, and the delivery time of video packets are unused.
const sampleLifetime = 60000;
const maxTransit = 400;
const maxUncertainty = 180;
const driftPerMs = 0.0005;
const timePadding = 4;

export function createClockEstimate(now = () => performance.now()) {
  let samples = [];

  function prune(at) {
    samples = samples.filter(sample => at - sample.at <= sampleLifetime);
  }

  function bounds(sample, at) {
    const drift = Math.abs(at - sample.at) * driftPerMs;
    return [sample.low - drift, sample.high + drift];
  }

  function observe(clientStart, serverReceive, serverSend, clientEnd) {
    if (![clientStart, serverReceive, serverSend, clientEnd].every(Number.isFinite)) return false;
    const rtt = clientEnd - clientStart;
    const processing = serverSend - serverReceive;
    const transit = rtt - processing;
    if (rtt < 0 || rtt > 2200 || processing < 0 || transit < -2 || transit > maxTransit) return false;
    // With any asymmetry, the true server-minus-client offset lies between
    // these values: the response cannot arrive before send, or depart before receipt.
    const low = serverSend - clientEnd - timePadding;
    const high = serverReceive - clientStart + timePadding;
    prune(clientEnd);
    const overlaps = sample => {
      const [oldLow,oldHigh] = bounds(sample,clientEnd);
      return oldHigh >= low && oldLow <= high;
    };
    // If a device sleeps or the reference clock jumps, old offsets must not
    // carry across the discontinuity. At most eight tiny samples per session.
    samples = samples.filter(overlaps).slice(-7);
    samples.push({at:clientEnd,low,high});
    return true;
  }

  function estimate(at) {
    prune(now());
    if (!samples.length) return null;
    let low = -Infinity, high = Infinity;
    for (const sample of samples) {
      const interval = bounds(sample,at);
      low = Math.max(low,interval[0]);
      high = Math.min(high,interval[1]);
    }
    const uncertainty = (high-low)/2;
    return uncertainty >= 0 && uncertainty <= maxUncertainty
      ? {offset:(low+high)/2,uncertainty} : null;
  }

  function toServer(localTime) {
    if (!Number.isFinite(localTime)) return null;
    const fit = estimate(localTime);
    return fit && {time:localTime + fit.offset,uncertainty:fit.uncertainty};
  }

  function toLocal(serverTime) {
    if (!Number.isFinite(serverTime)) return null;
    const first = estimate(now());
    if (!first) return null;
    const fit = estimate(serverTime - first.offset);
    return fit && {time:serverTime - fit.offset,uncertainty:fit.uncertainty};
  }
  return {observe,toServer,toLocal};
}

export function startRelayClock({origin,id,token,signal}) {
  const clock = createClockEstimate();
  let finishReady;
  const ready = new Promise(resolve => { finishReady = resolve; });
  let timer, activeRequest, count = 0;
  function stop() {
    clearTimeout(timer);
    activeRequest?.abort();
    finishReady(false);
  }
  async function sample() {
    if (signal.aborted) return;
    const request = new AbortController();
    activeRequest = request;
    const timeout = setTimeout(() => request.abort(),2000);
    try {
      const before = performance.now();
      const response = await fetch(origin+'/'+encodeURIComponent(id)+'/relay',{
        headers:{Authorization:'Bearer '+token},method:'GET',cache:'no-store',
        credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:request.signal
      });
      if (response.ok) {
        const reading = await response.json();
        const after = performance.now();
        if (!signal.aborted) clock.observe(before,reading.serverReceivedAt,reading.serverSentAt,after);
      }
    } catch { /* Timing failure leaves the existing video connection alone. */ }
    finally {
      clearTimeout(timeout);
      activeRequest = null;
    }
    if (signal.aborted) return;
    count++;
    const valid = Boolean(clock.toServer(performance.now()));
    if (valid || count>=3) finishReady(valid);
    // Initial burst covers CORS preflight/connection warmup. After calibration,
    // one small authenticated status read every 20 s tracks clock drift.
    const interval = count < 3 ? 100 : valid ? 20000 : 5000;
    timer = setTimeout(sample,interval);
    timer.unref?.();
  }
  if (signal.aborted) stop();
  else {
    signal.addEventListener('abort',stop,{once:true});
    void sample();
  }
  return {ready,toLocal:clock.toLocal,toServer:clock.toServer};
}
