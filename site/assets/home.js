(function () {
      const menuButton = document.querySelector('.menu-toggle');
      const navigation = document.querySelector('.site-nav');
      const sectionLinks = Array.from(navigation.querySelectorAll('.nav-link[href^="#"]'));
      const reviewLink = navigation.querySelector('.header-cta[href="#review"]');
      const trackedSections = sectionLinks
        .map(function (link) {
          return {
            link: link,
            section: document.querySelector(link.getAttribute('href'))
          };
        })
        .filter(function (item) { return item.section; });
      const reviewSection = document.getElementById('review');
      const backToTop = document.getElementById('back-to-top');
      const mobileCta = document.getElementById('mobile-cta');
      const progressBar = document.getElementById('scroll-progress-bar');
      const year = document.getElementById('year');
      let scrollTicking = false;

      function closeMenu(returnFocus) {
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.setAttribute('aria-label', 'Open navigation');
        navigation.classList.remove('open');
        document.body.classList.remove('nav-open');
        if (returnFocus) {
          menuButton.focus();
        }
      }

      function openMenu() {
        menuButton.setAttribute('aria-expanded', 'true');
        menuButton.setAttribute('aria-label', 'Close navigation');
        navigation.classList.add('open');
        document.body.classList.add('nav-open');
        window.requestAnimationFrame(function () {
          if (menuButton.getAttribute('aria-expanded') !== 'true') return;
          const firstLink = navigation.querySelector('a');
          if (firstLink) firstLink.focus();
        });
      }

      function updateScrollUi() {
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const progress = Math.min(1, Math.max(0, scrollTop / maxScroll));
        const headerOffset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 78;
        let activeId = '';
        const reviewRect = reviewSection.getBoundingClientRect();

        progressBar.style.transform = 'scaleX(' + progress + ')';
        backToTop.classList.toggle('is-visible', scrollTop > 700);
        backToTop.inert = scrollTop <= 700;

        let nearestSectionTop = -Infinity;
        trackedSections.forEach(function (item) {
          const top = item.section.getBoundingClientRect().top;
          if (top <= headerOffset + 150 && top > nearestSectionTop) {
            activeId = item.section.id;
            nearestSectionTop = top;
          }
        });

        if (reviewRect.top <= headerOffset + 150 && reviewRect.bottom > headerOffset + 150) {
          activeId = 'review';
        }

        trackedSections.forEach(function (item) {
          if (item.section.id === activeId) {
            item.link.setAttribute('aria-current', 'location');
          } else {
            item.link.removeAttribute('aria-current');
          }
        });

        if (activeId === 'review') {
          reviewLink.setAttribute('aria-current', 'location');
        } else {
          reviewLink.removeAttribute('aria-current');
        }

        const showMobileCta = window.innerWidth <= 760 &&
          scrollTop > 620 &&
          reviewRect.top > window.innerHeight * 0.72;
        mobileCta.classList.toggle('is-visible', showMobileCta);
        mobileCta.inert = !showMobileCta;
        scrollTicking = false;
      }

      function requestScrollUpdate() {
        if (!scrollTicking) {
          scrollTicking = true;
          window.requestAnimationFrame(updateScrollUi);
        }
      }

      menuButton.addEventListener('click', function () {
        const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
        if (isOpen) {
          closeMenu(false);
        } else {
          openMenu();
        }
      });

      document.querySelectorAll('a[href^="#"]').forEach(function (link) {
        link.addEventListener('click', function () {
          closeMenu(false);
          const href = link.getAttribute('href');
          const target = href && href.startsWith('#') && document.getElementById(href.slice(1));
          if (target) {
            const heading = link.classList.contains('skip-link') ? target : target.querySelector('h1, h2') || target;
            if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
            window.requestAnimationFrame(function () {
              heading.focus({ preventScroll: true });
            });
          }
        });
      });

      function closeMenuAfterFocusLeaves(event) {
        if (menuButton.getAttribute('aria-expanded') === 'true' &&
            !navigation.contains(event.relatedTarget) && !menuButton.contains(event.relatedTarget)) {
          closeMenu(false);
        }
      }
      navigation.addEventListener('focusout', closeMenuAfterFocusLeaves);
      menuButton.addEventListener('focusout', closeMenuAfterFocusLeaves);

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
          closeMenu(true);
        }
      });

      document.addEventListener('pointerdown', function (event) {
        if (
          menuButton.getAttribute('aria-expanded') === 'true' &&
          !navigation.contains(event.target) &&
          !menuButton.contains(event.target)
        ) {
          closeMenu(false);
        }
      });

      window.addEventListener('resize', function () {
        if (window.innerWidth > 1040) {
          closeMenu(false);
        }
        requestScrollUpdate();
      });

      window.addEventListener('scroll', requestScrollUpdate, { passive: true });

      updateScrollUi();
      year.textContent = String(new Date().getFullYear());
    }());
