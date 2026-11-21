const state = { session: null, page: 'home', settingsTab: 'sources', kind: 'all', liveGroup: 'all', query: '', items: [], stats: null, sources: [], activeTitle: null, variants: [], variantIndex: 0, playerTitle: null, lastProgressSave: 0 };
const $ = (selector) => document.querySelector(selector);
const page = $('#page');

function esc(input) {
  return String(input ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(state.session?.csrf ? { 'X-CSRF-Token':state.session.csrf } : {}) };
  let response;
  try { response = await fetch(path, { method: options.method || 'GET', credentials:'same-origin', headers, body: options.body ? JSON.stringify(options.body) : undefined }); }
  catch { throw new Error('Cannot reach your home server. Check the connection and try again.'); }
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('The server returned an unexpected response.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function notify(message, error = false) {
  const target = $('#notice');
  target.hidden = false;
  target.textContent = message;
  target.style.background = error ? '#3c2730' : '#24403d';
  target.style.borderColor = error ? '#684452' : '#356359';
  target.style.color = error ? '#ffd1d0' : '#c2f2e4';
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { target.hidden = true; }, 6500);
}

function showAuth(needsSetup) {
  $('#auth').hidden = false;
  $('#shell').hidden = true;
  $('#auth-title').textContent = needsSetup ? 'Make yourself at home.' : 'Welcome back.';
  $('#auth-description').textContent = needsSetup ? 'Create the first administrator. Your server, your rules.' : 'Everything you love, one place to enjoy it.';
  $('#auth-submit').textContent = needsSetup ? 'Create administrator' : 'Sign in';
  $('#auth-form').dataset.mode = needsSetup ? 'setup' : 'login';
  $('#auth-error').textContent = '';
  $('#auth-form').querySelector('[name=password]').autocomplete = needsSetup ? 'new-password' : 'current-password';
}

function showShell() {
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  $('#current-user').textContent = state.session.user.username;
  $('#current-role').textContent = state.session.user.role;
  $('#avatar').textContent = state.session.user.username.charAt(0).toUpperCase();
  document.querySelectorAll('[data-page="settings"]').forEach(button => { button.hidden = state.session.user.role !== 'admin'; });
  navigate('home');
}

const headings = { home:'Home', library:'Library', live:'Live', play:'Play', create:'Create', community:'Community', 'my-space':'My Space', settings:'Settings' };
async function navigate(destination) {
  if (destination === 'settings' && state.session?.user.role !== 'admin') return;
  state.page = headings[destination] ? destination : 'home';
  $('#page-title').textContent = headings[state.page];
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('selected', el.dataset.page === state.page));
  $('#global-search').placeholder = state.page === 'live' ? 'Search live channels' : 'Search your entertainment';
  if (state.page !== 'library' && state.page !== 'live') { state.query = ''; $('#global-search').value = ''; }
  window.scrollTo({ top:0, behavior:'instant' });
  try { await renderPage(); } catch (error) { page.innerHTML = emptyState('Something went wrong', error.message, '⚠'); }
}

function emptyState(title, description, icon = '◌') {
  return `<div class="empty"><div class="empty-icon">${esc(icon)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}

function heading(title, subtitle = '', action = '') {
  return `<div class="section-heading"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>`:''}</div>${action}</div>`;
}

function mediaCard(item) {
  const initial = Array.from(item.title || '?')[0].toUpperCase();
  const tone = Number(item.id) % 4;
  const detail = [item.year, item.kind === 'episode' ? `S${item.season || '?'}E${item.episode || '?'}` : null, `${item.source_count} source${item.source_count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return `<article class="media-card"><div class="media-art tone-${tone}"><span class="art-initial">${esc(initial)}</span><span class="media-kind">${esc(item.kind)}</span></div><div class="media-info"><strong title="${esc(item.title)}">${esc(item.title)}</strong><small>${esc(detail)}</small><div class="media-actions"><button class="button button-quiet button-small" data-play="${item.id}">Play</button><button class="star-button ${item.favourite ? 'is-favourite':''}" data-favourite="${item.id}" data-next="${item.favourite ? '0':'1'}" aria-label="${item.favourite ? 'Remove from' : 'Add to'} favourites">${item.favourite ? '★':'☆'}</button></div></div></article>`;
}

function liveCard(item) {
  return `<button class="channel-row" data-play="${item.id}"><span class="channel-icon">▻</span><span><strong>${esc(item.title)}</strong><small>${esc(item.group_name || 'Live channel')} · ${item.source_count} source${item.source_count === 1 ? '' : 's'}</small></span></button>`;
}

async function renderHome() {
  const [stats, library, live] = await Promise.all([api('/api/stats'), api('/api/catalogue?kind=library'), api('/api/catalogue?kind=channel')]);
  state.stats = stats;
  state.items = [...library.items, ...live.items];
  const recent = library.items.filter(item => item.kind !== 'channel').slice(0, 6);
  page.innerHTML = `<section class="hero"><div><span class="eyebrow">WELCOME TO HEARTHWAVE</span><h2>All your entertainment.<br>One happy place.</h2><p>Movies, music and live television belong together. Your own server, your sources and your choices.</p><button class="button button-primary" data-page="library">Explore your library <span>↗</span></button></div><div class="hero-art"><div class="hero-disc"></div></div></section>
    <div class="stat-grid"><div class="stat"><small>Library titles</small><strong>${stats.items}</strong><span>Grouped across sources</span></div><div class="stat"><small>Live channels</small><strong>${stats.channels}</strong><span>One shared lineup</span></div><div class="stat"><small>Configured sources</small><strong>${stats.sources}</strong><span>Managed in Settings</span></div></div>
    ${heading('Your library', 'Pick up something good.', `<button class="link-button" data-page="library">View library →</button>`)}
    ${recent.length ? `<div class="cards">${recent.map(mediaCard).join('')}</div>` : emptyState('Your library starts here', 'Add a media folder in Settings, then scan it to discover films, episodes, music and photos.', '▣')}
    ${heading('Live channels', 'Any source. One familiar lineup.', `<button class="link-button" data-page="live">Watch live →</button>`)}
    ${live.items.length ? `<div class="live-list">${live.items.slice(0, 6).map(liveCard).join('')}</div>` : emptyState('No channels yet', 'Add a direct channel or import an M3U playlist in Settings > Sources.', '▻')}`;
}

async function renderLibrary() {
  const types = [{key:'all',name:'All media'}, {key:'film',name:'Films'}, {key:'episode',name:'Series episodes'}, {key:'music',name:'Music'}, {key:'photo',name:'Photos'}];
  const result = await api(`/api/catalogue?kind=${encodeURIComponent(state.kind === 'all' ? 'library' : state.kind)}&q=${encodeURIComponent(state.query)}`);
  state.items = result.items;
  const items = result.items.filter(item => item.kind !== 'channel');
  page.innerHTML = `<div class="preview-banner">Local library scanning is ready. Remote VOD adapters, metadata enrichment, subtitles and downloads will be added in the next milestone.</div>
    <div class="toolbar">${types.map(type => `<button class="pill ${state.kind === type.key ? 'active':''}" data-kind="${type.key}">${type.name}</button>`).join('')}</div>
    ${heading(state.kind === 'all' ? 'Your collection' : types.find(t => t.key === state.kind).name, `${items.length} item${items.length===1?'':'s'} in this view`)}
    ${items.length ? `<div class="cards">${items.map(mediaCard).join('')}</div>` : emptyState('No matching media', 'Try another filter, or add a folder in Settings > Sources.', '▣')}
    ${result.items.length >= result.maxResults ? `<p class="field-note">Showing the first ${result.maxResults} results. Use search to narrow the list.</p>` : ''}`;
}

async function renderLive() {
  const result = await api(`/api/catalogue?kind=channel&q=${encodeURIComponent(state.query)}`);
  state.items = result.items;
  const groups = [...new Set(result.items.map(item => item.group_name).filter(Boolean))].sort((a,b) => a.localeCompare(b));
  const selected = state.liveGroup === 'all' ? result.items : result.items.filter(item => item.group_name === state.liveGroup);
  page.innerHTML = `<div class="preview-banner">All live channels share this lineup, regardless of how they were added. Full XMLTV EPG, Stalker and Xtream adapters are planned next.</div>
    <div class="toolbar"><button class="pill ${state.liveGroup === 'all' ? 'active':''}" data-group="all">All channels</button>${groups.map(group => `<button class="pill ${state.liveGroup === group ? 'active':''}" data-group="${esc(group)}">${esc(group)}</button>`).join('')}</div>
    ${heading('Your live lineup', `${selected.length} channel${selected.length===1?'':'s'} · ${groups.length} categor${groups.length===1?'y':'ies'}`)}
    ${selected.length ? `<div class="live-list">${selected.map(liveCard).join('')}</div>` : emptyState('No channels to show', 'Import an M3U playlist or create a direct channel in Settings > Sources.', '▻')}`;
}

const upcoming = {
  play:{ title:'A new way to play', description:'Your games, arcade and social challenges will live together here.',icon:'◈', features:[['Game library','Browse owned games and ROMs with covers, favourites and save states.'],['Retro arcade','Play in your browser with controller support.'],['Play together','Quizzes, chess, rooms, achievements and leaderboards.']] },
  create:{ title:'Make something wonderful', description:'Creative projects will be managed here while optional PC workers do the heavy lifting.',icon:'✳',features:[['Image studio','Queue text-to-image jobs and organise generated assets.'],['Video workspace','Optional video generation and project history.'],['Worker pairing','Attach a capable PC for conversion and GPU work.']] },
  community:{ title:'Good things are better shared',description:'Profiles, friends and togetherness without giving up ownership.',icon:'♧',features:[['Friends and profiles','Private social identities, lists and reviews.'],['Watch together','Synchronized viewing and chat rooms.'],['Teams and achievements','Game rankings and shared milestones.']] },
  'my-space':{ title:'Your corner of the world',description:'Everyday tools, plans and files in your own space.',icon:'☷',features:[['Personal calendar','Reminders, releases and shared planning.'],['File exchange','Permission-controlled sharing and resumable uploads.'],['Your dashboard','Photos, notifications, ambient displays and webcams.']] },
};

function renderUpcoming(section) {
  const info = upcoming[section];
  page.innerHTML = `<section class="hero"><div><span class="eyebrow">COMING IN A FUTURE MILESTONE</span><h2>${esc(info.title)}</h2><p>${esc(info.description)}</p><span class="tag">Product foundation in progress</span></div><div class="hero-art"><div class="hero-disc"></div></div></section>
    ${heading('What belongs here', 'Designed as part of one platform, with shared accounts and permissions.')}
    <div class="feature-grid">${info.features.map(feature => `<div class="feature-card"><div class="feature-glyph">${info.icon}</div><h3>${esc(feature[0])}</h3><p>${esc(feature[1])}</p></div>`).join('')}</div>`;
}

const settingsSections = [ ['sources','Sources'],['metadata','Metadata & Guide'],['users','Users & Access'],['workers','Downloads & Workers'],['appearance','Appearance & Playback'],['system','System'] ];

async function renderSettings() {
  if (state.settingsTab === 'sources') state.sources = (await api('/api/sources')).sources;
  let contents = '';
  if (state.settingsTab === 'sources') {
    contents = `<div class="info-banner">Provider types are configured here, never as separate browsing areas. In this foundation build, local folder scans, direct channels and pasted M3U imports work; Xtream/Stalker adapters are registered for later implementation.</div>
      <div class="two-col"><section class="surface"><h2>Add a source</h2><p class="field-note">The source provides content. Viewers see it in Library or Live.</p><form class="field-stack" id="source-form">
      <label>Source name<input name="name" required maxlength="100" placeholder="e.g. Living room NAS"></label>
      <label>Source type<select name="type" id="source-type"><option value="folder">Local media folder</option><option value="m3u">M3U playlist</option><option value="direct">Direct live channel</option><option value="xtream">Xtream (adapter planned)</option><option value="stalker">Stalker portal (adapter planned)</option></select></label>
      <label id="source-location-label">Absolute folder path<input name="location" id="source-location" maxlength="2048" placeholder="/volume1/media" required></label>
      <p class="field-note" id="source-note">A scan is manual, resumable by re-running it, and uses small indexing batches.</p>
      <button type="submit" class="button button-primary">Add source</button></form></section>
      <section class="surface"><h2>Configured sources</h2><p class="field-note">Imports are triggered here, with their current status shown beside each source.</p>
      ${state.sources.length ? state.sources.map(source => `<div class="list-row"><div><strong>${esc(source.name)}</strong> <span class="tag">${esc(source.type)}</span><small>${esc(source.location || 'No location specified')} · ${esc(source.status)}${source.last_error ? ` · ${esc(source.last_error)}` : ''}</small></div><div class="row-actions">${source.type === 'folder' ? `<button class="button button-quiet button-small" data-scan="${source.id}">Scan</button>`:''}${source.type === 'm3u' ? `<button class="button button-quiet button-small" data-import="${source.id}">Import M3U</button>`:''}<button class="button button-danger button-small" data-remove="${source.id}">Remove</button></div></div>`).join('') : '<p class="field-note">No sources configured yet.</p>'}
      <button class="button button-quiet button-small" id="refresh-sources">Refresh status</button></section></div>
      <section class="surface" id="m3u-import-panel" hidden><h2>Import M3U playlist</h2><p class="field-note">Paste an authorised playlist. Stream entries are indexed progressively; the server does not proxy or transcode them.</p><form class="field-stack" id="m3u-form"><input type="hidden" name="sourceId"><label>M3U text<textarea name="playlist" spellcheck="false" required placeholder="#EXTM3U\n#EXTINF:-1 tvg-id=..."></textarea></label><button class="button button-primary" type="submit">Import playlist</button></form></section>`;
  } else if (state.settingsTab === 'users') {
    const users = (await api('/api/users')).users;
    contents = `<div class="two-col"><section class="surface"><h2>Household accounts</h2><p class="field-note">Each account has its own favourites and playback positions, saved on this server.</p>${users.map(user => `<div class="list-row"><strong>${esc(user.username)}</strong><span class="tag">${esc(user.role)}</span></div>`).join('')}</section>
      <section class="surface"><h2>Add a viewer</h2><form id="user-form" class="field-stack"><label>Username<input name="username" minlength="3" maxlength="50" required></label><label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><label>Role<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="button button-primary" type="submit">Create account</button></form></section></div>`;
  } else {
    const explanations = {
      metadata:['Metadata & Guide','Artwork services, subtitles, XMLTV feeds, EPG mappings and quality-aware channel matching are scheduled for core media and Live milestones.'],
      workers:['Downloads & Workers','Acquisition queues, explicit file conversion and trusted paired worker computers will be managed here, without mandatory on-NAS transcoding.'],
      appearance:['Appearance & Playback','User themes, TV remote layouts, compatibility mode, quality preferences and subtitle defaults will be configured here.'],
      system:['System','Updater, backups, runtime budgets, resource metrics, diagnostics and migration rollback controls belong here.'],
    };
    const [title,description] = explanations[state.settingsTab];
    contents = emptyState(title, `${description} This settings area is not active in the foundation milestone.`, '⚙');
  }
  page.innerHTML = `<div class="settings-layout"><div class="settings-menu">${settingsSections.map(section => `<button class="${state.settingsTab === section[0] ? 'active':''}" data-settings="${section[0]}">${section[1]}</button>`).join('')}</div><div class="settings-content">${contents}</div></div>`;
  if (state.settingsTab === 'sources') syncSourceForm();
}

function syncSourceForm() {
  const type = $('#source-type')?.value;
  const label = $('#source-location-label');
  const input = $('#source-location');
  if (!input || !label) return;
  label.hidden = !['folder','direct','m3u'].includes(type);
  input.required = type === 'folder' || type === 'direct';
  if (type === 'folder') { label.firstChild.textContent = 'Absolute folder path'; input.placeholder = '/volume1/media'; }
  if (type === 'm3u') { label.firstChild.textContent = 'Playlist URL (optional reference)'; input.placeholder = 'https://example.com/channels.m3u'; }
  if (type === 'direct') { label.firstChild.textContent = 'Direct stream URL'; input.placeholder = 'https://example.com/live.m3u8'; }
  $('#source-note').textContent = type === 'm3u' ? 'After adding this source, use Import M3U to paste the playlist contents.' : ['stalker','xtream'].includes(type) ? 'Connection details are reserved for the provider adapter milestone; no fetching will happen yet.' : type === 'direct' ? 'The channel appears in Live immediately. Your browser must support its stream format.' : 'Scan runs in bounded batches and updates the Library as items are discovered.';
}

async function renderPage() {
  switch (state.page) {
    case 'home': return renderHome();
    case 'library': return renderLibrary();
    case 'live': return renderLive();
    case 'settings': return renderSettings();
    default: return renderUpcoming(state.page);
  }
}

async function startPlayback(titleId) {
  const result = await api(`/api/titles/${titleId}/variants`);
  if (!result.variants.length) throw new Error('There is no available source for this title.');
  const title = (state.items.find(item => Number(item.id) === Number(titleId)) || (await api('/api/catalogue?kind=all')).items.find(item => Number(item.id) === Number(titleId)) || { title:'Your media', id:titleId });
  state.activeTitle = title;
  state.variants = result.variants;
  state.variantIndex = 0;
  state.pendingSeek = Number(title.position_seconds) || 0;
  $('#player-title').textContent = title.title;
  $('#player-overlay').hidden = false;
  playVariant();
}

function playVariant() {
  const item = state.variants[state.variantIndex];
  const video = $('#player');
  $('#player-message').textContent = '';
  $('#player-source').textContent = `${item.name}${item.quality ? ` · ${item.quality}` : ''} (${state.variantIndex + 1}/${state.variants.length})`;
  $('#try-next').disabled = state.variants.length < 2;
  video.pause();
  video.src = item.url;
  video.load();
  video.play().catch(() => { $('#player-message').textContent = 'Press Play to start this stream.'; });
}

function nextSource() {
  if (state.variantIndex + 1 >= state.variants.length) {
    $('#player-message').textContent = 'None of the available sources could play in this browser. Try a different device or a supported format.';
    return;
  }
  state.pendingSeek = $('#player').currentTime || state.pendingSeek;
  state.variantIndex += 1;
  playVariant();
}

function closePlayer() {
  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#player-overlay').hidden = true;
  state.activeTitle = null;
  state.variants = [];
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    state.session = await api(`/api/${form.dataset.mode}`, { method:'POST', body:{ username:data.get('username'), password:data.get('password') } });
    form.reset();
    showShell();
  } catch (error) { $('#auth-error').textContent = error.message; }
});

$('#sign-out').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } catch { /* Expired sessions may already be gone. */ }
  state.session = null;
  showAuth(false);
});

$('#global-search').addEventListener('input', (event) => {
  state.query = event.target.value;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    if (!['live','library'].includes(state.page)) navigate('library');
    else renderPage().catch(error => notify(error.message,true));
  }, 250);
});

page.addEventListener('change', event => { if (event.target?.id === 'source-type') syncSourceForm(); });

page.addEventListener('submit', async event => {
  const form = event.target;
  if (!['source-form','m3u-form','user-form'].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.id === 'source-form') {
      await api('/api/sources', { method:'POST', body:{ name:data.get('name'), type:data.get('type'), location:data.get('location') || '' } });
      notify('Source added. You can scan or import it now.');
    } else if (form.id === 'm3u-form') {
      const result = await api(`/api/sources/${data.get('sourceId')}/import`, { method:'POST', body:{ playlist:data.get('playlist') } });
      notify(`Accepted ${result.accepted} streams. The catalogue is being updated.`);
    } else {
      await api('/api/users', { method:'POST', body:{ username:data.get('username'), password:data.get('password'), role:data.get('role') } });
      notify('Household account created.');
    }
    await renderPage();
  } catch (error) { notify(error.message,true); }
});

page.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.page) return navigate(target.dataset.page);
  if (target.dataset.kind) { state.kind = target.dataset.kind; return renderPage(); }
  if (target.dataset.group) { state.liveGroup = target.dataset.group; return renderPage(); }
  if (target.dataset.settings) { state.settingsTab = target.dataset.settings; return renderPage(); }
  if (target.dataset.play) {
    try { await startPlayback(target.dataset.play); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.favourite) {
    try {
      await api(`/api/titles/${target.dataset.favourite}/favourite`, { method:'POST', body:{ favourite:target.dataset.next === '1' } });
      await renderPage();
    } catch (error) { notify(error.message,true); }
  }
  if (target.dataset.scan) {
    try { await api(`/api/sources/${target.dataset.scan}/scan`, { method:'POST' }); notify('Folder scan started. New items appear as batches finish.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.import) {
    $('#m3u-import-panel').hidden = false;
    $('#m3u-form [name=sourceId]').value = target.dataset.import;
    $('#m3u-import-panel').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  if (target.dataset.remove) {
    if (!window.confirm('Remove this source and all its indexed variants?')) return;
    try { await api(`/api/sources/${target.dataset.remove}`, { method:'DELETE' }); notify('Source removed.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
  }
  if (target.id === 'refresh-sources') return renderPage();
});

document.querySelectorAll('.sidebar [data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
$('#brand-link').addEventListener('click', event => { event.preventDefault(); navigate('home'); });
$('#close-player').addEventListener('click', closePlayer);
$('#try-next').addEventListener('click', nextSource);
$('#open-stream').addEventListener('click', () => {
  const variant = state.variants[state.variantIndex];
  if (variant?.url && /^https?:\/\//i.test(variant.url)) window.open(variant.url, '_blank', 'noopener,noreferrer');
  else notify('The local stream is available only inside Hearthwave.');
});
$('#player').addEventListener('error', () => { if (!$('#player-overlay').hidden) nextSource(); });
$('#player').addEventListener('loadedmetadata', () => {
  const video = $('#player');
  if (state.pendingSeek > 5 && Number.isFinite(video.duration) && state.pendingSeek < video.duration - 5) {
    try { video.currentTime = state.pendingSeek; } catch { /* Some live formats reject seeking. */ }
  }
  state.pendingSeek = 0;
});
$('#player').addEventListener('timeupdate', () => {
  const video = $('#player');
  if (!state.activeTitle || state.activeTitle.kind === 'channel' || Date.now() - state.lastProgressSave < 10000) return;
  state.lastProgressSave = Date.now();
  api(`/api/titles/${state.activeTitle.id}/progress`, { method:'POST', body:{ seconds:video.currentTime } }).catch(() => {});
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#player-overlay').hidden) closePlayer(); });

try {
  state.session = await api('/api/session');
  if (state.session.user) showShell(); else showAuth(state.session.needsSetup);
} catch (error) { showAuth(false); $('#auth-error').textContent = error.message; }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
