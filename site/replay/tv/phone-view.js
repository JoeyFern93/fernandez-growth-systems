(() => {
  'use strict';
  const view = document.getElementById('phone-view');
  const preview = document.getElementById('phone-preview');
  const expand = document.getElementById('phone-preview-expand');
  if (!view || !preview || !expand) return;

  let requested = false;
  let wasNative = false;

  function display(expanded) {
    view.classList.toggle('preview-expanded', expanded);
    expand.textContent = expanded ? 'Exit preview' : 'Expand';
    expand.setAttribute('aria-label', expanded ? 'Exit expanded camera preview' : 'Expand camera preview');
    expand.setAttribute('aria-expanded', String(expanded));
  }

  function close() {
    requested = false;
    display(false);
    if (document.fullscreenElement === view) document.exitFullscreen().catch(() => {});
  }

  function syncCamera() {
    expand.hidden = preview.hidden;
    view.closest('.phone-shell').classList.toggle('has-preview', !preview.hidden);
    if (preview.hidden) close();
  }

  expand.addEventListener('click', async () => {
    if (requested) { close(); return; }
    requested = true;
    display(true);
    if (document.fullscreenEnabled && view.requestFullscreen) {
      try {
        await view.requestFullscreen();
        if (!requested && document.fullscreenElement === view) await document.exitFullscreen();
      } catch { /* The expanded in-page view remains available. */ }
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const native = document.fullscreenElement === view;
    if (wasNative && !native) { requested = false; display(false); }
    wasNative = native;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && requested) { close(); expand.focus(); }
  });
  new MutationObserver(syncCamera).observe(preview, {attributes: true, attributeFilter: ['hidden']});
  syncCamera();
})();
