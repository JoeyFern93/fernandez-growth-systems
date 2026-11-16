(() => {
  'use strict';

  const path = location.pathname.replace(/\/$/, '');
  const apps = {
    '/tools': { id: 'directory', name: 'FGS Tools', worker: '/tools-directory-sw.js', scope: '/tools' },
    '/tools.html': { id: 'directory', name: 'FGS Tools', worker: '/tools-directory-sw.js', scope: '/tools' },
    '/tools/room-measure': { id: 'room-measure', name: 'Room Measure', worker: '/tools/room-measure-sw.js', scope: '/tools/room-measure' },
    '/tools/room-measure.html': { id: 'room-measure', name: 'Room Measure', worker: '/tools/room-measure-sw.js', scope: '/tools/room-measure' },
    '/replay': { id: 'replay', name: 'Replay Cam' },
    '/replay/index.html': { id: 'replay', name: 'Replay Cam' }
  };
  const app = apps[path];
  const triggers = [...document.querySelectorAll('[data-tool-install]')];
  if (!app || !['https:', 'http:'].includes(location.protocol)) {
    triggers.forEach(button => { button.hidden = true; });
    return;
  }

  const standaloneQuery = window.matchMedia('(display-mode: standalone)');
  const dismissalKey = `fgs-install-dismissed:${app.id}`;
  let standalone = standaloneQuery.matches || navigator.standalone === true;
  let installedThisVisit = false;
  let deferredPrompt = null;
  let prompting = false;
  let previousFocus = null;

  const create = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  const mark = element => { element.dataset.toolInstallUi = ''; return element; };
  const banner = mark(create('aside', 'tool-install-banner'));
  banner.setAttribute('aria-label', `Add ${app.name} to your device`);
  const bannerCopy = create('div', 'tool-install-banner-copy');
  bannerCopy.append(create('strong', '', `${app.name}, one tap away`),
    create('span', '', 'Open this tool from your home screen.'));
  const bannerAction = create('button', 'tool-install-action', 'Add as app');
  bannerAction.type = 'button';
  const dismiss = create('button', 'tool-install-dismiss', '×');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss app suggestion');
  banner.append(bannerCopy, bannerAction, dismiss);
  const main = document.querySelector('main');
  if (main) main.before(banner);
  else document.body.append(banner);

  const dialog = mark(create('dialog', 'tool-install-dialog'));
  dialog.id = 'fgs-install-dialog';
  dialog.setAttribute('aria-labelledby', 'fgs-install-title');
  dialog.setAttribute('aria-describedby', 'fgs-install-description');
  const inner = create('div', 'tool-install-dialog-inner');
  const close = create('button', 'tool-install-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close app instructions');
  const title = create('h2', '', `Add ${app.name} as an app`);
  title.id = 'fgs-install-title';
  title.tabIndex = -1;
  const description = create('p', '', 'Keep this tool on your home screen or in your device’s app launcher.');
  description.id = 'fgs-install-description';
  const status = create('p', 'tool-install-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const nativeAction = create('button', 'tool-install-action tool-install-native', 'Add as app');
  nativeAction.type = 'button';
  nativeAction.hidden = true;

  const instructions = {
    ios: { title: 'iPhone or iPad', steps: ['Open this tool in Safari.', 'Tap Share (the square with the upward arrow).', 'Choose Add to Home Screen, then tap Add. Keep Open as Web App on if it is shown.'] },
    android: { title: 'Android', steps: ['Open this tool in Chrome or your preferred browser.', 'Open the browser menu (⋮).', 'Choose Add to Home screen or Install app, then confirm. The wording depends on your browser.'] },
    desktop: { title: 'Computer', steps: ['In Chrome or Edge, look for an install icon in the address bar or an Install option in the browser menu.', 'On a Mac using Safari, choose File → Add to Dock.', 'If your browser does not offer installation, bookmark this page for quick access.'] }
  };
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
  const current = ios ? 'ios' : /Android/i.test(ua) ? 'android' : 'desktop';
  const addInstructions = (parent, key) => {
    const group = create('section', 'tool-install-instructions');
    group.append(create('h3', '', instructions[key].title));
    const list = create('ol');
    instructions[key].steps.forEach(step => list.append(create('li', '', step)));
    group.append(list);
    parent.append(group);
  };
  const help = create('div', 'tool-install-help');
  addInstructions(help, current);
  const other = create('details', 'tool-install-other');
  other.append(create('summary', '', 'Instructions for other devices'));
  Object.keys(instructions).filter(key => key !== current).forEach(key => addInstructions(other, key));
  help.append(other);
  inner.append(close, title, description, status, nativeAction, help);
  dialog.append(inner);
  document.body.append(dialog);

  function wasDismissed() {
    try { return Date.now() - Number(localStorage.getItem(dismissalKey) || 0) < 7 * 24 * 60 * 60 * 1000; }
    catch { return false; }
  }
  function sync() {
    const added = standalone || installedThisVisit;
    banner.hidden = added || wasDismissed();
    triggers.forEach(button => {
      button.hidden = false;
      button.textContent = added ? 'App options' : 'Add as app';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', dialog.id);
    });
    bannerAction.setAttribute('aria-haspopup', 'dialog');
    bannerAction.setAttribute('aria-controls', dialog.id);
    nativeAction.hidden = added || !deferredPrompt;
    nativeAction.disabled = prompting;
    if (added) {
      title.textContent = `${app.name} app`;
      description.textContent = standalone ? 'You’re already using this tool in its app window.' : 'Your browser confirmed that the app was added to this device.';
    } else {
      title.textContent = `Add ${app.name} as an app`;
      description.textContent = 'Keep this tool on your home screen or in your device’s app launcher.';
    }
  }
  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }
  function openHelp() {
    previousFocus = document.activeElement;
    sync();
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
      }
    }
    document.body.classList.add('tool-install-modal-open');
    title.focus();
  }
  function closed() {
    document.body.classList.remove('tool-install-modal-open');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  function closeHelp() {
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); closed(); }
  }
  async function requestInstall() {
    if (prompting) return;
    if (!deferredPrompt || standalone || installedThisVisit) { openHelp(); return; }
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompting = true;
    // Keep the native prompt directly in this button's user gesture.
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') {
        setStatus('Finish adding the app in your browser if it asks.');
      } else setStatus('You can add the app later from this button or your browser menu.');
    } catch {
      setStatus('Your browser could not open its install prompt. Use the instructions below.');
    } finally {
      prompting = false;
      sync();
      if (!installedThisVisit && !standalone) openHelp();
    }
  }

  triggers.forEach(button => button.addEventListener('click', requestInstall));
  bannerAction.addEventListener('click', requestInstall);
  nativeAction.addEventListener('click', requestInstall);
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem(dismissalKey, String(Date.now())); } catch { /* Optional preference. */ }
    banner.hidden = true;
  });
  close.addEventListener('click', closeHelp);
  dialog.addEventListener('close', closed);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeHelp(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeHelp();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeHelp(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')]
      .filter(element => !element.hidden && element.getClientRects().length);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); title.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === title)) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    sync();
  });
  window.addEventListener('appinstalled', () => {
    installedThisVisit = true;
    deferredPrompt = null;
    setStatus(`${app.name} was added. Look for its icon on your device.`);
    sync();
  });
  const displayChanged = () => { standalone = standaloneQuery.matches || navigator.standalone === true; sync(); };
  if (standaloneQuery.addEventListener) standaloneQuery.addEventListener('change', displayChanged);
  else if (standaloneQuery.addListener) standaloneQuery.addListener(displayChanged);

  sync();
  if (app.worker && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(app.worker, { scope: app.scope, updateViaCache: 'none' }).catch(() => {
      // Installation help remains usable if offline preparation is unavailable.
    });
  }
})();
