(() => {
  'use strict';
  // Manual home-screen shortcuts can retain the address of the open tab.
  if (location.pathname !== '/' || location.search || location.hash) return;

  let pendingPrompt = null;
  let installed = false;
  let canSelfInstall = window.isSecureContext && window.top === window && typeof navigator.install === 'function';
  const standalone = window.matchMedia('(display-mode: standalone)');
  const triggerSelector = '[data-install-review]';
  let help;

  function update() {
    const button = document.querySelector(triggerSelector);
    if (!button) return;
    button.textContent = pendingPrompt || canSelfInstall ? 'Install Site Review' : 'How to install';
    button.hidden = installed || standalone.matches || navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', event => {
    if (typeof event.prompt !== 'function') return;
    event.preventDefault();
    pendingPrompt = event;
    update();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    pendingPrompt = null;
    update();
  });
  if (standalone.addEventListener) standalone.addEventListener('change', update);

  function openInstructions(trigger) {
    if (!help) {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const android = /Android/i.test(navigator.userAgent);
      const instructions = ios ? [
        'In Safari, tap Share. If it’s tucked away, open the page menu beside the address bar and tap Share.',
        'Tap Add to Home Screen. If it’s missing, scroll to Edit Actions and add it.',
        'Turn on Open as Web App if shown, then tap Add.'
      ] : android ? [
        'In Chrome, tap the three-dot menu next to the address bar.',
        'Choose Install and create shortcut, then Install. Some versions show Install app or Add to Home screen in the menu.',
        'Confirm to add Site Review to your phone.'
      ] : [
        'In Chrome or Edge, open the browser menu and look for an Install option. On a Mac in Safari, choose File, then Add to Dock.',
        'If your browser does not offer installation, bookmark this page to open it again.'
      ];
      help = document.createElement('dialog');
      help.className = 'review-install-dialog';
      help.setAttribute('aria-labelledby', 'review-install-heading');
      const heading = document.createElement('h2');
      heading.id = 'review-install-heading';
      heading.textContent = 'How to install Site Review';
      const list = document.createElement('ol');
      for (const instruction of instructions) {
        const item = document.createElement('li');
        item.textContent = instruction;
        list.append(item);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Done';
      close.addEventListener('click', () => help.close());
      help.append(heading, list, close);
      document.body.append(help);
    }
    help.addEventListener('close', () => trigger.focus(), { once: true });
    help.showModal();
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest?.(triggerSelector);
    if (!button || button.hidden || button.disabled) return;
    if (!pendingPrompt && !canSelfInstall) {
      openInstructions(button);
      return;
    }
    const prompt = pendingPrompt;
    pendingPrompt = null;
    button.disabled = true;
    try {
      if (prompt) {
        const result = await prompt.prompt();
        const choice = result || await prompt.userChoice;
        if (choice?.outcome === 'accepted') installed = true;
      } else {
        await navigator.install();
        installed = true;
      }
    } catch (error) {
      // A cancelled self-install can be retried. If the browser blocks the
      // capability for this page, offer its menu instructions on the next click.
      if (!prompt && error?.name !== 'AbortError') canSelfInstall = false;
    } finally {
      button.disabled = false;
      update();
    }
  });

  function attach() {
    update();
    if (document.querySelector(triggerSelector)) return;
    const observer = new MutationObserver(() => {
      if (document.querySelector(triggerSelector)) {
        observer.disconnect();
        update();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, { once: true });
  else attach();
})();
