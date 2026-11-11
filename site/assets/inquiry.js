(function () {
  'use strict';
  var form = document.getElementById('review-form');
  if (!form) return;
  var labels = { review: 'Growth Systems Review', sprint: 'Build & Fix Sprint', support: 'Ongoing Growth Support' };
  var service = document.getElementById('service-interest');
  var context = document.getElementById('interest-context');
  var interest = new URLSearchParams(window.location.search).get('interest');
  var message = document.getElementById('message');
  var count = document.getElementById('message-count');
  var website = document.getElementById('website');
  var status = document.getElementById('form-status');
  var button = form.querySelector('button[type="submit"]');
  var busy = false;
  var completed = false;
  function updateContext() {
    var selected = service.value;
    context.hidden = selected === 'Not sure yet';
    context.textContent = context.hidden ? '' : 'Interested in: ' + selected;
  }
  if (Object.prototype.hasOwnProperty.call(labels, interest)) service.value = labels[interest];
  updateContext();
  service.addEventListener('change', updateContext);
  function updateCount() { count.textContent = message.value.length + ' / 2000'; }
  message.addEventListener('input', updateCount);
  updateCount();
  website.addEventListener('blur', function () {
    var value = website.value.trim();
    if (value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value.replace(/^\/+/, '');
    website.value = value;
  });
  // Back/forward-cache restoration must not leave an unfinished inquiry locked.
  window.addEventListener('pageshow', function () {
    if (!completed) { busy = false; button.disabled = false; button.removeAttribute('aria-busy'); }
  });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || completed || !form.reportValidity()) return;
    busy = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.className = 'form-status visible';
    status.textContent = 'Sending your inquiry…';
    try {
      var response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)).toString()
      });
      if (!response.ok) throw new Error('Inquiry was not accepted.');
      completed = true;
      status.textContent = 'Thank you. Your inquiry has been received for Joe to review. You have not been subscribed to marketing. No paid work begins until you agree on a scope and fee.';
      status.classList.add('is-success');
      form.querySelector('fieldset').hidden = true;
      form.querySelector('.form-actions').hidden = true;
      form.querySelector('.inquiry-intro').hidden = true;
      context.hidden = true;
      status.focus({ preventScroll: false });
    } catch (error) {
      status.classList.add('is-error');
      status.textContent = 'Your inquiry could not be confirmed. Your entries are still here. Check your connection and try again. If you already clicked Send, check for a response before sending a duplicate.';
      status.focus({ preventScroll: false });
    } finally {
      busy = false;
      button.disabled = completed;
      button.removeAttribute('aria-busy');
    }
  });
}());
