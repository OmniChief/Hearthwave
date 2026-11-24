/* Classic script, limited to ECMAScript 3 syntax and optional legacy DOM APIs. */
(function () {
  var focusNode = null;
  var player = null;
  var savedAt = 0;
  var hasResumed = false;
  function bind(node, name, callback) {
    if (node.addEventListener) { node.addEventListener(name, callback, false); }
    else if (node.attachEvent) { node.attachEvent('on' + name, callback); }
    else { node['on' + name] = callback; }
  }
  function clearSelection() {
    if (focusNode) { focusNode.className = String(focusNode.className || '').replace(/(^|\s)remote-selected(?=\s|$)/g, ''); }
  }
  function mark(node) {
    clearSelection();
    focusNode = node;
    if (node) { node.className = String(node.className || '') + ' remote-selected'; }
  }
  function choose(node) {
    if (!node) { return; }
    mark(node);
    try { node.focus(); } catch (err) {}
    if (node.scrollIntoView) {
      try { node.scrollIntoView(false); } catch (err2) {}
    }
  }
  function visibleControls() {
    var list = [], nodes = document.getElementsByTagName('*'), i, node, tag;
    for (i = 0; i < nodes.length; i++) {
      node = nodes[i]; tag = String(node.tagName).toLowerCase();
      if (node.disabled || !node.offsetWidth || !node.offsetHeight) { continue; }
      if ((tag === 'a' && node.href) || (tag === 'input' && node.type !== 'hidden') || tag === 'select' || tag === 'button' || (tag === 'video' && node.play) || (tag === 'audio' && node.play)) { list[list.length] = node; }
    }
    return list;
  }
  function box(node) {
    if (node.getBoundingClientRect) {
      var r = node.getBoundingClientRect();
      return [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
    }
    var x = 0, y = 0, p = node;
    while (p) { x += p.offsetLeft || 0; y += p.offsetTop || 0; p = p.offsetParent; }
    return [x + node.offsetWidth / 2, y + node.offsetHeight / 2];
  }
  function direction(key) {
    var items = visibleControls(), start = focusNode, from, to, i, major, minor, cost, best = null, score = 1000000000, horizontal = key === 37 || key === 39, sign = key === 37 || key === 38 ? -1 : 1;
    if (!start || !start.offsetWidth) { choose(items[0]); return; }
    from = box(start);
    for (i = 0; i < items.length; i++) {
      if (items[i] === start) { continue; }
      to = box(items[i]);
      major = (to[horizontal ? 0 : 1] - from[horizontal ? 0 : 1]) * sign;
      minor = Math.abs(to[horizontal ? 1 : 0] - from[horizontal ? 1 : 0]);
      if (major <= 1) { continue; }
      cost = major + minor * 4 + minor * minor / major;
      if (cost < score) { score = cost; best = items[i]; }
    }
    if (best) { choose(best); }
  }
  function stop(event) {
    if (event.preventDefault) { event.preventDefault(); }
    event.returnValue = false;
    return false;
  }
  function storePosition(force) {
    if (!player || !window.XMLHttpRequest) { return; }
    var kind = player.getAttribute('data-kind'), position = player.currentTime, now = new Date().getTime(), xhr;
    if ((kind !== 'film' && kind !== 'episode' && kind !== 'music') || typeof position !== 'number' || !isFinite(position) || position < 0 || !hasResumed) { return; }
    if (!force && now - savedAt < 30000) { return; }
    savedAt = now;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', '/tv/submit', true);
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.send('op=position&id=' + encodeURIComponent(player.getAttribute('data-item')) + '&csrf=' + encodeURIComponent(player.getAttribute('data-token')) + '&seconds=' + encodeURIComponent(position));
    } catch (err) {}
  }
  function returnToPrevious() {
    var stage = document.getElementById('stage'), links = stage ? stage.getElementsByTagName('a') : [], i;
    for (i = 0; i < links.length; i++) {
      if (/(^|\s)return-target(\s|$)/.test(String(links[i].className || ''))) { window.location.href = links[i].href; return; }
    }
    if (window.location.search || window.location.pathname !== '/tv') { window.location.href = '/tv'; }
  }
  function resumeMedia() {
    if (hasResumed || !player) { return; }
    var offset = Number(player.getAttribute('data-offset'));
    if (offset > 0) { try { player.currentTime = offset; } catch (err) {} }
    hasResumed = true;
  }
  function keydown(event) {
    var ev = event || window.event, code = ev.keyCode || ev.which, node = focusNode, tag = node ? String(node.tagName).toLowerCase() : '', typing = tag === 'input' && (node.type === 'text' || node.type === 'password'), choosing = tag === 'select';
    if (code === 27 || code === 461 || code === 10009 || (code === 8 && !typing && !choosing)) {
      if (typing || choosing) {
        try { node.blur(); } catch (err) {}
        var rail = document.getElementById('rail');
        if (rail) { choose(rail.getElementsByTagName('a')[0]); }
        else { var all = visibleControls(); choose(all[0]); }
      } else {
        storePosition(true);
        returnToPrevious();
      }
      return stop(ev);
    }
    if (typing || choosing) { return true; }
    if (code >= 37 && code <= 40) { direction(code); return stop(ev); }
    if (code === 13 && node && tag === 'a') { window.location.href = node.href; return stop(ev); }
    if (code === 13 && node && tag === 'input' && node.type === 'submit' && node.click) { node.click(); return stop(ev); }
    if (player && player.play && (code === 415 || code === 19 || code === 10252)) {
      try { if (code === 19 || (code === 10252 && !player.paused)) { player.pause(); } else { player.play(); } } catch (err2) {}
      return stop(ev);
    }
    if (player && (code === 412 || code === 417)) {
      try { player.currentTime = Math.max(0, player.currentTime + (code === 412 ? -10 : 10)); } catch (err3) {}
      return stop(ev);
    }
    return true;
  }
  function init() {
    var items = visibleControls(), i, initial = document.getElementById('account'), stage = document.getElementById('stage'), rail = document.getElementById('rail'), links;
    for (i = 0; i < items.length; i++) {
      bind(items[i], 'focus', function (event) { var ev = event || window.event; mark(ev.target || ev.srcElement); });
    }
    bind(document, 'keydown', keydown);
    player = document.getElementById('media');
    if (player && player.play) {
      bind(player, 'loadedmetadata', resumeMedia);
      if (player.readyState > 0) { resumeMedia(); }
      bind(player, 'timeupdate', function () { storePosition(false); });
      bind(player, 'pause', function () { storePosition(true); });
      bind(player, 'ended', function () { storePosition(true); });
      bind(player, 'error', function () {
        var message = document.getElementById('media-message');
        if (message) { message.innerHTML = 'This television cannot play this source. Use another version or open the stream directly.'; }
      });
    }
    if (!initial && stage) {
      links = stage.getElementsByTagName('a');
      if (links.length) { initial = links[0]; }
    }
    if (!initial && rail) {
      links = rail.getElementsByTagName('a');
      for (i = 0; i < links.length; i++) { if (String(links[i].className).indexOf('active') !== -1) { initial = links[i]; break; } }
    }
    choose(initial || items[0]);
  }
  bind(window, 'load', init);
}());
