/* ES3 only: ordinary links and forms also work without this script. */
(function () {
  var focused = null, media = null, lastSave = 0, resumed = false;
  function on(node, type, fn) {
    if (node.addEventListener) { node.addEventListener(type, fn, false); }
    else if (node.attachEvent) { node.attachEvent('on' + type, fn); }
    else { node['on' + type] = fn; }
  }
  function cancel(ev) { if (ev.preventDefault) { ev.preventDefault(); } ev.returnValue = false; return false; }
  function controls() {
    var result = [], tags = ['a', 'input', 'select', 'button', 'video', 'audio'], i, j, list, el;
    for (i = 0; i < tags.length; i++) {
      list = document.getElementsByTagName(tags[i]);
      for (j = 0; j < list.length; j++) {
        el = list[j];
        if (el.disabled || el.type === 'hidden' || !el.offsetWidth || !el.offsetHeight) { continue; }
        if (tags[i] === 'a' && !el.href) { continue; }
        result[result.length] = el;
      }
    }
    return result;
  }
  function rect(el) {
    var x = 0, y = 0, p = el;
    while (p) { x += p.offsetLeft || 0; y += p.offsetTop || 0; p = p.offsetParent; }
    return {x:x + el.offsetWidth / 2, y:y + el.offsetHeight / 2};
  }
  function focus(el) {
    if (!el) { return; }
    if (focused) { focused.className = String(focused.className || '').replace(/(^| )tv-focus( |$)/g, ' '); }
    focused = el;
    el.className = String(el.className || '') + ' tv-focus';
    try { el.focus(); } catch (ignore) {}
    try { if (el.scrollIntoView) { el.scrollIntoView(false); } } catch (ignore2) {}
  }
  function move(code) {
    var items = controls(), active = document.activeElement || focused, a, b, i, dx, dy, primary, secondary, score, best = null, distance = 1e20;
    if (!active || active === document.body || !active.offsetWidth) { focus(items[0]); return; }
    a = rect(active);
    for (i = 0; i < items.length; i++) {
      if (items[i] === active) { continue; }
      b = rect(items[i]); dx = b.x - a.x; dy = b.y - a.y;
      primary = code === 37 ? -dx : code === 39 ? dx : code === 38 ? -dy : dy;
      secondary = code === 37 || code === 39 ? Math.abs(dy) : Math.abs(dx);
      if (primary < 2) { continue; }
      score = primary + secondary * 3 + secondary * secondary / (primary + 1);
      if (score < distance) { best = items[i]; distance = score; }
    }
    focus(best);
  }
  function key(event) {
    var ev = event || window.event, code = ev.keyCode || ev.which, el = document.activeElement || focused, tag = el ? String(el.tagName).toLowerCase() : '', editing = tag === 'input' && (el.type === 'text' || el.type === 'password') || tag === 'select';
    if (code === 10009 || code === 461 || code === 27 || (code === 8 && !editing)) { if (editing) { try { el.blur(); } catch (ignore) {} focus(document.getElementById('nav') && document.getElementById('nav').getElementsByTagName('a')[0]); } else if (window.location.pathname !== '/tv') { window.history.back(); } return cancel(ev); }
    if (editing) { return true; }
    if (code >= 37 && code <= 40) { move(code); return cancel(ev); }
    if (code === 13 && el && tag !== 'video' && tag !== 'audio') { if (el.click) { el.click(); return cancel(ev); } if (tag === 'a') { window.location.href = el.href; return cancel(ev); } }
    if (media && (code === 415 || code === 19 || code === 10252)) { try { if (code === 19 || (code === 10252 && !media.paused)) { media.pause(); } else { media.play(); } } catch (ignore2) {} return cancel(ev); }
    if (media && (code === 412 || code === 417)) { try { media.currentTime = Math.max(0, media.currentTime + (code === 412 ? -10 : 10)); } catch (ignore3) {} return cancel(ev); }
    return true;
  }
  function save(force) {
    if (!media || !window.XMLHttpRequest || media.getAttribute('data-kind') === 'channel' || !isFinite(media.currentTime) || media.currentTime < 0) { return; }
    var now = new Date().getTime(), xhr;
    if (!force && now - lastSave < 30000) { return; }
    lastSave = now;
    try { xhr = new XMLHttpRequest(); xhr.open('POST', '/tv/action', true); xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); xhr.send('action=progress&id=' + encodeURIComponent(media.getAttribute('data-title')) + '&csrf=' + encodeURIComponent(media.getAttribute('data-csrf')) + '&seconds=' + encodeURIComponent(media.currentTime)); } catch (ignore) {}
  }
  function init() {
    var items = controls(), username = document.getElementById('username'), i;
    for (i = 0; i < items.length; i++) { on(items[i], 'focus', function (event) { var ev = event || window.event, el = ev.target || ev.srcElement; if (focused && focused !== el) { focused.className = String(focused.className || '').replace(/(^| )tv-focus( |$)/g, ' '); } focused = el; if (String(el.className).indexOf('tv-focus') === -1) { el.className += ' tv-focus'; } }); }
    on(document, 'keydown', key);
    media = document.getElementById('tv-player');
    if (media && typeof media.play === 'function') {
      on(media, 'loadedmetadata', function () { var resume = Number(media.getAttribute('data-resume')); if (!resumed && resume > 0) { resumed = true; try { media.currentTime = resume; } catch (ignore) {} } });
      on(media, 'timeupdate', function () { save(false); });
      on(media, 'pause', function () { save(true); });
      on(media, 'ended', function () { save(true); });
      on(media, 'error', function () { var note = document.getElementById('player-note'); if (note) { note.innerHTML = 'The television could not play this source. Try another connection or the direct media link.'; } });
    }
    if (username) { focus(username); } else { var main = document.getElementById('main'), links = main ? main.getElementsByTagName('a') : []; focus(links.length ? links[0] : items[0]); }
  }
  on(window, 'load', init);
}());
