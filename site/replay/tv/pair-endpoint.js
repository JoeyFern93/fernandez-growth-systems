(() => {
  'use strict';
  const path = '/api/replay-pair';
  const canonical = 'https://www.fernandezgrowthsystems.com';
  const {origin} = location;

  if (origin === canonical || origin === 'https://fernandezgrowthsystems.com') {
    window.FGSReplayPairEndpoint = 'https://sitereview.fernandezgrowthsystems.com' + path;
  } else if (origin === 'https://fernandez-growth-systems.pages.dev') {
    // The project's stable Pages address and public site share one pairing service.
    const url = new URL(location.href);
    url.host = new URL(canonical).host;
    location.replace(url.href);
  } else if (document.querySelector('meta[name="replay-pair-api"]')?.content === path) {
    window.FGSReplayPairEndpoint = origin + path;
  }
})();
