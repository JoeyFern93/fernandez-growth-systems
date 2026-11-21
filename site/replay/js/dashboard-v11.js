(() => {
  'use strict';
  const stage = document.getElementById('replayStage');
  const compact = matchMedia('(max-width:899px), (max-height:590px)');
  const tabs = [...stage.querySelectorAll('[role="tab"]')];
  const playback = document.getElementById('playbackTab');
  const camera = document.getElementById('cameraTab');
  const clips = document.getElementById('clipsTab');
  let selected;

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
  let wasHidden = trim.hidden;
  new MutationObserver(() => {
    if (trim.hidden === wasHidden) return;
    wasHidden = trim.hidden;
    if (!trim.hidden) {
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
