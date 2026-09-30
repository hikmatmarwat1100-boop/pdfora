(() => {
  const menu = document.querySelector('.menu-toggle');
  const mobileNav = document.getElementById('mobileNav');

  const closeMobileNav = () => {
    if (!menu || !mobileNav) return;
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open menu');
    mobileNav.hidden = true;
  };

  if (menu && mobileNav) {
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') === 'true';
      menu.setAttribute('aria-expanded', String(!open));
      menu.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
      mobileNav.hidden = open;
    });
    mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMobileNav));
    document.addEventListener('click', (event) => {
      if (mobileNav.hidden) return;
      if (!event.target.closest('.site-header')) closeMobileNav();
    });
    window.addEventListener('resize', () => {
      if (window.matchMedia('(min-width: 1021px)').matches) closeMobileNav();
    });
  }

  const dialog = document.getElementById('toolSearchDialog');
  const dialogPanel = dialog?.querySelector('.search-dialog');
  const searchInput = document.getElementById('globalToolSearch');
  const searchItems = [...document.querySelectorAll('[data-search-item]')];
  const searchEmpty = document.getElementById('globalSearchEmpty');
  const openers = document.querySelectorAll('[data-open-search]');
  const closer = document.querySelector('[data-close-search]');
  let previousFocus = null;

  const filterGlobal = () => {
    if (!searchInput) return;
    const query = searchInput.value.trim().toLowerCase();
    let visible = 0;
    searchItems.forEach((item) => {
      const show = !query || item.dataset.searchText.includes(query);
      item.hidden = !show;
      if (show) visible += 1;
    });
    if (searchEmpty) searchEmpty.hidden = visible !== 0;
  };

  const openDialog = () => {
    if (!dialog) return;
    previousFocus = document.activeElement;
    dialog.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => searchInput?.focus());
  };

  const closeDialog = () => {
    if (!dialog) return;
    dialog.hidden = true;
    document.body.style.overflow = '';
    if (searchInput) searchInput.value = '';
    filterGlobal();
    previousFocus?.focus?.();
  };

  const trapDialogFocus = (event) => {
    if (event.key !== 'Tab' || !dialog || dialog.hidden || !dialogPanel) return;
    const focusable = [...dialogPanel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  openers.forEach((button) => button.addEventListener('click', openDialog));
  closer?.addEventListener('click', closeDialog);
  searchInput?.addEventListener('input', filterGlobal);
  dialog?.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (dialog && !dialog.hidden) closeDialog();
      closeMobileNav();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openDialog();
    }
    trapDialogFocus(event);
  });

  function setupCardFilter(inputId, scopeSelector, noResultsId) {
    const input = document.getElementById(inputId);
    const scope = document.querySelector(scopeSelector);
    const empty = document.getElementById(noResultsId);
    if (!input || !scope) return;
    const cards = [...scope.querySelectorAll('.tool-card')];
    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      let visible = 0;
      cards.forEach((card) => {
        const matches = !query || `${card.dataset.toolName} ${card.dataset.category}`.includes(query);
        card.hidden = !matches;
        if (matches) visible += 1;
      });
      if (empty) empty.hidden = visible !== 0;
    });
  }

  setupCardFilter('homeToolSearch', '#homeToolGrid', 'homeNoResults');
  setupCardFilter('allToolsSearch', '.tool-library', 'allToolsNoResults');

  // Local event hook only. No third-party analytics library is enabled.
  window.PDForaAnalytics = {
    track(name, detail = {}) {
      window.dispatchEvent(new CustomEvent('pdfora:analytics', { detail: { name, ...detail } }));
    }
  };

  document.addEventListener('click', (event) => {
    const card = event.target.closest('.tool-card');
    if (card) window.PDForaAnalytics.track('tool_opened', { tool: card.dataset.toolName });
    const result = event.target.closest('[data-search-item]');
    if (result) window.PDForaAnalytics.track('tool_opened', { tool: result.dataset.searchText });
  });
})();
