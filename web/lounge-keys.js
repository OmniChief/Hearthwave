/* Classic script, limited to ECMAScript 3 syntax and optional legacy DOM APIs. */
(function () {
  var focusNode = null;
  var player = null;
  var savedAt = 0;
  var hasResumed = false;
  var autoNextStarted = false;
  var roomTimer = null, roomBusy = false, roomStopped = false;
  var backInFlight = false;
  var backDown = false;
  var oldSamsung = /maple|orsay|samsung.*smart-tv/i.test(navigator.userAgent || '') && !/tizen/i.test(navigator.userAgent || '');
  function bind(node, name, callback, capture) {
    if (node.addEventListener) { node.addEventListener(name, callback, !!capture); }
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
      if ((tag === 'a' && node.href) || (tag === 'input' && node.type !== 'hidden') || tag === 'select' || tag === 'textarea' || tag === 'button' || (tag === 'video' && node.play) || (tag === 'audio' && node.play)) { list[list.length] = node; }
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
    event.cancelBubble = true;
    if (event.stopPropagation) { event.stopPropagation(); }
    if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
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
    if (backInFlight) { return; }
    var destination = document.getElementById('lounge-back'), links, i;
    if (!destination) {
      links = document.getElementsByTagName('a');
      for (i = 0; i < links.length; i++) {
        if (/(^|\s)return-target(\s|$)/.test(String(links[i].className || ''))) { destination = links[i]; break; }
      }
    }
    // At the root, consume Return rather than asking browser history to exit.
    if (!destination || !destination.href) { return; }
    backInFlight = true;
    storePosition(true);
    stopRoom();
    window.location.replace(destination.href);
  }
  function currentControl() {
    var node = document.activeElement;
    if (node && node !== document.body && node !== document.documentElement) { return node; }
    return focusNode;
  }
  function editControl(node) {
    var tag = node ? String(node.tagName).toLowerCase() : '';
    return tag === 'select' || (tag === 'input' && (node.type === 'text' || node.type === 'password')) || tag === 'textarea';
  }
  function isBack(ev) {
    var code = ev.keyCode || ev.which, name = String(ev.key || ev.keyIdentifier || '').toLowerCase(), editing = editControl(currentControl());
    return code === 10009 || code === 461 || code === 166 || (oldSamsung && code === 88 && !editing) || code === 27 || (code === 8 && !editing) || name === 'browserback' || name === 'goback' || name === 'xf86back' || name === 'back' || name === 'escape';
  }
  function handleBack(ev) {
    if (!isBack(ev)) { return true; }
    stop(ev);
    if (backDown || backInFlight) { return false; }
    backDown = true;
    var node = currentControl();
    if (editControl(node)) {
      try { node.blur(); } catch (err) {}
      var button = document.getElementById('lounge-back'), rail = document.getElementById('rail');
      if (button) { choose(button); }
      else if (rail) { choose(rail.getElementsByTagName('a')[0]); }
      else { focusNode = null; clearSelection(); }
    } else { returnToPrevious(); }
    return false;
  }
  function releaseBack(event) {
    var ev = event || window.event;
    if (isBack(ev)) { backDown = false; return stop(ev); }
    return true;
  }
  function resumeMedia() {
    if (hasResumed || !player) { return; }
    var offset = Number(player.getAttribute('data-offset'));
    if (offset > 0) { try { player.currentTime = offset; } catch (err) {} }
    hasResumed = true;
  }
  function stopRoom() {
    roomStopped = true;
    if (roomTimer !== null) { window.clearInterval(roomTimer); roomTimer = null; }
  }
  function roomTick() {
    if (roomStopped || roomBusy || !player || !window.XMLHttpRequest || !hasResumed) { return; }
    var room = player.getAttribute('data-room'), host = player.getAttribute('data-host') === 'yes', xhr, position;
    if (!room) { return; }
    position = player.currentTime;
    if (host && (typeof position !== 'number' || !isFinite(position) || position < 0)) { return; }
    roomBusy = true;
    try {
      xhr = new XMLHttpRequest();
      xhr.open(host ? 'POST' : 'GET', host ? '/tv/submit' : '/tv/room-state?id=' + encodeURIComponent(room), true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        roomBusy = false;
        if (roomStopped) { return; }
        if (xhr.status === 403 || xhr.status === 404) {
          stopRoom();
          var message = document.getElementById('media-message');
          if (message) { message.innerHTML = 'Watch room unavailable. Return to the room page.'; }
          return;
        }
        if (host || xhr.status !== 200) { return; }
        var state = String(xhr.responseText || '').split('|'), target = Number(state[0]), playing = state[1] === '1' && state[2] === '1';
        if (state.length !== 3 || !isFinite(target) || target < 0) { return; }
        try {
          if (Math.abs(player.currentTime - target) > 3) { player.currentTime = target; }
          if (playing && player.paused) { player.play(); }
          if (!playing && !player.paused) { player.pause(); }
        } catch (err) {}
      };
      if (host) {
        xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
        xhr.send('op=room-sync&csrf='+encodeURIComponent(player.getAttribute('data-token'))+'&room='+encodeURIComponent(room)+'&seconds='+encodeURIComponent(position)+'&playing='+(player.paused?'0':'1'));
      } else { xhr.send(null); }
    } catch (err) { roomBusy = false; }
  }
  function submitClass(name) {
    var forms = document.getElementsByTagName('form'), i;
    for (i = 0; i < forms.length; i++) {
      if ((' ' + forms[i].className + ' ').indexOf(' ' + name + ' ') >= 0) {
        storePosition(true);
        try { forms[i].submit(); return true; } catch (err) { return false; }
      }
    }
    return false;
  }
  function toggleMedia() {
    if (!player || !player.play || (player.getAttribute('data-room') && player.getAttribute('data-host') !== 'yes')) { return; }
    try { if (player.paused) { player.play(); } else { player.pause(); } } catch (err) {}
  }
  function fullMedia() {
    if (!player) { return; }
    var fn = player.requestFullscreen || player.webkitRequestFullscreen || player.webkitEnterFullscreen || player.mozRequestFullScreen || player.msRequestFullscreen;
    try { if (fn) { fn.call(player); } } catch (err) {}
  }
  function keydown(event) {
    var ev = event || window.event, code = ev.keyCode || ev.which, node = currentControl(), tag = node ? String(node.tagName).toLowerCase() : '', typing = tag === 'input' && (node.type === 'text' || node.type === 'password'), choosing = tag === 'select';
    if (tag === 'textarea') { typing = true; }
    if (isBack(ev)) { return handleBack(ev); }
    if (oldSamsung) {
      if (code === 29460) { code = 38; }
      else if (code === 29461) { code = 40; }
      else if (code === 4) { code = 37; }
      else if (code === 5) { code = 39; }
      else if (code === 29443) { code = 13; }
    }
    if (typing || choosing) { return true; }
    if (code >= 37 && code <= 40) { direction(code); return stop(ev); }
    if (code === 13 && node && tag === 'a') { window.location.href = node.href; return stop(ev); }
    if (code === 13 && node && tag === 'input' && (node.type === 'submit' || node.type === 'button') && node.click) { node.click(); return stop(ev); }
    if (player && (code === 427 || code === 428 || code === 33 || code === 34)) {
      if (submitClass(code === 427 || code === 33 ? 'nextchannel' : 'prevchannel')) { return stop(ev); }
    }
    if (player && player.play && (code === 415 || code === 19 || code === 10252)) {
      if (player.getAttribute('data-room') && player.getAttribute('data-host') !== 'yes') { return stop(ev); }
      try { if (code === 19 || (code === 10252 && !player.paused)) { player.pause(); } else { player.play(); } } catch (err2) {}
      return stop(ev);
    }
    if (player && (code === 412 || code === 417)) {
      if (player.getAttribute('data-room') && player.getAttribute('data-host') !== 'yes') { return stop(ev); }
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
    player = document.getElementById('media');
    if (player && player.play) {
      bind(player, 'loadedmetadata', resumeMedia);
      if (player.readyState > 0) { resumeMedia(); }
      if (player.getAttribute('data-room') && window.XMLHttpRequest) {
        roomTimer = window.setInterval(roomTick, 3000);
        bind(window, 'unload', stopRoom);
        if (player.getAttribute('data-host') === 'yes') { bind(player, 'play', roomTick); bind(player, 'pause', roomTick); bind(player, 'seeked', roomTick); }
      }
      bind(player, 'timeupdate', function () { storePosition(false); });
      bind(player, 'pause', function () { storePosition(true); });
      bind(player, 'ended', function () {
        storePosition(true);
        var note = document.getElementById('media-message');
        if (!autoNextStarted && note && note.getAttribute('data-autonext') === 'yes') { autoNextStarted = true; submitClass('nextform'); }
      });
      var toggle = document.getElementById('media-toggle'), full = document.getElementById('media-full');
      if (toggle) { if (player.getAttribute('data-room') && player.getAttribute('data-host') !== 'yes') { toggle.style.display = 'none'; } else { bind(toggle, 'click', toggleMedia); } }
      if (full) { if (player.requestFullscreen || player.webkitRequestFullscreen || player.webkitEnterFullscreen || player.mozRequestFullScreen || player.msRequestFullscreen) { bind(full, 'click', fullMedia); } else { full.style.display = 'none'; } }
      bind(player, 'error', function () {
        var message = document.getElementById('media-message');
        if (message) { message.innerHTML = 'This television cannot play this source. Use Try next source or choose another version.'; }
      });
    }
    if (player && player.play && !initial) { initial = document.getElementById('media-toggle'); }
    var anchor = String(window.location.hash || '').slice(1);
    if (/^lounge-(focus|item)-[0-9-]+$/.test(anchor)) {
      var previous = document.getElementById(anchor);
      if (previous) { initial = previous; }
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
  // Capture Return before the browser's own Back/Exit handler where supported.
  var keyTarget = window.addEventListener ? window : document;
  bind(keyTarget, 'keydown', keydown, true);
  bind(keyTarget, 'keypress', function (event) { var ev = event || window.event; if (isBack(ev)) { return handleBack(ev); } return true; }, true);
  bind(keyTarget, 'keyup', releaseBack, true);
  bind(window, 'blur', function () { backDown = false; });
  bind(window, 'load', init);
}());
