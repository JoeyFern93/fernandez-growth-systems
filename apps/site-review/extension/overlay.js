// Runs in Chrome's isolated world only after a reviewer enables this tab.
(() => {
  'use strict';

  const instance = Symbol.for('fgs.site-review.extension.overlay');
  if (globalThis[instance]) {
    globalThis[instance].show();
    return;
  }

  const host = document.createElement('div');
  const root = host.attachShadow({mode: 'closed'});
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all:initial!important; display:block!important; position:fixed!important; inset:0!important;
      width:auto!important; height:auto!important; pointer-events:none!important; z-index:2147483647!important;
      background:transparent!important; margin:0!important; padding:0!important; border:0!important;
      opacity:1!important; transform:none!important; visibility:visible!important; color-scheme:light!important; }
    *,*::before,*::after { box-sizing:border-box; }
    .shell { font:15px/1.4 system-ui,-apple-system,sans-serif; color:#173329; text-align:left; direction:ltr; }
    [hidden] { display:none!important; }
    button,textarea,input { font:inherit; }
    button { color:#173329; background:#fff; border:1px solid #c7d5cc; padding:8px 12px; border-radius:10px; cursor:pointer; min-height:40px; }
    button:hover { background:#edf5ef; }
    button:focus-visible,textarea:focus-visible,input:focus-visible { outline:3px solid #247e5c; outline-offset:2px; }
    button:disabled { opacity:.65; cursor:wait; }
    .primary { background:#174f39; border-color:#174f39; color:#fff; font-weight:650; }
    .primary:hover { background:#0c3a28; }
    .corner,.panel,.tools,.toast { position:fixed; pointer-events:auto; box-shadow:0 7px 28px #122d2733; }
    .corner,.panel { right:max(16px,env(safe-area-inset-right)); bottom:max(16px,env(safe-area-inset-bottom)); }
    .corner { display:flex; align-items:center; gap:8px; border-radius:100px; padding:12px 18px; }
    .shield { position:fixed; inset:0; pointer-events:auto; cursor:crosshair; outline:0; touch-action:pan-x pan-y; }
    .outline { position:fixed; pointer-events:none; border:3px solid #116646; border-radius:4px; box-shadow:0 0 0 2px #fff; background:#61b48c24; }
    .tools,.panel,.toast { background:#fff; border:1px solid #c7d5cc; border-radius:14px; }
    .tools { top:max(10px,env(safe-area-inset-top)); left:50%; transform:translateX(-50%); max-width:calc(100% - 16px); width:max-content;
      display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:6px 10px; padding:7px 9px 7px 13px; }
    .tools strong { font-size:14px; }
    .panel { width:min(358px,calc(100vw - 24px)); max-height:calc(100dvh - 30px); overflow:auto; overscroll-behavior:contain; padding:17px; }
    header,.actions { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    h2 { font-size:18px; margin:0; }
    .close { border:0; font-size:22px; width:40px; padding:0; }
    .target { color:#365747; margin:4px 0 13px; overflow-wrap:anywhere; }
    label { display:block; font-weight:600; }
    textarea { width:100%; min-height:89px; resize:vertical; border:1px solid #829a8b; padding:10px; border-radius:8px; margin:4px 0; background:#fff; color:#173329; }
    .actions { margin-top:9px; flex-wrap:wrap; justify-content:flex-end; }
    .error { color:#9d2920; margin:0; }
    .error:not(:empty) { margin:6px 0; }
    .toast { bottom:74px; right:16px; max-width:calc(100vw - 32px); padding:9px 14px; font-weight:550; }
    .toast:empty { display:none; }
    .toast {display:flex; align-items:center; gap:10px;}
    .mode-grid {display:grid; grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px;}
    .mode-grid button {text-align:left; font-weight:650;}
    .mode-grid small {display:block; margin-top:3px; font-size:12px; font-weight:400;}
    .ink {position:fixed; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible;}
    .pin {position:fixed; width:18px; height:18px; box-sizing:border-box; border:3px solid #fff; background:#146747;
      border-radius:50%; box-shadow:0 0 0 2px #163426; transform:translate(-50%,-50%); pointer-events:none;}
    .shield[data-spatial="true"] {touch-action:none;}
    .sr { position:absolute; clip-path:inset(50%); width:1px; height:1px; overflow:hidden; }
    @media (max-width:480px) { .tools { width:calc(100% - 16px); } }
    @media (forced-colors:active) { .outline { border-color:Highlight; } }
  `);
  root.adoptedStyleSheets = [sheet];

  // DOM methods work on sites that require Trusted Types for HTML. Target
  // descriptions enter the UI as text.
  function make(tag, attributes = {}, text) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, classes = '') { return make('button', {type:'button', class:classes}, text); }
  const shell = make('div', {class:'shell'});
  const launcher = button('Leave feedback', 'corner primary');
  launcher.setAttribute('aria-label', 'Leave feedback');
  const shield = make('div', {id:'fgs-target-surface', class:'shield', tabindex:'-1', role:'group',
    'aria-label':'Choose a page element. Use arrow keys to move, Enter to select, Tab for more options, or Escape to cancel.'});
  const outline = make('div', {class:'outline', 'aria-hidden':'true'});
  const tools = make('div', {class:'tools', role:'group', 'aria-label':'Feedback target'});
  const prompt = make('strong');
  const undo = button('Undo');
  undo.id = 'fgs-draw-undo';
  const doneDrawing = button('Add note', 'primary');
  doneDrawing.id = 'fgs-draw-finish';
  const changeMode = button('Change mode');
  const cancel = button('Cancel');
  tools.append(prompt, undo, doneDrawing, changeMode, cancel);
  const svgNS = 'http://www.w3.org/2000/svg';
  const ink = document.createElementNS(svgNS,'svg');
  ink.setAttribute('class','ink');
  ink.setAttribute('viewBox','0 0 1000 1000');
  ink.setAttribute('preserveAspectRatio','none');
  ink.setAttribute('aria-hidden','true');
  const pin = make('div',{class:'pin','aria-hidden':'true'});
  const modes = make('section',{class:'panel',role:'dialog','aria-labelledby':'fgs-mode-title'});
  const modeHeader = make('header');
  const modeClose = button('×','close');
  modeClose.setAttribute('aria-label','Close feedback choices');
  modeHeader.append(make('h2',{id:'fgs-mode-title'},'What would you like to mark?'), modeClose);
  const grid = make('div',{class:'mode-grid'});
  const choices = {};
  for (const [mode, label, hint] of [
    ['page','Page','Comment on the whole page'], ['point','Point','Pin an exact spot'],
    ['element','Element','Select text, an image or a button'], ['draw','Draw','Circle or sketch a change']
  ]) {
    const choice = button(label);
    choice.id = 'fgs-mode-' + mode;
    choice.append(make('small',{},hint));
    grid.append(choice);
    choices[mode] = choice;
  }
  modes.append(modeHeader,grid);
  const panel = make('section', {class:'panel', role:'dialog', 'aria-labelledby':'fgs-note-title'});
  const header = make('header');
  const close = button('×','close');
  close.setAttribute('aria-label','Close feedback');
  header.append(make('h2', {id:'fgs-note-title'}, 'Leave feedback'), close);
  const summary = make('p', {class:'target'});
  const form = make('form');
  const note = make('textarea', {id:'fgs-note', rows:'3', required:'', maxlength:'2000', placeholder:'What would you like changed?'});
  const alert = make('p', {class:'error', role:'alert'});
  const actions = make('div', {class:'actions'});
  const change = button('Change target');
  const send = make('button', {type:'submit', class:'primary'}, 'Send feedback');
  actions.append(change, send);
  form.append(make('label', {for:'fgs-note'}, 'Feedback'), note, alert, actions);
  panel.append(header, summary, form);
  const announcement = make('span',{class:'sr',role:'status'});
  const toast = make('div',{class:'toast',role:'status'});
  const viewNotes = button('View notes');
  viewNotes.id = 'fgs-view-notes';
  viewNotes.setAttribute('aria-label','View notes');
  shell.append(shield, ink, pin, outline, tools, launcher, modes, panel, toast, announcement);
  root.append(shell);
  const selectable = 'h1,h2,h3,h4,h5,h6,p,a,button,summary,label,input,select,textarea,img,video,figure,li,table,blockquote,iframe,[role="button"],[role="link"]';
  const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
  let state = 'idle', target, active, submitId, pending = false;
  let notePath, paintRequest, toastTimer, captureTimer;
  let mode, geometry, strokes = [], stroke, pointerId = null, anchorLabel, focusPoint;
  let totalPoints = 0;
  const round = value => Math.round(Math.min(1,Math.max(0,value))*10000)/10000;
  const listeners = new AbortController();
  const atPath = () => location.origin + location.pathname;

  function show() {
    if (!host.isConnected) document.documentElement.append(host);
  }
  function display(next) {
    state = next;
    launcher.hidden = next !== 'idle';
    panel.hidden = next !== 'compose';
    modes.hidden = next !== 'modes';
    shield.hidden = tools.hidden = next !== 'pick';
    ink.style.display = 'none';
    pin.hidden = true;
    outline.hidden = true;
    toast.textContent = '';
    announcement.textContent = '';
  }
  function notify(text, includeNotes = false) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    if (includeNotes) toast.append(viewNotes);
    else toastTimer = setTimeout(() => { toast.textContent = ''; }, 4500);
  }
  function safeLabel(element) {
    let label = element.getAttribute('aria-label') || element.getAttribute('alt');
    const fieldLabel = element.labels?.[0];
    if (!label && fieldLabel && !fieldLabel.querySelector(editable)) label = fieldLabel.innerText;
    if (!label && element.matches(selectable) &&
        !element.closest(editable) && !element.querySelector(editable)) {
      label = element.innerText;
    }
    return (label || element.localName).slice(0,300).replace(/\s+/g,' ').trim().slice(0,100) || element.localName;
  }
  function selector(element) {
    const parts = [];
    for (let node = element; node?.parentElement && parts.length < 9; node = node.parentElement) {
      let index = 1;
      for (let sibling=node.previousElementSibling; sibling; sibling=sibling.previousElementSibling) index++;
      parts.unshift(CSS.escape(node.localName) + ':nth-child(' + index + ')');
    }
    return parts.join(' > ').slice(0,420);
  }
  function context(element) {
    const viewport = {width:innerWidth,height:innerHeight};
    const result = {mode:element ? 'live' : 'page', viewport, scrollX, scrollY};
    if (element) {
      const label = safeLabel(element);
      const path = selector(element);
      Object.assign(result, {element:{tag:element.localName, label, selector:path}, elementLabel:label, selector:path, liveViewport:viewport});
    }
    return result;
  }
  function atPoint(event) {
    const raw = document.elementsFromPoint(event.clientX,event.clientY)
      .find(node => node !== host && node !== document.documentElement && node !== document.body);
    return raw?.closest(selectable) || raw;
  }
  function snapshot() {
    return {width:Math.min(32768,innerWidth),height:Math.min(32768,innerHeight),x:scrollX,y:scrollY};
  }
  function matchViewport(view) {
    return view && view.width === Math.min(32768,innerWidth) && view.height === Math.min(32768,innerHeight) &&
      view.x === scrollX && view.y === scrollY;
  }
  function position(event) {
    return [round(event.clientX/innerWidth),round(event.clientY/innerHeight)];
  }
  function drawPin(point) {
    pin.hidden = !point;
    if (point) Object.assign(pin.style,{left:(point[0]*100)+'%',top:(point[1]*100)+'%'});
  }
  function renderStrokes(lines) {
    ink.replaceChildren();
    for (const line of lines) {
      const points = line.map(([x,y]) => x*1000+','+y*1000);
      if (line.length === 1) points.push((line[0][0]*1000+.01)+','+(line[0][1]*1000+.01));
      for (const [color,width] of [['white',6],['#146747',3]]) {
        const path = document.createElementNS(svgNS,'polyline');
        for (const [name,value] of Object.entries({points:points.join(' '),stroke:color,fill:'none',
          'stroke-width':width,'stroke-linecap':'round','stroke-linejoin':'round','vector-effect':'non-scaling-stroke'})) {
          path.setAttribute(name,value);
        }
        ink.append(path);
      }
    }
    ink.style.display = lines.length ? 'block' : 'none';
  }
  function updateDrawing() {
    renderStrokes(strokes);
    undo.disabled = doneDrawing.disabled = !strokes.length;
  }
  function beginStroke(point, element) {
    if (strokes.length >= 24 || totalPoints >= 640) {
      announceLimit();
      return false;
    }
    if (!strokes.length) { geometry = snapshot(); anchorLabel = element ? safeLabel(element) : ''; }
    stroke = [point];
    strokes.push(stroke);
    totalPoints++;
    updateDrawing();
    return true;
  }
  function announceLimit() {
    prompt.textContent = 'Drawing limit reached. Choose Add note or Undo.';
    announcement.textContent = prompt.textContent;
  }
  function extendStroke(point) {
    const last = stroke?.at(-1);
    if (!last || (last[0] === point[0] && last[1] === point[1])) return;
    if (totalPoints >= 640 || stroke.length >= 256) {
      announceLimit();
      return;
    }
    // Keep enough detail to follow a curve without recording every subpixel.
    if (Math.hypot((point[0]-last[0])*innerWidth,(point[1]-last[1])*innerHeight) < 2) return;
    stroke.push(point);
    totalPoints++;
    schedulePaint();
  }
  function endStroke() {
    if (pointerId !== null && shield.hasPointerCapture(pointerId)) shield.releasePointerCapture(pointerId);
    pointerId = null;
    stroke = null;
  }
  function finishVisual(point) {
    if (!matchViewport(geometry)) { chooseMode(mode); return; }
    endStroke();
    const picked = context(null);
    picked.mode = mode;
    picked.annotation = {kind:mode,width:geometry.width,height:geometry.height};
    if (mode === 'point') picked.annotation.point = point.slice();
    else picked.annotation.strokes = strokes.map(line => line.map(p => p.slice()));
    if (anchorLabel) picked.elementLabel = anchorLabel;
    compose(picked);
  }
  function paint() {
    paintRequest = undefined;
    if (state === 'compose' && target?.annotation) {
      const same = matchViewport({width:target.annotation.width,height:target.annotation.height,x:target.scrollX,y:target.scrollY});
      drawPin(same && target.annotation.kind==='point' ? target.annotation.point : null);
      renderStrokes(same && target.annotation.kind==='draw' ? target.annotation.strokes : []);
      return;
    }
    if (state === 'pick' && mode !== 'element') {
      if (!matchViewport(geometry)) {
        chooseMode(mode);
        announcement.textContent = 'The view changed. Place your mark on the current view.';
      }
      if (mode === 'draw') renderStrokes(strokes);
      return;
    }
    outline.hidden = state !== 'pick' || !active?.isConnected;
    if (outline.hidden) return;
    const box = active.getBoundingClientRect();
    Object.assign(outline.style, {left:box.left+'px', top:box.top+'px', width:box.width+'px', height:box.height+'px'});
  }
  function schedulePaint() {
    if ((state === 'pick' || (state === 'compose' && target?.annotation)) && !paintRequest) paintRequest = requestAnimationFrame(paint);
  }
  function pick() {
    if (pending) return;
    endStroke();
    active = null;
    display('modes');
    choices.page.focus({preventScroll:true});
  }
  function chooseMode(value) {
    endStroke();
    mode = value;
    if (mode === 'page') { compose(context(null)); return; }
    strokes = []; totalPoints = 0; geometry = snapshot(); anchorLabel = '';
    focusPoint = [.5,.5]; active = null;
    display('pick');
    shield.dataset.spatial = mode==='element' ? 'false' : 'true';
    undo.hidden = doneDrawing.hidden = mode!=='draw';
    const hint = mode==='element' ? 'Select an item on the page.' :
      mode==='point' ? 'Click or tap the spot you mean.' : 'Draw on the page, then choose Add note.';
    prompt.textContent = hint;
    const keys = mode==='element' ? 'Use arrow keys to choose an item and Enter to select.' :
      mode==='point' ? 'Use arrow keys to move the pin and Enter to place it.' :
        'Use arrow keys to move. Press Space to start or end a line, then Enter to add a note.';
    shield.setAttribute('aria-label',hint+' '+keys);
    if (mode==='draw') updateDrawing();
    shield.focus({preventScroll:true});
  }
  function compose(selection, resume = false) {
    if (!resume) {
      target = selection;
      notePath = atPath();
      submitId = crypto.randomUUID();
    }
    display('compose');
    const label = target.annotation?.kind==='draw' ? 'Drawing' : target.annotation?.kind==='point' ? 'Pinned spot' :
      target.element ? 'Selected item' : 'Whole page';
    summary.textContent = label+' · '+(target.elementLabel || location.pathname);
    if (target.annotation) paint();
    alert.textContent = '';
    note.focus({preventScroll:true});
  }
  function minimize() {
    if (pending) return;
    endStroke();
    display('idle');
    launcher.textContent = note.value.trim() ? 'Continue feedback' : 'Leave feedback';
    launcher.setAttribute('aria-label',launcher.textContent);
    launcher.focus({preventScroll:true});
  }
  function move(direction) {
    const items = Array.from(document.querySelectorAll(selectable)).filter(node => !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
      node.getClientRects().length && getComputedStyle(node).visibility === 'visible');
    if (!items.length) return;
    const index = items.indexOf(active);
    active = items[index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index+direction+items.length)%items.length];
    active.scrollIntoView({block:'nearest',inline:'nearest'});
    announcement.textContent = safeLabel(active);
    paint();
  }
  function beginFeedback() {
    if (pending) return;
    if (state==='compose') { note.focus({preventScroll:true}); return; }
    if (note.value.trim() && target && notePath === atPath()) compose(null,true);
    else pick();
  }
  launcher.addEventListener('click', event => { if (event.isTrusted) beginFeedback(); });
  for (const [key, choice] of Object.entries(choices)) {
    choice.addEventListener('click', event => { if (event.isTrusted) chooseMode(key); });
  }
  modeClose.addEventListener('click', minimize);
  changeMode.addEventListener('click', pick);
  undo.addEventListener('click', () => {
    endStroke();
    totalPoints -= strokes.pop()?.length || 0;
    prompt.textContent = 'Draw on the page, then choose Add note.';
    updateDrawing();
  });
  doneDrawing.addEventListener('click', () => { if (strokes.length) finishVisual(); });
  cancel.addEventListener('click', minimize);
  close.addEventListener('click', minimize);
  change.addEventListener('click', pick);
  shield.addEventListener('pointermove', event => {
    if (mode==='draw' && pointerId===event.pointerId) { extendStroke(position(event)); return; }
    if (mode!=='element') return;
    if (event.pointerType === 'touch') return;
    active = atPoint(event);
    schedulePaint();
  });
  shield.addEventListener('pointerdown', event => {
    if (!event.isTrusted || mode!=='draw' || !event.isPrimary || event.button!==0) return;
    event.preventDefault();
    if (!beginStroke(position(event),atPoint(event))) return;
    pointerId = event.pointerId;
    shield.setPointerCapture(pointerId);
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    shield.addEventListener(type,event => {
      if (pointerId!==event.pointerId) return;
      if (type==='pointerup') extendStroke(position(event));
      endStroke();
    });
  }
  shield.addEventListener('wheel',event => { if(mode!=='element') event.preventDefault(); },{passive:false});
  shield.addEventListener('click', event => {
    if (!event.isTrusted || mode==='draw') return;
    event.preventDefault();
    event.stopPropagation();
    const element = atPoint(event);
    if (mode==='point') {
      anchorLabel = element ? safeLabel(element) : '';
      finishVisual(position(event));
    } else if (element) compose(context(element));
  });
  root.addEventListener('keydown', event => {
    // Page-level shortcuts must not consume keystrokes from the review controls.
    event.stopPropagation();
    if (event.key === 'Escape' && state !== 'idle') {
      event.preventDefault();
      event.stopPropagation();
      minimize();
      return;
    }
    if ((state === 'modes' || state==='pick' || state==='compose') && event.key === 'Tab') {
      event.preventDefault();
      const controls = (state==='modes' ? [modeClose,...Object.values(choices)] :
        state==='pick' ? [shield,undo,doneDrawing,changeMode,cancel] : [close,note,change,send])
        .filter(el=>!el.hidden && !el.disabled);
      controls[(controls.indexOf(root.activeElement)+(event.shiftKey ? controls.length-1 : 1))%controls.length]?.focus({preventScroll:true});
    }
    if (state !== 'pick' || root.activeElement !== shield) return;
    if (mode!=='element') {
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key.startsWith('Arrow')) {
        const step = event.shiftKey ? 1 : 10;
        const dx = (Number(event.key==='ArrowRight')-Number(event.key==='ArrowLeft'))*step/innerWidth;
        const dy = (Number(event.key==='ArrowDown')-Number(event.key==='ArrowUp'))*step/innerHeight;
        focusPoint = [round(focusPoint[0]+dx),round(focusPoint[1]+dy)];
        drawPin(focusPoint);
        if (mode==='draw' && stroke) extendStroke(focusPoint);
        announcement.textContent = 'Position '+Math.round(focusPoint[0]*100)+' percent across, '+Math.round(focusPoint[1]*100)+' percent down.';
      } else {
        const item = atPoint({clientX:focusPoint[0]*innerWidth,clientY:focusPoint[1]*innerHeight});
        if (mode==='point') {
          anchorLabel = item ? safeLabel(item) : '';
          finishVisual(focusPoint);
        } else if (event.key==='Enter' && strokes.length) finishVisual();
        else if (stroke) endStroke();
        else if (beginStroke(focusPoint.slice(),item)) drawPin(focusPoint);
      }
      return;
    }
    if (['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      move(['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!active) move(1);
      if (active) compose(context(active));
    }
  });
  for (const type of ['keypress','keyup','input','change','click']) {
    root.addEventListener(type, event => event.stopPropagation());
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!event.isTrusted || pending || !target) return;
    const text = note.value.trim();
    if (!text) { alert.textContent = 'Write a note first.'; note.focus(); return; }
    if (notePath !== atPath()) {
      alert.textContent = 'This page changed. Choose Change target to attach your note to the current page.';
      return;
    }
    pending = true;
    send.disabled = change.disabled = close.disabled = true;
    note.readOnly = true;
    send.textContent = 'Sending…';
    alert.textContent = '';
    try {
      const answer = await chrome.runtime.sendMessage({type:'save-note', text, clientId:submitId, context:target});
      if (!answer?.ok) throw new Error(answer?.error || 'The note could not be saved. Try again.');
      note.value = '';
      target = null;
      pending = false;
      minimize();
      notify('Feedback saved.',true);
    } catch (error) {
      alert.textContent = error.message?.includes('Extension context invalidated')
        ? 'Chrome updated the extension. Copy your note, reload this page and start the review again.'
        : error.message || 'Could not send. Your note is still here.';
    } finally {
      pending = false;
      send.disabled = change.disabled = close.disabled = false;
      note.readOnly = false;
      send.textContent = 'Send feedback';
    }
  });
  viewNotes.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    try {
      const result = await chrome.runtime.sendMessage({type:'open-note-board'});
      if (!result?.ok) throw Error(result?.error || 'Could not open notes.');
    } catch (error) { notify(error.message,true); }
  });
  window.addEventListener('scroll', schedulePaint, {capture:true, passive:true, signal:listeners.signal});
  window.addEventListener('resize', schedulePaint, {passive:true, signal:listeners.signal});
  function destroy() {
    listeners.abort();
    cancelAnimationFrame(paintRequest);
    clearTimeout(captureTimer);
    clearTimeout(toastTimer);
    chrome.runtime.onMessage.removeListener(onMessage);
    host.remove();
    delete globalThis[instance];
  }
  function onMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type==='pick-feedback') {
      beginFeedback();
      respond({ok:true});
    } else if (message?.type === 'capture-visibility') {
      clearTimeout(captureTimer);
      shell.hidden = message.hidden === true;
      if (shell.hidden) {
        captureTimer = setTimeout(() => { shell.hidden = false; }, 5000);
        // captureVisibleTab reads the rendered surface. Allow the hidden widget
        // to leave that surface before acknowledging, including throttled tabs.
        let done = false;
        const ready = () => {
          if (!done) { done = true; respond({ok:true}); }
        };
        requestAnimationFrame(() => requestAnimationFrame(ready));
        setTimeout(ready,160);
        return true;
      }
      respond({ok:true});
    } else if (message?.type === 'stop-overlay') {
      destroy();
      respond({ok:true});
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis[instance] = {show};
  display('idle');
  show();
})();
