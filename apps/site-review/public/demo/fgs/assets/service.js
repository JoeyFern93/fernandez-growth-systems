
(function () {
  var button = document.querySelector('.menu-toggle');
  var nav = document.querySelector('.site-nav');
  function closeMenu(restoreFocus) {
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open navigation');
    nav.classList.remove('open'); document.body.classList.remove('nav-open');
    if (restoreFocus) button.focus({ preventScroll: true });
  }
  button.addEventListener('click', function () {
    if (button.getAttribute('aria-expanded') === 'true') { closeMenu(false); return; }
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-label', 'Close navigation');
    nav.classList.add('open'); document.body.classList.add('nav-open');
    nav.scrollTop = 0;
    var first = nav.querySelector('a'); if (first) first.focus({ preventScroll: true });
  });
  nav.querySelectorAll('a').forEach(function (link) { link.addEventListener('click', function () { closeMenu(false); }); });
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function () {
      var target = document.getElementById(link.getAttribute('href').slice(1));
      if (!target) return;
      var destination = link.classList.contains('skip-link') ? target : target.querySelector('h1, h2') || target;
      if (!destination.hasAttribute('tabindex')) destination.setAttribute('tabindex', '-1');
      window.requestAnimationFrame(function () { destination.focus({ preventScroll: true }); });
    });
  });
  function closeMenuAfterFocusLeaves(event) {
    if (button.getAttribute('aria-expanded') === 'true' &&
        !nav.contains(event.relatedTarget) && !button.contains(event.relatedTarget)) closeMenu(false);
  }
  nav.addEventListener('focusout', closeMenuAfterFocusLeaves);
  button.addEventListener('focusout', closeMenuAfterFocusLeaves);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') closeMenu(true); });
  document.addEventListener('pointerdown', function (event) {
    if (button.getAttribute('aria-expanded') === 'true' && !nav.contains(event.target) && !button.contains(event.target)) closeMenu(false);
  });
  window.addEventListener('resize', function () { if (window.innerWidth > 1040) closeMenu(false); });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) closeMenu(window.innerWidth <= 1040 && nav.contains(document.activeElement));
  });
  document.getElementById('year').textContent = String(new Date().getFullYear());
}());
