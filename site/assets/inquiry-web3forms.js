/* Reviewed Web3Forms inquiry adapter. Public key configuration is stored separately. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FGSWeb3Forms = factory();
}(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  var ENDPOINT = 'https://api.web3forms.com/submit';
  // Web3Forms' documented, shared PUBLIC Free-plan hCaptcha sitekey, not a secret.
  var HCAPTCHA_SITEKEY = '50b2fe65-b00b-4b9e-ad62-3ba471098be2';
  var FIELD_NAMES = ['name', 'email', 'business', 'website', 'service_interest', 'challenge', 'message'];
  var MESSAGES = {
    unavailable: 'Inquiries are unavailable in this preview. No new inquiries can be sent from this copy.',
    pending: 'Sending your inquiry. Please keep this page open.',
    captcha: 'Complete the spam check before sending. Your entries are still here.',
    captchaError: 'The spam check could not load or expired. Your entries are still here. Please try the check again, or email joe@fernandezgrowthsystems.com.',
    error: 'Your inquiry could not be confirmed. Your entries are still here. Check your connection and complete the spam check again before retrying. If you already clicked Send, check for a response before sending a duplicate. You can also email joe@fernandezgrowthsystems.com.',
    limit: 'The inquiry service is temporarily unavailable. Your entries are still here. Please try later, or email joe@fernandezgrowthsystems.com. Check for a response before sending a duplicate.',
    success: 'Thank you. Your inquiry has been submitted for Joe to review. You have not been subscribed to marketing. No paid work begins until you agree on a scope and fee.'
  };

  function validateConfig(config, location) {
    if (!config || config.enabled !== true || config.privacyReviewed !== true || config.hcaptchaRequired !== true) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.accessKey || '')) return false;
    if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(config.accessKey)) return false;
    if (!location || location.protocol !== 'https:' || !Array.isArray(config.allowedHosts)) return false;
    return config.allowedHosts.some(function (host) {
      return typeof host === 'string' && host === location.hostname.toLowerCase() && !/[\s/:*]/.test(host);
    });
  }

  // This function never retries. A lost response can follow a successful send.
  function createSender(options) {
    var busy = false, completed = false;
    function state(kind) { options.onState(kind); }
    return {
      getState: function () { return { busy: busy, completed: completed }; },
      send: async function (fields) {
        if (busy || completed) return false;
        busy = true;
        state('pending');
        var timer, controller = new options.AbortController();
        try {
          var body = { access_key: options.accessKey, subject: 'FGS - New website inquiry', from_name: 'Fernandez Growth Systems', botcheck: false };
          FIELD_NAMES.forEach(function (name) { body[name] = String(fields[name] || '').trim(); });
          body['h-captcha-response'] = fields['h-captcha-response'];
          var timeout = new Promise(function (_, reject) {
            timer = options.setTimeout(function () { controller.abort(); reject(new Error('timeout')); }, 20000);
          });
          var result = await Promise.race([
            (async function () {
              var response = await options.fetch(ENDPOINT, {
                method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body), signal: controller.signal
              });
              var data;
              try { data = await response.json(); } catch (_) { return 'error'; }
              if (response.status === 429) return 'limit';
              return response.ok && data && data.success === true ? 'success' : 'error';
            }()),
            timeout
          ]);
          completed = result === 'success';
          state(result);
          return completed;
        } catch (_) {
          state('error');
          return false;
        } finally {
          options.clearTimeout(timer);
          busy = false;
          options.onSettled(completed);
        }
      }
    };
  }

  function init(win, config) {
    var doc = win.document, form = doc.getElementById('review-form');
    if (!form || form.getAttribute('data-web3forms-mounted') === 'true') return null;
    var status = doc.getElementById('form-status');
    var button = form.querySelector('button[type="submit"]');
    var fieldset = form.querySelector('fieldset');
    function stagingBlocked() {
      return form.hasAttribute('data-migration-blocked') || form.querySelector('[data-migration-blocked]') || doc.querySelector('script[src*="migration-staging.js"]');
    }
    function show(kind, focus) {
      if (!status) return;
      status.className = 'form-status visible' + (kind === 'success' ? ' is-success' : kind === 'pending' ? '' : ' is-error');
      status.textContent = MESSAGES[kind];
      if (focus) status.focus({ preventScroll: false });
    }
    function block() {
      if (fieldset) fieldset.disabled = true;
      if (button) { button.disabled = true; button.setAttribute('aria-disabled', 'true'); }
      show('unavailable', false);
      form.addEventListener('submit', function (event) { event.preventDefault(); }, true);
      return null;
    }
    // Never remove/override any staging guard. A production integration must be reviewed separately.
    if (!validateConfig(config, win.location) || !status || !button || !fieldset ||
        form.getAttribute('data-inquiry-provider') !== 'web3forms' || form.getAttribute('data-inquiry-enabled') !== 'true' ||
        form.getAttribute('data-inquiry-transport') !== 'ajax-only' || form.getAttribute('action') !== ENDPOINT ||
        String(form.getAttribute('method') || '').toLowerCase() !== 'post' ||
        fieldset.getAttribute('data-nojs-disabled') !== 'true' || button.getAttribute('data-nojs-disabled') !== 'true' ||
        stagingBlocked() ||
        typeof win.fetch !== 'function' || typeof win.AbortController !== 'function') return block();
    var captcha = doc.getElementById('inquiry-captcha');
    if (!captcha) return block();
    form.setAttribute('data-web3forms-mounted', 'true');
    var widgetId = null, captchaReady = false;
    function updateControls(busy, completed) {
      var guarded = stagingBlocked();
      fieldset.disabled = !!(busy || completed || guarded);
      button.disabled = !!(busy || completed || guarded);
      button.setAttribute('aria-disabled', String(button.disabled));
      button.textContent = guarded ? 'Inquiries unavailable' : busy ? 'Sending inquiry…' : completed ? 'Inquiry submitted' : 'Send inquiry';
      if (busy) form.setAttribute('aria-busy', 'true');
      else form.removeAttribute('aria-busy');
    }
    var sender = createSender({
      accessKey: config.accessKey, fetch: win.fetch.bind(win), AbortController: win.AbortController,
      setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win),
      onState: function (kind) {
        updateControls(kind === 'pending', kind === 'success');
        show(kind, kind !== 'pending');
        if (kind === 'success') {
          fieldset.hidden = true;
          ['.form-actions', '.inquiry-intro', '#interest-context', '#inquiry-captcha-group'].forEach(function (selector) {
            var element = form.querySelector(selector);
            if (element) element.hidden = true;
          });
        }
      },
      onSettled: function (completed) {
        updateControls(false, completed);
        // Tokens are single-use even after an uncertain network response. Never reset the user's fields.
        if (captchaReady && win.hcaptcha) {
          try { win.hcaptcha.reset(widgetId); } catch (_) { captchaReady = false; }
        }
      }
    });
    var service = doc.getElementById('service-interest'), context = doc.getElementById('interest-context');
    var message = doc.getElementById('message'), count = doc.getElementById('message-count');
    var website = doc.getElementById('website');
    function updateContext() {
      if (!service || !context) return;
      context.hidden = service.value === 'Not sure yet';
      context.textContent = context.hidden ? '' : 'Interested in: ' + service.value;
    }
    if (service) {
      var labels = { review: 'Growth Systems Review', sprint: 'Build & Fix Sprint', support: 'Ongoing Growth Support' };
      var interest = new URLSearchParams(win.location.search).get('interest');
      if (Object.prototype.hasOwnProperty.call(labels, interest)) service.value = labels[interest];
      service.addEventListener('change', updateContext);
      updateContext();
    }
    if (message && count) {
      function updateCount() { count.textContent = message.value.length + ' / 2000'; }
      message.addEventListener('input', updateCount);
      updateCount();
    }
    if (website) website.addEventListener('blur', function () {
      var value = website.value.trim();
      website.value = value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? 'https://' + value : value;
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var current = sender.getState();
      if (current.busy || current.completed) return;
      // Recheck activation at send time so DOM changes cannot casually remove the staging protection.
      if (form.getAttribute('data-inquiry-enabled') !== 'true' || stagingBlocked()) { block(); return; }
      if (!form.reportValidity()) return;
      var data = new win.FormData(form), fields = {};
      // Keep the existing hidden field as a second signal; no fake success for bots.
      if (String(data.get('bot-field') || '').trim() || data.get('botcheck')) { show('error', true); return; }
      if (!captchaReady || !win.hcaptcha) { show('captchaError', true); return; }
      var token;
      try { token = win.hcaptcha.getResponse(widgetId); } catch (_) { show('captchaError', true); return; }
      if (!token) { show('captcha', true); return; }
      FIELD_NAMES.forEach(function (name) { fields[name] = data.get(name); });
      fields['h-captcha-response'] = token;
      void sender.send(fields);
    });
    win.addEventListener('pageshow', function () {
      if (stagingBlocked()) { block(); return; }
      var current = sender.getState();
      updateControls(current.busy, current.completed);
    });
    updateControls(false, false);
    status.className = 'form-status';
    status.textContent = '';

    // Explicit render prevents SDK load order races. No separate hCaptcha account or secret is needed.
    win.fgsInquiryCaptchaReady = function () {
      if (captchaReady || !win.hcaptcha || typeof win.hcaptcha.render !== 'function') return;
      try {
        widgetId = win.hcaptcha.render(captcha, {
          // Compact fits the form's narrow content area at 320px without scaling/cropping.
          sitekey: HCAPTCHA_SITEKEY, theme: 'light', size: 'compact',
          'expired-callback': function () { if (!sender.getState().busy && !sender.getState().completed) show('captcha', false); },
          'error-callback': function () { if (!sender.getState().busy && !sender.getState().completed) show('captchaError', false); }
        });
        captchaReady = true;
      } catch (_) { show('captchaError', false); }
    };
    return sender;
  }
  return { init: init, validateConfig: validateConfig, createSender: createSender, messages: MESSAGES };
}));
