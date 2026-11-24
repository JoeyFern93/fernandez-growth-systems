(() => {
  'use strict';
  const path = '/api/replay-pair';
  const previewOrigin = 'https://qa-replay-audit-fixes-202611.fernandez-growth-systems.pages.dev';
  const {origin, hostname} = location;

  if (origin === previewOrigin) {
    window.FGSReplayPairEndpoint = 'https://qa-replay-audit-fixes-202611.fgs-site-review.pages.dev' + path;
  } else if (origin === 'https://www.fernandezgrowthsystems.com' || origin === 'https://fernandezgrowthsystems.com') {
    window.FGSReplayPairEndpoint = 'https://sitereview.fernandezgrowthsystems.com' + path;
  } else if (hostname === 'fernandez-growth-systems.pages.dev' || hostname.endsWith('.fernandez-growth-systems.pages.dev')) {
    // QR invites and the display must use the same, stable test-room service.
    // Preserve the full invite fragment when a phone opens a versioned build.
    const url = new URL(location.href);
    url.protocol = 'https:';
    url.host = new URL(previewOrigin).host;
    url.port = '';
    location.replace(url.href);
  } else if (document.querySelector('meta[name="replay-pair-api"]')?.content === path) {
    window.FGSReplayPairEndpoint = origin + path;
  }
})();
