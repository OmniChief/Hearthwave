(async () => {
  const status = document.getElementById('status');
  try {
    const id = new URLSearchParams(location.search).get('id');
    if (!/^\d+$/.test(id || '')) throw new Error('Select a game in Play.');
    const response = await fetch('/api/games/' + id);
    const game = await response.json();
    if (!response.ok || !game.core) throw new Error(game.error || 'No emulator is available for this system.');
    document.title = game.filename + ' · Hearthwave Play';
    window.EJS_player = '#game';
    window.EJS_core = game.core;
    window.EJS_gameName = game.filename.replace(/\.[^.]+$/, '');
    window.EJS_gameUrl = game.url;
    window.EJS_externalFiles = game.tracks;
    window.EJS_threads = false;
    window.EJS_startOnLoaded = true;
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/4.2.3/data/';
    const loader = document.createElement('script');
    loader.src = window.EJS_pathtodata + 'loader.js';
    loader.onerror = () => { status.textContent = 'Could not load EmulatorJS from its CDN.'; };
    document.body.append(loader);
  } catch (error) { status.textContent = error.message; }
})();
