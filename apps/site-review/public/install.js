(() => {
  'use strict';
  // Manual home-screen shortcuts can retain the address of the open tab.
  if (location.pathname !== '/' || location.search || location.hash) return;

  let pendingPrompt = null;
  let installed = false;
  const standalone = window.matchMedia('(display-mode: standalone)');
  const triggerSelector = '[data-install-review]';
  let help;

  function update() {
    const button = document.querySelector(triggerSelector);
    if (button) button.hidden = installed || standalone.matches || navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', event => {
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
        'Open this page in Safari and tap Share.',
        'Choose Add to Home Screen. Leave Open as Web App on if shown, then tap Add.'
      ] : android ? [
        'Open your browser menu, usually the three dots.',
        'Choose Install app or Add to Home screen, then confirm.'
      ] : [
        'In Chrome or Edge, open the browser menu and look for an Install option. On a Mac in Safari, choose File, then Add to Dock.',
        'If your browser does not offer installation, bookmark this page to open it again.'
      ];
      help = document.createElement('dialog');
      help.className = 'review-install-dialog';
      help.setAttribute('aria-labelledby', 'review-install-heading');
      const heading = document.createElement('h2');
      heading.id = 'review-install-heading';
      heading.textContent = 'Add Site Review as an app';
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
    if (!pendingPrompt) {
      openInstructions(button);
      return;
    }
    const prompt = pendingPrompt;
    pendingPrompt = null;
    button.disabled = true;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      openInstructions(button);
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
