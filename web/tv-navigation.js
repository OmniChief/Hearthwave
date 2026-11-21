/** Browser/TV-remote navigation with no dependency on a particular television SDK. */
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], audio[controls], summary, [tabindex]:not([tabindex="-1"])';
const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function available(element) {
  return element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]') && window.getComputedStyle(element).visibility !== 'hidden';
}

function targets(root) {
  return Array.from(root.querySelectorAll(focusable)).filter(available);
}

/** Prefer the nearest control in the requested direction, aligned with the current row/column. */
export function findDirectionalTarget(current, candidates, direction) {
  const vector = directions[direction];
  if (!vector) return null;
  const from = current.getBoundingClientRect();
  const fx = (from.left + from.right) / 2;
  const fy = (from.top + from.bottom) / 2;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === current) continue;
    const box = candidate.getBoundingClientRect();
    const dx = (box.left + box.right) / 2 - fx;
    const dy = (box.top + box.bottom) / 2 - fy;
    const forward = dx * vector[0] + dy * vector[1];
    if (forward <= 1) continue;
    const sideways = vector[0] ? Math.max(0, box.top - from.bottom, from.top - box.bottom) : Math.max(0, box.left - from.right, from.left - box.right);
    const gap = vector[0] ? Math.max(0, vector[0] > 0 ? box.left - from.right : from.left - box.right) : Math.max(0, vector[1] > 0 ? box.top - from.bottom : from.top - box.bottom);
    const score = gap + sideways * 3 + forward * 0.12;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

function identity(element) {
  if (element.id) return `id:${element.id}`;
  const attributes = Array.from(element.attributes || [])
    .filter(attribute => attribute.name.startsWith('data-') && attribute.name !== 'data-next')
    .map(attribute => `${attribute.name}=${attribute.value}`).sort();
  if (attributes.length) return `${element.tagName}:${attributes.join('|')}`;
  const form = element.closest('form');
  if (element.name) return `${element.tagName}:name=${element.name}:form=${form?.id || ''}`;
  if (element.tagName === 'SUMMARY') return `SUMMARY:${element.textContent.trim()}`;
  return null;
}

function editing(element) {
  if (element?.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(element.type);
  return ['TEXTAREA', 'SELECT'].includes(element?.tagName) || Boolean(element?.isContentEditable);
}

function remoteKey(event) {
  const keys = { 37:'ArrowLeft', 38:'ArrowUp', 39:'ArrowRight', 40:'ArrowDown', 13:'Enter', 10009:'Back', 461:'Back' };
  if (event.keyCode === 10009 || event.keyCode === 461) return 'Back';
  return event.key && event.key !== 'Unidentified' ? event.key : (keys[event.keyCode] || '');
}

export function installTvNavigation({ onBack, onChannel }) {
  let active = false;
  let remembered = null;
  let lastPageFocus = null;
  let playerOpener = null;
  let restorePending = false;
  const page = document.querySelector('#page');
  const player = document.querySelector('#player-overlay');
  const auth = document.querySelector('#auth');
  const shell = document.querySelector('#shell');
  const scope = () => !player.hidden ? player : !auth.hidden ? auth : shell;

  function focus(element) {
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  document.addEventListener('pointerdown', () => {
    active = false;
    document.body.classList.remove('tv-navigation');
  }, true);

  document.addEventListener('focusin', event => {
    if (!active || !page.contains(event.target)) return;
    const choices = targets(page);
    remembered = { key: identity(event.target), index: choices.indexOf(event.target) };
    lastPageFocus = event.target;
  });

  const observer = new MutationObserver(() => {
    if (!active || !remembered || !lastPageFocus || lastPageFocus.isConnected || restorePending || scope() !== shell) return;
    restorePending = true;
    queueMicrotask(() => {
      restorePending = false;
      if (!active || scope() !== shell || (document.activeElement !== document.body && document.activeElement?.isConnected)) return;
      const choices = targets(page);
      const exact = choices.find(choice => identity(choice) === remembered.key);
      const back = page.querySelector('[data-detail-back], [data-series-back], [data-guide-view="close"]');
      focus(exact || (back && available(back) ? back : null) || choices[Math.min(Math.max(0, remembered.index), choices.length - 1)]);
    });
  });
  observer.observe(page, { childList: true, subtree: true });

  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const key = remoteKey(event);
    const focused = document.activeElement;
    const isBack = ['Escape', 'Backspace', 'Back', 'BrowserBack', 'GoBack', 'XF86Back', 'MediaBack'].includes(key);
    if (!directions[key] && !isBack && !['OK', 'Select', 'Enter'].includes(key)) return;
    if (editing(focused)) {
      if (key === 'Escape' || key === 'Back' || key === 'BrowserBack' || key === 'GoBack') { event.preventDefault(); focused.blur(); }
      return;
    }
    if (['VIDEO','AUDIO'].includes(focused?.tagName) && !isBack && key !== 'ArrowUp' && key !== 'ArrowDown') return;
    active = true;
    document.body.classList.add('tv-navigation');
    if (isBack) { event.preventDefault(); if (scope() !== auth) onBack(!player.hidden); return; }
    if (key === 'OK' || key === 'Select' || (key === 'Enter' && (event.key !== 'Enter' || focused?.matches('input[type="checkbox"], input[type="radio"]')))) {
      if (focused?.matches('button, a[href], summary, input[type="checkbox"], input[type="radio"]')) { event.preventDefault(); focused.click(); }
      return;
    }
    if (key === 'Enter') return; // Native buttons, links and form submits already handle Enter.
    if (!player.hidden && ['ArrowUp','ArrowDown'].includes(key) && onChannel(key === 'ArrowUp' ? -1 : 1)) {
      event.preventDefault();
      return;
    }
    const choices = targets(scope());
    const current = choices.includes(focused) ? focused : null;
    const initial = scope() === shell ? shell.querySelector('.primary-nav .selected:not([hidden])') : choices[0];
    const next = current ? findDirectionalTarget(current, choices, key) : (initial && available(initial) ? initial : choices[0]);
    if (next) focus(next);
    event.preventDefault();
  });

  return {
    enterPlayer() {
      if (!active) return;
      playerOpener = document.activeElement;
      focus(player.querySelector('#close-player'));
    },
    exitPlayer() {
      if (!active) return;
      focus(playerOpener?.isConnected && available(playerOpener) ? playerOpener : null);
      playerOpener = null;
    },
  };
}
