(function () {
  'use strict';
  var form = document.getElementById('review-form');
  if (!form) return;
  // This file is deliberately staging-only. Production verification rejects it.
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    var status = document.getElementById('form-status');
    if (status) {
      status.className = 'form-status visible';
      status.textContent = 'This preview does not send inquiries. Email delivery will be tested before the live site moves.';
      status.focus();
    }
  }, true);
}());
