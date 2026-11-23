(() => {
  'use strict';
  const stage = document.getElementById('replayStage');
  const replayMenu = document.getElementById('replayModeMenu');
  document.addEventListener('click', event => {
    if (replayMenu.open && !replayMenu.contains(event.target)) replayMenu.open = false;
  });
  replayMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && replayMenu.open) {
      replayMenu.open = false;
      replayMenu.querySelector('summary').focus();
    }
  });
  const compact = matchMedia('(max-width:899px), (max-height:590px)');
  const tabs = [...stage.querySelectorAll('[role="tab"]')];
  const playback = document.getElementById('playbackTab');
  const camera = document.getElementById('cameraTab');
  const clips = document.getElementById('clipsTab');
  let selected;
  const replaySize = document.getElementById('replaySize');
  const toggleControls = document.getElementById('toggleReplayControls');
  const quickTransport = document.getElementById('quickReplayTransport');
  const start = document.getElementById('startBtn');
  const stop = document.getElementById('stopBtn');
  const pairTv = document.getElementById('pairTvBtn');
  const pause = document.getElementById('playPauseBtn');
  const seek = document.getElementById('reviewRange');
  const demo = document.getElementById('startDemoBtn');
  const pairHome = document.createComment('TV display in camera settings');
  pairTv.before(pairHome);
  quickTransport.append(start, stop, pause, seek);
  document.getElementById('quickDemoSlot').append(demo);
  document.getElementById('viewer').append(document.getElementById('exitFullscreenBtn'));
  const tvPage = new URLSearchParams(location.search).get('mode') === 'tv';
  let tvLayout = tvPage;
  let drawerOpen = false;
  let sizeBeforeFullscreen = null;
  function preferenceKey(prefix = 'fgs-replay-view-size-') {
    return prefix + (tvLayout ? 'tv' : 'camera');
  }
  function showControls() {
    const size = replaySize.value;
    const quick = size !== 'standard' && !drawerOpen;
    const active = !stop.disabled;
    stage.dataset.quickView = String(quick);
    stage.dataset.cameraActive = String(active);
    stage.dataset.hasReview = String(!seek.disabled);
    start.hidden = active;
    stop.hidden = !active;
    demo.hidden = active || !seek.disabled;
    pause.hidden = seek.hidden = seek.disabled;
    if (quick && !active) {
      if (pairTv.parentElement !== quickTransport) quickTransport.insertBefore(pairTv, pause);
    } else if (pairTv.previousSibling !== pairHome) {
      pairHome.after(pairTv);
    }
    toggleControls.hidden = size === 'standard';
    toggleControls.textContent = quick ? 'Controls' : 'Hide controls';
    toggleControls.setAttribute('aria-expanded', String(!quick));
  }
  function setSize(value) {
    stage.dataset.replaySize = replaySize.value = value;
    drawerOpen = false;
    showControls();
  }
  function loadSize() {
    let saved;
    try { saved = localStorage.getItem(preferenceKey()) ?? localStorage.getItem(preferenceKey('fgs-studio-replay-view-size-')); } catch {}
    setSize(['standard','large','maximum'].includes(saved) ? saved : 'large');
  }
  loadSize();
  replaySize.addEventListener('change', () => {
    setSize(replaySize.value);
    try { localStorage.setItem(preferenceKey(), replaySize.value); } catch {}
  });
  toggleControls.addEventListener('click', () => {
    drawerOpen = !drawerOpen;
    showControls();
  });
  const transportObserver = new MutationObserver(showControls);
  for (const button of [stop, seek]) transportObserver.observe(button, {attributes:true, attributeFilter:['disabled']});
  function syncFullscreen() {
    const expanded = document.fullscreenElement === stage || stage.classList.contains('expanded');
    if (expanded && sizeBeforeFullscreen === null) {
      sizeBeforeFullscreen = replaySize.value;
      setSize('maximum');
    } else if (!expanded && sizeBeforeFullscreen !== null) {
      setSize(sizeBeforeFullscreen);
      sizeBeforeFullscreen = null;
    }
  }
  document.addEventListener('fullscreenchange', syncFullscreen);
  new MutationObserver(syncFullscreen).observe(stage, {attributes:true, attributeFilter:['class']});
  window.addEventListener('fgs:remote-phase', event => {
    if (event.detail?.phase === 'receiving' && !tvLayout) {
      tvLayout = true;
      loadSize();
    }
  });
  window.addEventListener('fgs:remote-stopped', () => {
    if (!tvPage && tvLayout) {
      tvLayout = false;
      loadSize();
    }
  });

  function select(tab) {
    selected = tab;
    for (const item of tabs) {
      const panel = document.getElementById(item.getAttribute('aria-controls'));
      const permanent = item === playback && !compact.matches;
      item.hidden = permanent;
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
      panel.hidden = !permanent && item !== tab;
      panel.tabIndex = permanent ? -1 : 0;
      panel.setAttribute('role', permanent ? 'region' : 'tabpanel');
      panel.setAttribute('aria-labelledby', permanent ? 'reviewLabel' : item.id);
    }
  }
  function syncSize() {
    if (selected === clips) select(clips);
    else select(compact.matches ? playback : camera);
  }
  tabs.forEach(tab => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const visible = tabs.filter(item => !item.hidden);
      const index = visible.indexOf(tab);
      let next;
      switch (event.key) {
        case 'ArrowRight': next = visible[(index + 1) % visible.length]; break;
        case 'ArrowLeft': next = visible[(index - 1 + visible.length) % visible.length]; break;
        case 'Home': next = visible[0]; break;
        case 'End': next = visible[visible.length - 1]; break;
        default: return;
      }
      event.preventDefault();
      select(next);
      next.focus();
    });
  });
  if (compact.addEventListener) compact.addEventListener('change', syncSize);
  else compact.addListener(syncSize);
  syncSize();

  const trim = document.getElementById('trimPanel');
  const clipPreviewDialog = document.getElementById('clipPreviewDialog');
  const clipSize = document.getElementById('clipPreviewSizeBtn');
  const clipPreview = clipSize.closest('.trim-preview');
  function restoreClipPreview() {
    if (clipPreview.parentElement !== clipPreviewDialog) return;
    clipPreviewDialog.before(clipPreview);
    clipSize.textContent = 'Enlarge preview';
    clipSize.setAttribute('aria-haspopup', 'dialog');
    if (!trim.hidden) clipSize.focus({preventScroll:true});
  }
  function closeClipPreview() {
    if (typeof clipPreviewDialog.close === 'function') clipPreviewDialog.close();
    else clipPreviewDialog.removeAttribute('open');
    restoreClipPreview();
  }
  clipSize.addEventListener('click', () => {
    if (clipPreviewDialog.hasAttribute('open')) { closeClipPreview(); return; }
    clipPreviewDialog.append(clipPreview);
    clipSize.textContent = 'Return to editor';
    clipSize.removeAttribute('aria-haspopup');
    if (typeof clipPreviewDialog.showModal === 'function') clipPreviewDialog.showModal();
    else clipPreviewDialog.setAttribute('open', '');
    clipSize.focus({preventScroll:true});
  });
  clipPreviewDialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeClipPreview();
  });
  clipPreviewDialog.addEventListener('close', () => {
    if (!clipPreviewDialog.hasAttribute('open')) restoreClipPreview();
  });
  new MutationObserver(() => {
    if (trim.hidden && clipPreviewDialog.hasAttribute('open')) closeClipPreview();
  }).observe(trim, {attributes:true, attributeFilter:['hidden']});

  let wasHidden = trim.hidden;
  new MutationObserver(() => {
    if (trim.hidden === wasHidden) return;
    wasHidden = trim.hidden;
    if (!trim.hidden) {
      drawerOpen = true;
      showControls();
      select(clips);
      document.getElementById('clipsPanel').scrollTop = 0;
      document.getElementById('trimTitle').focus({preventScroll:true});
    } else if (!document.getElementById('downloadLink').hidden) {
      select(clips);
      document.getElementById('downloadLink').focus({preventScroll:true});
    } else {
      select(compact.matches ? playback : camera);
      const save = document.getElementById('recordClipBtn');
      if (!save.disabled) save.focus({preventScroll:true});
    }
  }).observe(trim, {attributes:true, attributeFilter:['hidden']});
  for (const id of ['reviewSessionBtn','returnRecentBtn']) {
    document.getElementById(id).addEventListener('click', () => {
      if (compact.matches) select(playback);
    });
  }
})();
