/* Load this file on each page of a preview that you want clients to review. */
(() => {
  'use strict';

  const script = document.currentScript;
  // A normal visit must leave the website's controls and focus behavior alone.
  if (!script?.src || window.parent === window) return;
  const scriptOrigin = new URL(script.src).origin;
  const configuredOrigin = script.getAttribute('data-review-origin');
  const canonicalOrigin = 'https://sitereview.fernandezgrowthsystems.com';
  // A site with a first-party-only script policy can host a copy of this file.
  // Only the explicitly configured review service is allowed to control it.
  if (configuredOrigin && configuredOrigin !== canonicalOrigin && configuredOrigin !== scriptOrigin) return;
  const reviewOrigin = configuredOrigin || scriptOrigin;
  const channel = 'fgs-site-review-v1';
  const instance = Symbol.for(channel);
  if (window[instance]) return;
  window[instance] = true;

  const selectable = 'h1,h2,h3,h4,h5,h6,p,a,button,summary,label,input,select,textarea,img,video,figure,li,table,blockquote,[role="button"],[role="link"],[data-review-target]';
  let connected = false;
  let picking = false;
  let overlay;
  let outline;
  let announcement;
  let active;
  let previousFocus;
  let paintRequest;

  function send(type, values = {}) {
    window.parent.postMessage({ channel, type, ...values }, reviewOrigin);
  }

  function pageInfo() {
    // The source website may carry unrelated private parameters in its URL.
    return { url: location.origin + location.pathname, title: document.title.slice(0, 160) };
  }

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'group');
    overlay.setAttribute('aria-label', 'Choose a page element. Use the arrow keys to move. Press Enter to leave a note, or Escape to cancel.');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', display: 'none', pointerEvents: 'none',
      zIndex: '2147483647', margin: '0', padding: '0', outline: 'none', background: 'transparent'
    });
    const shadow = overlay.attachShadow({ mode: 'closed' });
    outline = document.createElement('div');
    Object.assign(outline.style, {
      position: 'absolute', boxSizing: 'border-box', pointerEvents: 'none',
      border: '3px solid #116646', boxShadow: '0 0 0 2px white', borderRadius: '4px',
      background: 'rgba(91, 191, 141, .14)', display: 'none'
    });
    announcement = document.createElement('span');
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    Object.assign(announcement.style, {
      position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)'
    });
    shadow.append(outline, announcement);
    document.documentElement.append(overlay);
  }

  function elementLabel(element) {
    // Never read field values or user-entered content from editable areas.
    const editing = element.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
    const text = element.getAttribute('aria-label') || element.getAttribute('alt') ||
      (editing ? editing.labels?.[0]?.textContent : element.innerText) || element.localName;
    return text.replace(/\s+/g, ' ').trim().slice(0, 100) || element.localName;
  }

  function selectorFor(element) {
    const parts = [];
    for (let node = element; node && parts.length < 9; node = node.parentElement) {
      if (node.id && node.id.length < 100) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const siblings = node.parentElement?.children;
      const index = siblings ? Array.from(siblings).indexOf(node) + 1 : 1;
      parts.unshift(`${CSS.escape(node.localName)}:nth-child(${index})`);
    }
    return parts.join(' > ').slice(0, 420);
  }

  function selectableAt(node) {
    if (!(node instanceof Element) || node === overlay) return null;
    const element = node.closest(selectable) || node;
    if (element === document.body || element === document.documentElement || element.closest('[hidden],[inert]')) return null;
    return element;
  }

  function paint() {
    paintRequest = null;
    if (!picking || !active || !active.isConnected) {
      if (outline) outline.style.display = 'none';
      return;
    }
    const box = active.getBoundingClientRect();
    Object.assign(outline.style, {
      display: 'block', left: box.left + 'px', top: box.top + 'px',
      width: box.width + 'px', height: box.height + 'px'
    });
  }

  function schedulePaint() {
    if (picking && !paintRequest) paintRequest = requestAnimationFrame(paint);
  }

  function setMode(pick, keyboard = false) {
    if (pick === picking) return;
    picking = pick;
    if (pick) {
      createOverlay();
      previousFocus = document.activeElement;
      overlay.style.display = 'block';
      announcement.textContent = '';
      // Keep an open menu or disclosure in its current state when marking it.
      active = selectableAt(previousFocus);
      if (keyboard && !active) overlay.focus({ preventScroll: true });
      paint();
    } else {
      active = null;
      overlay.style.display = 'none';
      if (document.activeElement === overlay && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
      previousFocus = null;
    }
  }

  function choose(element, clientX, clientY) {
    const box = element.getBoundingClientRect();
    const doc = document.scrollingElement || document.documentElement;
    const x = clientX ?? Math.max(0, Math.min(innerWidth, box.left + box.width / 2));
    const y = clientY ?? Math.max(0, Math.min(innerHeight, box.top + box.height / 2));
    const fraction = (position, total) => Math.max(0, Math.min(1, position / Math.max(1, total)));
    const details = {
      ...pageInfo(),
      element: { tag: element.localName, label: elementLabel(element), selector: selectorFor(element) },
      viewport: { width: innerWidth, height: innerHeight }, scrollX, scrollY,
      x: fraction(x + scrollX, doc.scrollWidth), y: fraction(y + scrollY, doc.scrollHeight)
    };
    setMode(false);
    send('selected', details);
  }

  function keyboardTarget(direction) {
    const candidates = Array.from(document.querySelectorAll(selectable)).filter(element =>
      !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length && getComputedStyle(element).visibility === 'visible'
    );
    if (!candidates.length) return null;
    const index = candidates.indexOf(active);
    if (index < 0) return direction === 1 ? candidates[0] : candidates[candidates.length - 1];
    return candidates[(index + direction + candidates.length) % candidates.length];
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== reviewOrigin || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.type === 'connect') {
      if (!connected) {
        connected = true;
        attachReviewEvents();
      }
      send('connected', pageInfo());
    } else if (connected && message.type === 'mode' && ['pick', 'browse'].includes(message.mode)) {
      setMode(message.mode === 'pick', message.keyboard === true);
    }
  });

  function attachReviewEvents() {
    window.addEventListener('pointermove', event => {
      if (!picking || event.pointerType === 'touch') return;
      active = selectableAt(event.target);
      schedulePaint();
    }, { capture: true, passive: true });

    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
      window.addEventListener(type, event => {
        if (picking && event.button === 0) {
          if (type === 'mousedown') event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    window.addEventListener('click', event => {
      if (!picking) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = selectableAt(event.target);
      if (element) choose(element, event.detail ? event.clientX : undefined, event.detail ? event.clientY : undefined);
    }, true);

    window.addEventListener('keydown', event => {
      if (!picking) return;
      if (!['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setMode(false);
        send('cancelled');
      } else if (event.key === 'Enter' || event.key === ' ') {
        const element = active || (document.activeElement !== overlay && selectableAt(document.activeElement)) || keyboardTarget(1);
        if (element) choose(element);
      } else {
        active = keyboardTarget(['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1);
        if (!active) return;
        active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const label = elementLabel(active);
        announcement.textContent = label;
        send('highlighted', { label });
        paint();
      }
    }, true);

    window.addEventListener('focusin', event => {
      if (!picking || event.target === overlay) return;
      active = selectableAt(event.target);
      schedulePaint();
    }, true);
    // A reviewer's toolbar sits in the parent page. Crossing this boundary has
    // no next element in the preview. Menus that dismiss on local focus changes
    // should stay available to mark, while ordinary in-page focus moves proceed.
    function preserveOpenNavigation(event) {
      if (event.relatedTarget && event.relatedTarget !== overlay) return;
      const element = event.target;
      if (!(element instanceof Element) || element.closest('input,textarea,select,[contenteditable]')) return;
      if (element.closest('nav,[role="navigation"],[role="menu"],[role="menubar"],details[open],[aria-expanded="true"]')) {
        event.stopImmediatePropagation();
      }
    }
    window.addEventListener('focusout', preserveOpenNavigation, true);
    window.addEventListener('blur', preserveOpenNavigation, true);
    window.addEventListener('scroll', schedulePaint, { capture: true, passive: true });
    window.addEventListener('resize', schedulePaint, { passive: true });
  }
  window.addEventListener('pageshow', () => send('ready'));
  const notifyNavigation = () => {
    if (connected) send('connected', pageInfo());
  };
  if (window.navigation) window.navigation.addEventListener('currententrychange', notifyNavigation);
  else window.addEventListener('popstate', notifyNavigation);
  send('ready');
})();
