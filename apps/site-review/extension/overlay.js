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
  const shield = make('div', {class:'shield', tabindex:'-1', role:'group',
    'aria-label':'Choose a page element. Use arrow keys to move, Enter to select, Tab for more options, or Escape to cancel.'});
  const outline = make('div', {class:'outline', 'aria-hidden':'true'});
  const tools = make('div', {class:'tools', role:'group', 'aria-label':'Feedback target'});
  const whole = button('Whole page');
  const cancel = button('Cancel');
  tools.append(make('strong', {}, 'Select an item on the page'), whole, cancel);
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
  shell.append(shield, outline, tools, launcher, panel, toast, announcement);
  root.append(shell);
  const selectable = 'h1,h2,h3,h4,h5,h6,p,a,button,summary,label,input,select,textarea,img,video,figure,li,table,blockquote,iframe,[role="button"],[role="link"]';
  const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
  let state = 'idle', target, active, submitId, pending = false;
  let notePath, paintRequest, toastTimer, captureTimer;
  const listeners = new AbortController();
  const atPath = () => location.origin + location.pathname;

  function show() {
    if (!host.isConnected) document.documentElement.append(host);
  }
  function display(next) {
    state = next;
    launcher.hidden = next !== 'idle';
    panel.hidden = next !== 'compose';
    shield.hidden = tools.hidden = next !== 'pick';
    outline.hidden = true;
    toast.textContent = '';
    announcement.textContent = '';
  }
  function notify(text) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toastTimer = setTimeout(() => { toast.textContent = ''; }, 4500);
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
  function paint() {
    paintRequest = undefined;
    outline.hidden = state !== 'pick' || !active?.isConnected;
    if (outline.hidden) return;
    const box = active.getBoundingClientRect();
    Object.assign(outline.style, {left:box.left+'px', top:box.top+'px', width:box.width+'px', height:box.height+'px'});
  }
  function schedulePaint() {
    if (state === 'pick' && !paintRequest) paintRequest = requestAnimationFrame(paint);
  }
  function pick() {
    if (pending) return;
    active = null;
    display('pick');
    shield.focus({preventScroll:true});
  }
  function compose(element, resume = false) {
    if (!resume) {
      target = context(element);
      notePath = atPath();
      submitId = crypto.randomUUID();
    }
    display('compose');
    summary.textContent = target.elementLabel ? 'Selected · '+target.elementLabel : 'Whole page · '+location.pathname;
    alert.textContent = '';
    note.focus({preventScroll:true});
  }
  function minimize() {
    if (pending) return;
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
  launcher.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (note.value.trim() && target && notePath === atPath()) compose(null,true);
    else pick();
  });
  whole.addEventListener('click', () => compose(null));
  cancel.addEventListener('click', minimize);
  close.addEventListener('click', minimize);
  change.addEventListener('click', pick);
  shield.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    active = atPoint(event);
    schedulePaint();
  });
  shield.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    const element = atPoint(event);
    if (element) compose(element);
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
    if (state === 'pick' && event.key === 'Tab') {
      event.preventDefault();
      const controls = [shield,whole,cancel];
      controls[(controls.indexOf(root.activeElement)+(event.shiftKey ? 2 : 1))%3].focus({preventScroll:true});
    }
    if (state !== 'pick' || root.activeElement !== shield) return;
    if (['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      move(['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!active) move(1);
      if (active) compose(active);
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
      notify('Feedback saved.');
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
    if (message?.type === 'capture-visibility') {
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
