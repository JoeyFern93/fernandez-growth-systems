(() => {
  'use strict';
  const range = document.getElementById('delayRange');
  const presets = [...document.querySelectorAll('[data-delay]')];
  function syncPresets() {
    document.querySelector('.delay-control .range-labels span:last-child').textContent = range.max + ' sec';
    for (const button of presets) {
      button.disabled = Number(button.dataset.delay) > Number(range.max);
      button.setAttribute('aria-pressed', String(button.dataset.delay === range.value));
    }
  }
  for (const button of presets) {
    button.addEventListener('click', () => {
      range.value = button.dataset.delay;
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      syncPresets();
    });
  }
  range.addEventListener('input', syncPresets);
  new MutationObserver(syncPresets).observe(range, { attributes: true, attributeFilter: ['max'] });
  syncPresets();
})();
