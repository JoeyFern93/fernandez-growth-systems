(() => {
  'use strict';

  const button = document.getElementById('installBtn');
  const dialog = document.getElementById('replayInstallHelp');
  const close = document.getElementById('closeInstallHelp');
  const status = document.getElementById('replayInstallStatus');
  const standalone = window.matchMedia('(display-mode: standalone)');
  const sessionKey = 'fgs-replay-installed';
  let deferred = null;
  let prompting = false;
  let installed = false;
  let canSelfInstall = window.isSecureContext && window.top === window &&
    typeof navigator.install === 'function';
  try { installed = sessionStorage.getItem(sessionKey) === 'yes'; } catch { /* Storage is optional. */ }

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  const device = ios ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';
  for (const section of dialog.querySelectorAll('[data-install-device]')) {
    section.hidden = section.dataset.installDevice !== device;
  }

  function closeHelp() {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else {
      dialog.removeAttribute('open');
      button.focus();
    }
  }

  function updateButton() {
    const native = deferred || canSelfInstall || prompting;
    button.hidden = installed || standalone.matches || navigator.standalone === true;
    button.setAttribute('aria-disabled', String(prompting));
    button.textContent = native ? 'Install Replay Cam' : 'How to install';
    if (button.hidden) {
      closeHelp();
      status.hidden = true;
    }
    if (native) {
      button.removeAttribute('aria-haspopup');
      button.removeAttribute('aria-controls');
    } else {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', dialog.id);
    }
  }

  function openHelp() {
    if (dialog.open || button.hidden) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    close.focus();
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferred = event;
    // A new browser offer supersedes an earlier installation in this tab.
    installed = false;
    try { sessionStorage.removeItem(sessionKey); } catch { /* Storage is optional. */ }
    updateButton();
  });

  function rememberInstalled() {
    installed = true;
    deferred = null;
    try { sessionStorage.setItem(sessionKey, 'yes'); } catch { /* Storage is optional. */ }
    updateButton();
  }
  window.addEventListener('appinstalled', rememberInstalled);

  button.addEventListener('click', async () => {
    if (button.hidden || prompting) return;
    status.hidden = true;
    if (!deferred && !canSelfInstall) {
      openHelp();
      return;
    }
    const offer = deferred;
    deferred = null;
    prompting = true;
    updateButton();
    try {
      if (offer) {
        await offer.prompt();
        await offer.userChoice;
      } else {
        await navigator.install();
        rememberInstalled();
      }
    } catch (error) {
      // AbortError covers both cancellation and an unavailable platform prompt.
      canSelfInstall = false;
      status.textContent = error.name === 'AbortError'
        ? 'Installation did not finish. You can keep using Replay Cam here.'
        : 'Your browser could not start installation. Choose How to install for the browser menu steps.';
      status.hidden = false;
    } finally {
      prompting = false;
      updateButton();
    }
  });

  close.addEventListener('click', closeHelp);
  dialog.addEventListener('close', () => { if (!button.hidden) button.focus(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHelp();
    }
  });
  if (standalone.addEventListener) standalone.addEventListener('change', updateButton);
  else if (standalone.addListener) standalone.addListener(updateButton);
  updateButton();
})();
