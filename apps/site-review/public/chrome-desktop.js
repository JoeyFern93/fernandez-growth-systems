(() => {
  const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const chrome = /\bChrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent);

  for (const link of document.querySelectorAll('[data-desktop-chrome]')) {
    link.hidden = mobile || !chrome;
  }
  for (const section of document.querySelectorAll('[data-computer-only]')) section.hidden = mobile;
  for (const section of document.querySelectorAll('[data-phone-only]')) section.hidden = !mobile;
})();
