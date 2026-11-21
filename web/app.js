const state = { session: null, page: 'home', settingsTab: 'sources', kind: 'all', liveGroup: 'all', liveCountry: 'all', guideView: false, guideCountry: '', query: '', items: [], channelQueue: [], subtitleTracks: [], stats: null, sources: [], detailId: null, seriesDetail: null, seriesEpisodes: [], seriesRefreshTimer: null, activeTitle: null, variants: [], variantIndex: 0, resolvedUrl: null, playbackGeneration: 0, lastProgressSave: 0 };
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
  state.guideView = false;
  state.seriesDetail = null;
  state.detailId = null;
  state.seriesEpisodes = [];
  clearTimeout(state.seriesRefreshTimer);
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
  const cover = typeof item.artwork === 'string' && /^https?:\/\//i.test(item.artwork) ? `<img src="${esc(item.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  return `<article class="media-card"><div class="media-art tone-${tone}"><span class="art-initial">${esc(initial)}</span>${cover}<span class="media-kind">${esc(item.kind)}</span></div><div class="media-info"><strong title="${esc(item.title)}">${esc(item.title)}</strong><small>${esc(detail)}</small><div class="media-actions"><button class="button button-quiet button-small" data-detail="${item.id}">Details</button>${item.kind === 'series' ? `<button class="button button-quiet button-small" data-series="${item.id}">Episodes</button>` : `<button class="button button-quiet button-small" data-play="${item.id}">Play</button>`}<button class="star-button ${item.favourite ? 'is-favourite':''}" data-favourite="${item.id}" data-next="${item.favourite ? '0':'1'}" aria-label="${item.favourite ? 'Remove from' : 'Add to'} favourites">${item.favourite ? '★':'☆'}</button></div></div></article>`;
}

function liveCard(item) {
  const artwork=typeof item.artwork==='string' && /^https?:\/\//i.test(item.artwork) ? `<img src="${esc(item.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '▻';
  return `<div class="channel-row"><button class="channel-play" data-play="${item.id}"><span class="channel-icon">${artwork}</span><span><strong>${esc(item.title)}</strong><small>${esc(liveGenre(item))} · ${item.source_count} source${item.source_count === 1 ? '' : 's'}</small></span></button><button class="button button-quiet button-small" data-guide="${item.id}" aria-label="Programme guide for ${esc(item.title)}">Guide</button></div>`;
}

const liveGenres=['General','Entertainment','Sports','Movies','News','Kids','Documentary','Music','Other'];
function liveGenre(item) {
  const group=String(item.group_name || '').toUpperCase();
  const title=String(item.title || '').toUpperCase();
  if (/\b(?:SPORT|ESPN|DAZN|PPV|EUROSPORT)\b/.test(group+' '+title)) return 'Sports';
  if (/\b(?:NEWS|CURRENT AFFAIRS)\b/.test(group+' '+title)) return 'News';
  if (/\b(?:MOVIE|CINEMA|FILMS?)\b/.test(group+' '+title)) return 'Movies';
  if (/\b(?:KIDS?|CHILDREN|CARTOON)\b/.test(group+' '+title)) return 'Kids';
  if (/\b(?:DOCUMENTARY|DOCU|DISCOVERY)\b/.test(group+' '+title)) return 'Documentary';
  if (/\b(?:MUSIC|RADIO)\b/.test(group+' '+title)) return 'Music';
  if (/\b(?:ENTERTAINMENT|24\/7)\b/.test(group)) return 'Entertainment';
  if (/\b(?:GENERAL|FREEVIEW|TERRESTRIAL)\b/.test(group)) return 'General';
  return 'Other';
}

async function renderHome() {
  const [stats, library, live] = await Promise.all([api('/api/stats'), api('/api/catalogue?kind=library'), api('/api/catalogue?kind=channel')]);
  state.stats = stats;
  state.items = [...library.items, ...live.items];
  state.channelQueue = live.items.slice(0,6).map(item=>item.id);
  const recent = library.items.filter(item => item.kind !== 'channel').slice(0, 6);
  page.innerHTML = `<section class="hero"><div><span class="eyebrow">WELCOME TO HEARTHWAVE</span><h2>All your entertainment.<br>One happy place.</h2><p>Movies, music and live television belong together. Your own server, your sources and your choices.</p><button class="button button-primary" data-page="library">Explore your library <span>↗</span></button></div><div class="hero-art"><div class="hero-disc"></div></div></section>
    <div class="stat-grid"><div class="stat"><small>Library titles</small><strong>${stats.items}</strong><span>Grouped across sources</span></div><div class="stat"><small>Live channels</small><strong>${stats.channels}</strong><span>One shared lineup</span></div><div class="stat"><small>Configured sources</small><strong>${stats.sources}</strong><span>Managed in Settings</span></div></div>
    ${heading('Your library', 'Pick up something good.', `<button class="link-button" data-page="library">View library →</button>`)}
    ${recent.length ? `<div class="cards">${recent.map(mediaCard).join('')}</div>` : emptyState('Your library starts here', 'Add a media folder in Settings, then scan it to discover films, episodes, music and photos.', '▣')}
    ${heading('Live channels', 'Any source. One familiar lineup.', `<button class="link-button" data-page="live">Watch live →</button>`)}
    ${live.items.length ? `<div class="live-list">${live.items.slice(0, 6).map(liveCard).join('')}</div>` : emptyState('No channels yet', 'Add a direct channel or import an M3U playlist in Settings > Sources.', '▻')}`;
}

async function renderLibrary() {
  if (state.detailId) return renderTitleDetail();
  if (state.seriesDetail) return renderSeriesDetail();
  const types = [{key:'all',name:'All media'}, {key:'film',name:'Films'}, {key:'series',name:'Series'}, {key:'episode',name:'Episodes'}, {key:'music',name:'Music'}, {key:'photo',name:'Photos'}];
  const result = await api(`/api/catalogue?kind=${encodeURIComponent(state.kind === 'all' ? 'library' : state.kind)}&q=${encodeURIComponent(state.query)}`);
  state.items = result.items;
  const items = result.items.filter(item => item.kind !== 'channel');
  page.innerHTML = `<div class="preview-banner">One title across your sources, with provider artwork and descriptions when available. Choose Details to see editions and start a specific version; series episodes load only when opened.</div>
    <div class="toolbar">${types.map(type => `<button class="pill ${state.kind === type.key ? 'active':''}" data-kind="${type.key}">${type.name}</button>`).join('')}</div>
    ${heading(state.kind === 'all' ? 'Your collection' : types.find(t => t.key === state.kind).name, `${items.length} item${items.length===1?'':'s'} in this view`)}
    ${items.length ? `<div class="cards">${items.map(mediaCard).join('')}</div>` : emptyState('No matching media', 'Try another filter, or add a folder in Settings > Sources.', '▣')}
    ${result.items.length >= result.maxResults ? `<p class="field-note">Showing the first ${result.maxResults} results. Use search to narrow the list.</p>` : ''}`;
}

async function renderTitleDetail() {
  const titleId=state.detailId;
  const [result,versions]=await Promise.all([api(`/api/titles/${titleId}`),api(`/api/titles/${titleId}/variants`)]);
  if (state.detailId!==titleId || state.page!=='library') return;
  const title=result.title;
  state.items=[title];
  const art=typeof title.artwork==='string' && /^https?:\/\//i.test(title.artwork)
    ? `<img src="${esc(title.artwork)}" alt="" referrerpolicy="no-referrer">` : '';
  const facts=[title.year,title.genres,title.rating ? `★ ${title.rating}/10` : '',title.duration_seconds ? `${Math.round(title.duration_seconds/60)} min` : '',title.imdb_id ? `IMDb ${title.imdb_id}` : '',title.tmdb_id ? `TMDB ${title.tmdb_id}` : ''].filter(Boolean);
  page.innerHTML=`<section class="surface"><button class="button button-quiet button-small" data-detail-back>← Back to Library</button>
    <div class="detail-layout"><div class="detail-poster media-art tone-${Number(title.id)%4}"><span class="art-initial">${esc(Array.from(title.title||'?')[0].toUpperCase())}</span>${art}</div>
    <div><span class="eyebrow">${esc(title.kind.toUpperCase())} · ${title.source_count} SOURCE${title.source_count===1?'':'S'}</span><h2 class="detail-title">${esc(title.title)}</h2>
    <p class="detail-facts">${facts.map(esc).join(' · ') || 'No metadata supplied yet'}</p>
    <p class="detail-description">${esc(title.description || 'A description has not been supplied by your sources yet.')}</p>
    <div class="row-actions">${title.kind==='series' ? `<button class="button button-primary" data-series="${title.id}">Browse episodes</button>` : versions.variants.some(v=>v.playable) ? `<button class="button button-primary" data-play="${title.id}">Play best available</button>` : ''}
    <button class="button button-quiet" data-favourite="${title.id}" data-next="${title.favourite?'0':'1'}">${title.favourite?'★ In favourites':'☆ Add to favourites'}</button></div></div></div>
    ${heading('Available sources','Choose a version to play. Hearthwave can try the next source if playback fails.')}
    <div class="episode-list">${versions.variants.map(version=>`<div class="episode-row"><div><strong>${esc(version.name)}</strong><small>${esc([version.quality || 'Quality unspecified',version.type].join(' · '))}</small></div>${version.playable ? `<button class="button button-quiet button-small" data-play="${title.id}" data-preferred="${version.id}">Play this source</button>` : '<span class="field-note">Browse episodes first</span>'}</div>`).join('')}</div></section>`;
}

async function renderSeriesDetail() {
  const seriesId = state.seriesDetail;
  const [result,detail]=await Promise.all([api(`/api/titles/${seriesId}/episodes`),api(`/api/titles/${seriesId}`)]);
  if (state.seriesDetail !== seriesId || state.page !== 'library') return;
  state.items = [result.series,...result.items];
  state.seriesEpisodes = result.items;
  let status = result.status;
  if (status.status === 'idle' && !result.items.length) {
    try { await api(`/api/titles/${seriesId}/episodes/refresh`,{method:'POST'}); status = {status:'running',error:''}; }
    catch (error) { status = {status:'error',error:error.message}; }
  }
  const seasons = [...new Set(result.items.map(row => row.season || 0))].sort((a,b)=>b-a);
  page.innerHTML = `<section class="surface"><button class="button button-quiet button-small" data-series-back>← Back to Library</button><div class="section-heading"><div><span class="eyebrow">SERIES</span><h2>${esc(result.series.title)}</h2><p>${esc(result.series.year || 'Year unknown')} · ${result.items.length} episode${result.items.length === 1 ? '' : 's'} across ${seasons.length} season${seasons.length === 1 ? '' : 's'}</p>${detail.title.description ? `<p class="detail-description">${esc(detail.title.description)}</p>`:''}</div><button class="button button-quiet button-small" data-series-refresh="${seriesId}" ${status.status === 'running' ? 'disabled':''}>${status.status === 'running' ? 'Loading…':'Refresh episodes'}</button></div>
  ${status.status === 'running' ? '<p class="field-note">Retrieving episode information from the configured providers. This runs only when requested.</p>':''}
  ${status.error ? `<p class="field-note alert-note">${esc(status.error)}</p>`:''}
  ${seasons.map(season => `<div class="episode-season"><h3>${season ? `Season ${season}` : 'Unknown season'}</h3><div class="episode-list">${result.items.filter(row => (row.season || 0) === season).map(row => `<div class="episode-row"><div><strong>${row.episode ? `Episode ${row.episode}` : 'Episode'}</strong>${row.episode_name ? `<span>${esc(row.episode_name)}</span>` : ''}<small>${row.source_count} source${row.source_count === 1 ? '' : 's'}</small></div><button class="button button-quiet button-small" data-play="${row.id}">Play</button></div>`).join('')}</div></div>`).join('')}
  ${!result.items.length && status.status !== 'running' ? emptyState('No episodes found yet','Refresh this series to ask its providers for available seasons and episodes.','▣') : ''}</section>`;
  clearTimeout(state.seriesRefreshTimer);
  if (status.status === 'running') state.seriesRefreshTimer = setTimeout(() => { if (state.page === 'library' && state.seriesDetail === seriesId) renderSeriesDetail().catch(error=>notify(error.message,true)); },2500);
}

async function showLiveGuide(titleId) {
  const channel = state.items.find(row => String(row.id) === String(titleId));
  const panel = $('#guide-panel');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `<h2>${esc(channel?.title || 'Channel')} · Programme guide</h2><p class="field-note">Loading available guide entries…</p>`;
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  try {
    const result = await api(`/api/titles/${titleId}/guide`);
    if (!panel.isConnected) return;
    panel.innerHTML = `<h2>${esc(channel?.title || 'Channel')} · Programme guide</h2><p class="field-note">${result.source ? `Guide from ${esc(result.source)} · ` : ''}XMLTV timestamps use your device timezone; other provider times are shown as supplied.</p>${result.programmes.length ? `<div class="episode-list">${result.programmes.map(row => `<div class="episode-row"><div><strong>${esc(row.title)}</strong><small>${esc(localGuideTime(row.start))}${row.end ? ` – ${esc(localGuideTime(row.end))}`:''}</small>${row.description ? `<p class="field-note">${esc(row.description)}</p>`:''}</div></div>`).join('')}</div>` : '<p class="field-note">No guide entries were returned for this channel. Live playback is unaffected.</p>'}${state.session.user.role==='admin'?`<div class="guide-map-actions"><button class="button button-quiet button-small" data-guide-map="${titleId}">Match an XMLTV channel</button></div><div id="guide-map-editor"></div>`:''}`;
  } catch (error) { if (panel.isConnected) panel.innerHTML = `<h2>Programme guide unavailable</h2><p class="field-note">${esc(error.message)}</p>`; }
}

async function showGuideMappingEditor(titleId,query='') {
  const editor=$('#guide-map-editor');
  if (!editor) return;
  editor.innerHTML='<p class="field-note">Finding imported XMLTV channels…</p>';
  const channel=state.items.find(row=>Number(row.id)===Number(titleId));
  const search=query || channel?.title || '';
  try {
    const [saved,results]=await Promise.all([api(`/api/titles/${titleId}/guide/mapping`),api(`/api/guide/channels?q=${encodeURIComponent(search)}`)]);
    if (!editor.isConnected) return;
    editor.innerHTML=`<div class="guide-map-box"><h3>Manual XMLTV match</h3><p class="field-note">${saved.mapping?`Currently matched to ${esc(saved.mapping.name || saved.mapping.channel_id)} in ${esc(saved.mapping.source)}.`:'Automatic matching is active. Choose a specific XMLTV channel to override it.'} Search by name or XMLTV ID.</p>
      <form id="guide-search-form" class="row-actions" data-title-id="${titleId}"><input name="query" maxlength="120" placeholder="Search imported channels" value="${esc(search)}" required><button type="submit" class="button button-quiet button-small">Search</button></form>
      <form id="guide-map-form" class="field-stack" data-title-id="${titleId}"><label>XMLTV channel<select name="channel" required><option value="">Select a channel</option>${results.channels.map((row,index)=>`<option value="${index}" data-feed-id="${row.feed_id}" data-channel-id="${esc(row.channel_id)}">${esc(row.name)} · ${esc(row.source)} (${esc(row.channel_id)})</option>`).join('')}</select></label><div class="row-actions"><button class="button button-primary button-small" type="submit" ${results.channels.length?'':'disabled'}>Save match</button>${saved.mapping?`<button class="button button-danger button-small" type="button" data-guide-unmap="${titleId}">Use automatic matching</button>`:''}</div></form>
      ${!results.channels.length?'<p class="field-note">No channels found. Import an XMLTV feed in Settings → Metadata & Guide or try a broader search.</p>':''}</div>`;
  } catch (error) { if (editor.isConnected) editor.innerHTML=`<p class="field-note alert-note">${esc(error.message)}</p>`; }
}

async function renderLive() {
  if (state.guideView) return renderGuideGrid();
  const result = await api(`/api/catalogue?kind=channel&q=${encodeURIComponent(state.query)}`);
  const countries=[['all','All regions'],['GB','United Kingdom'],['US','United States'],['other','Other']];
  const regionItems=result.items.filter(item=>state.liveCountry==='all' || (state.liveCountry==='other' ? !['GB','US'].includes(item.channel_country) : item.channel_country===state.liveCountry));
  const genres=liveGenres.filter(genre=>regionItems.some(item=>liveGenre(item)===genre));
  const selected=(state.liveGroup==='all'?regionItems:regionItems.filter(item=>liveGenre(item)===state.liveGroup)).sort((a,b)=>{
    const countryRank=code=>code==='GB'?0:code==='US'?1:2;
    return countryRank(a.channel_country)-countryRank(b.channel_country) || liveGenres.indexOf(liveGenre(a))-liveGenres.indexOf(liveGenre(b)) || a.title.localeCompare(b.title);
  });
  state.items=result.items;
  state.channelQueue=selected.map(item=>item.id);
  page.innerHTML = `<div class="preview-banner">All sources share this lineup, grouped by region and familiar genres. Import XMLTV in Settings → Metadata & Guide for a combined programme guide. Administrators can manually match channels from the Guide panel.</div>
    <div class="toolbar">${countries.map(([key,label])=>`<button class="pill ${state.liveCountry===key?'active':''}" data-country="${key}">${label}</button>`).join('')}</div>
    <div class="toolbar"><button class="pill ${state.liveGroup==='all'?'active':''}" data-group="all">All genres</button>${genres.map(genre=>`<button class="pill ${state.liveGroup===genre?'active':''}" data-group="${genre}">${genre}</button>`).join('')}</div>
    ${heading('Your live lineup', `${selected.length} channel${selected.length===1?'':'s'} · ${genres.length} genre${genres.length===1?'':'s'}`, '<button class="button button-quiet button-small" data-guide-view="open">Programme guide</button>')}
    ${selected.length ? `<div class="live-list">${selected.map(liveCard).join('')}</div>` : emptyState('No channels to show', 'Import an M3U playlist or create a direct channel in Settings > Sources.', '▻')}
    <section class="surface" id="guide-panel" hidden></section>`;
}

function localGuideTime(value) {
  if (!value) return 'Time unavailable';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}) : value;
}

async function renderGuideGrid() {
  const result=await api(`/api/guide/grid?country=${encodeURIComponent(state.guideCountry)}&limit=40&q=${encodeURIComponent(state.query)}`);
  if (state.page !== 'live' || !state.guideView) return;
  state.items=result.items;
  state.channelQueue=result.items.map(item=>item.id);
  page.innerHTML=`<div class="preview-banner">Unified guide entries from your manually imported XMLTV feeds. Times are displayed in this device's local timezone; providers with no mapped XMLTV remain playable.</div>
    ${heading('Programme guide','Now and upcoming programmes, shared across all source types.','<button class="button button-quiet button-small" data-guide-view="close">← Live channels</button>')}
    <div class="toolbar">${[['','All'],['GB','United Kingdom'],['US','United States']].map(([key,label])=>`<button class="pill ${state.guideCountry===key?'active':''}" data-guide-country="${key}">${label}</button>`).join('')}</div>
    ${result.items.length?`<div class="guide-grid">${result.items.map(row=>`<div class="guide-row"><div class="guide-channel"><strong>${esc(row.title)}</strong><small>${esc(row.channel_country || 'Unspecified region')}</small><button class="button button-quiet button-small" data-play="${row.id}">Watch</button></div><div class="guide-schedule">${row.guide.programmes.length?row.guide.programmes.map(programme=>`<div class="guide-event"><strong>${esc(programme.title)}</strong><small>${esc(localGuideTime(programme.start))} – ${esc(localGuideTime(programme.end))}</small></div>`).join(''):'<span class="field-note">No matched XMLTV entries</span>'}</div></div>`).join('')}</div>`:emptyState('No live channels yet','Import channels in Settings → Sources to populate the lineup.','▻')}
    <p class="field-note">Showing up to 40 channels. More guide navigation and XMLTV source mapping options are planned.</p>`;
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
    contents = `<div class="info-banner">Sources are configured here, not as separate browsing areas. For Xtream and Stalker, add an authorised connection, discover folders, choose what to include, then scan. Imports run in small batches on the NAS.</div>
      <div class="two-col"><section class="surface"><h2>Add a source</h2><p class="field-note">The source provides content. Viewers see it in Library or Live.</p><form class="field-stack" id="source-form">
      <label>Source name<input name="name" required maxlength="100" placeholder="e.g. Living room NAS"></label>
      <label>Source type<select name="type" id="source-type"><option value="folder">Local media folder</option><option value="m3u">M3U playlist</option><option value="direct">Direct live channel</option><option value="xtream">Xtream Codes API</option><option value="stalker">Stalker / MAG portal</option></select></label>
      <label id="source-location-label">Absolute folder path<input name="location" id="source-location" maxlength="2048" placeholder="/volume1/media" required></label>
      <div id="xtream-fields" class="field-stack" hidden><label>Xtream username<input name="username" autocomplete="off" maxlength="512"></label><label>Xtream password<input name="password" type="password" autocomplete="new-password" maxlength="512"></label></div>
      <div id="stalker-fields" class="field-stack" hidden><label>Registered MAG MAC address<input name="mac" placeholder="00:1A:79:00:00:00" autocomplete="off" maxlength="17"></label><label>Portal login (if required)<input name="stalkerUsername" autocomplete="off" maxlength="512"></label><label>Portal password (if required)<input name="stalkerPassword" type="password" autocomplete="new-password" maxlength="512"></label><label>Device serial (optional)<input name="serial" maxlength="512"></label><label>Device ID (optional)<input name="deviceId" maxlength="512"></label><label>Second device ID (optional)<input name="deviceId2" maxlength="512"></label></div>
      <label id="provider-lan" class="checkbox-row" hidden><input name="allowLan" type="checkbox"> Allow a private LAN provider address</label>
      <p class="field-note" id="source-note">A scan is manual, resumable by re-running it, and uses small indexing batches.</p>
      <button type="submit" class="button button-primary">Add source</button></form></section>
      <section class="surface"><h2>Configured sources</h2><p class="field-note">Imports are triggered here, with their current status shown beside each source.</p>
      ${state.sources.length ? state.sources.map(source => `<div class="list-row"><div><strong>${esc(source.name)}</strong> <span class="tag">${esc(source.type)}</span><small>${esc(source.location || 'No location specified')} · ${esc(source.status)}${source.last_error ? ` · ${esc(source.last_error)}` : ''}</small></div><div class="row-actions">${source.type === 'folder' || ['xtream','stalker'].includes(source.type) ? `<button class="button button-quiet button-small" data-scan="${source.id}">Scan</button>`:''}${['xtream','stalker'].includes(source.type) ? `<button class="button button-quiet button-small" data-discover="${source.id}">Discover folders</button><button class="button button-quiet button-small" data-folders="${source.id}">Choose folders</button>`:''}${source.type === 'm3u' ? `<button class="button button-quiet button-small" data-import="${source.id}">Import M3U</button>`:''}<button class="button button-danger button-small" data-remove="${source.id}">Remove</button></div></div>`).join('') : '<p class="field-note">No sources configured yet.</p>'}
      <button class="button button-quiet button-small" id="refresh-sources">Refresh status</button></section></div>
      <section class="surface" id="provider-folders-panel" hidden></section>
      <section class="surface" id="m3u-import-panel" hidden><h2>Import M3U playlist</h2><p class="field-note">Paste an authorised playlist. Stream entries are indexed progressively; the server does not proxy or transcode them.</p><form class="field-stack" id="m3u-form"><input type="hidden" name="sourceId"><label>M3U text<textarea name="playlist" spellcheck="false" required placeholder="#EXTM3U\n#EXTINF:-1 tvg-id=..."></textarea></label><button class="button button-primary" type="submit">Import playlist</button></form></section>`;
  } else if (state.settingsTab === 'metadata') {
    const feeds=(await api('/api/guide/feeds')).feeds;
    contents=`<div class="info-banner">XMLTV feeds are imported when an administrator clicks Import. No NAS scheduler is required. Existing guide data stays available until a new import succeeds.</div>
      <div class="two-col"><section class="surface"><h2>Add XMLTV guide</h2><p class="field-note">Choose a prepared guide or enter any public XMLTV/XMLTV.gz URL. UK and US public files update roughly daily, so importing once a day is sufficient.</p><div class="row-actions"><button class="button button-quiet button-small" data-guide-preset="GB">Use UK example</button><button class="button button-quiet button-small" data-guide-preset="US">Use US example</button></div><form id="guide-form" class="field-stack">
        <label>Guide name<input name="name" required maxlength="100" placeholder="UK free guide"></label>
        <label>Region<select name="country"><option value="GB">United Kingdom</option><option value="US">United States</option><option value="">Other / mixed</option></select></label>
        <label>XMLTV URL<input name="location" type="url" required maxlength="2048" placeholder="https://example.org/guide.xml.gz"></label>
        <button class="button button-primary" type="submit">Add guide feed</button></form></section>
      <section class="surface"><h2>Configured guides</h2><p class="field-note">The import reads a compressed XMLTV stream in bounded chunks. It never transcodes videos.</p>
        ${feeds.length?feeds.map(feed=>`<div class="list-row"><div><strong>${esc(feed.name)}</strong> <span class="tag">${esc(feed.country||'Mixed')}</span><small>${esc(feed.status)} · ${feed.channel_count} channels · ${feed.programme_count} programmes${feed.last_import ? ` · Last import ${esc(feed.last_import)}`:''}${feed.last_error ? ` · ${esc(feed.last_error)}`:''}</small></div><div class="row-actions"><button class="button button-quiet button-small" data-guide-import="${feed.id}" ${feed.status==='importing'?'disabled':''}>Import</button><button class="button button-danger button-small" data-guide-remove="${feed.id}">Remove</button></div></div>`).join(''):'<p class="field-note">No XMLTV guides configured.</p>'}
        <button class="button button-quiet button-small" id="refresh-guides">Refresh status</button></section></div>`;
  } else if (state.settingsTab === 'users') {
    const users = (await api('/api/users')).users;
    contents = `<div class="two-col"><section class="surface"><h2>Household accounts</h2><p class="field-note">Each account has its own favourites and playback positions, saved on this server.</p>${users.map(user => `<div class="list-row"><strong>${esc(user.username)}</strong><span class="tag">${esc(user.role)}</span></div>`).join('')}</section>
      <section class="surface"><h2>Add a viewer</h2><form id="user-form" class="field-stack"><label>Username<input name="username" minlength="3" maxlength="50" required></label><label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><label>Role<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="button button-primary" type="submit">Create account</button></form></section></div>`;
  } else {
    const explanations = {
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
  label.hidden = false;
  input.required = type !== 'm3u';
  if (type === 'folder') { label.firstChild.textContent = 'Absolute folder path'; input.placeholder = '/volume1/media'; }
  if (type === 'm3u') { label.firstChild.textContent = 'Playlist URL (optional reference)'; input.placeholder = 'https://example.com/channels.m3u'; }
  if (type === 'direct') { label.firstChild.textContent = 'Direct stream URL'; input.placeholder = 'https://example.com/live.m3u8'; }
  if (['stalker','xtream'].includes(type)) { label.firstChild.textContent = 'Provider server / portal URL'; input.placeholder = type === 'xtream' ? 'https://provider.example:8080' : 'https://portal.example/stalker_portal/c/'; }
  $('#xtream-fields').hidden = type !== 'xtream';
  $('#stalker-fields').hidden = type !== 'stalker';
  $('#provider-lan').hidden = !['xtream','stalker'].includes(type);
  for (const selector of ['#xtream-fields [name=username]','#xtream-fields [name=password]','#stalker-fields [name=mac]']) {
    const field = $(selector);
    field.required = type === 'xtream' && field.name !== 'mac' || type === 'stalker' && field.name === 'mac';
  }
  $('#source-note').textContent = type === 'm3u' ? 'After adding this source, use Import M3U to paste the playlist contents.' : ['stalker','xtream'].includes(type) ? 'Provider credentials are encrypted on the NAS. Discover folders, choose the live/VOD categories to import, then scan. Use only services you are authorised to access.' : type === 'direct' ? 'The channel appears in Live immediately. Your browser must support its stream format.' : 'Scan runs in bounded batches and updates the Library as items are discovered.';
}

async function showProviderFolders(sourceId) {
  const source = state.sources.find(item => String(item.id) === String(sourceId));
  const result = await api(`/api/sources/${sourceId}/categories`);
  const panel = $('#provider-folders-panel');
  if (!result.categories.length) {
    panel.innerHTML = `<h2>${esc(source?.name || 'Provider')} folders</h2><p class="field-note">No folders discovered. Click Discover folders above, wait for the status to change, then refresh and try again.</p>`;
  } else {
    const kinds = [['live','Live TV'],['vod','Films / VOD'],['series','Series listings']];
    panel.innerHTML = `<h2>${esc(source?.name || 'Provider')} · Choose folders</h2><p class="field-note">Only checked categories are scanned. Series titles are listed, but individual episodes are not indexed yet. Saved choices remain through later discovery runs.</p><form id="folders-form" class="field-stack"><input name="sourceId" type="hidden" value="${esc(sourceId)}">${kinds.map(([kind,title]) => { const categories = result.categories.filter(row => row.kind === kind); return categories.length ? `<fieldset class="category-set"><legend>${title} (${categories.length})</legend><div class="category-grid">${categories.map(row => `<label class="checkbox-row"><input type="checkbox" name="category" data-kind="${esc(row.kind)}" value="${esc(row.category_id)}" ${row.selected ? 'checked':''}> ${esc(row.name)}</label>`).join('')}</div></fieldset>` : ''; }).join('')}<button class="button button-primary" type="submit">Save folder choices</button></form>`;
  }
  panel.hidden = false;
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
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

async function startPlayback(titleId,preferredId=null) {
  const result = await api(`/api/titles/${titleId}/variants`);
  const playable = result.variants.filter(variant => variant.playable && (variant.url || variant.resolve));
  if (!playable.length) throw new Error('There is no playable stream for this title yet.');
  if (preferredId != null) playable.sort((a,b)=>(Number(b.id)===Number(preferredId)?1:0)-(Number(a.id)===Number(preferredId)?1:0));
  const title = (state.items.find(item => Number(item.id) === Number(titleId)) || (await api('/api/catalogue?kind=all')).items.find(item => Number(item.id) === Number(titleId)) || { title:'Your media', id:titleId });
  state.activeTitle = title;
  state.variants = playable;
  state.variantIndex = 0;
  state.pendingSeek = Number(title.position_seconds) || 0;
  $('#player-title').textContent = title.kind === 'episode' ? `${title.title} · S${title.season || '?'}E${title.episode || '?'}${title.episode_name ? ` · ${title.episode_name}`:''}` : title.title;
  const index = state.seriesEpisodes.findIndex(item => Number(item.id) === Number(titleId));
  $('#previous-episode').hidden = index < 0 || index === state.seriesEpisodes.length - 1;
  $('#next-episode').hidden = index <= 0;
  if (title.kind==='channel' && !state.channelQueue.some(id=>Number(id)===Number(titleId))) state.channelQueue=state.items.filter(item=>item.kind==='channel').map(item=>item.id);
  $('#previous-channel').hidden=title.kind!=='channel' || state.channelQueue.length<2;
  $('#next-channel').hidden=title.kind!=='channel' || state.channelQueue.length<2;
  $('#player-overlay').hidden = false;
  void playVariant();
}

function setSubtitle(index) {
  const video=$('#player');
  video.querySelectorAll('track').forEach(track=>track.remove());
  const choice=state.subtitleTracks[index];
  if (!choice) return;
  const track=document.createElement('track');
  track.kind='subtitles';
  track.label=choice.label;
  track.srclang=choice.language==='und'?'en':choice.language;
  track.src=choice.url;
  track.default=true;
  video.appendChild(track);
  track.track.mode='showing';
}

async function loadSubtitles(variant,generation) {
  if (variant.type!=='folder') return;
  try {
    const result=await api(`/api/media/${variant.id}/subtitles`);
    if (generation!==state.playbackGeneration || $('#player-overlay').hidden) return;
    state.subtitleTracks=result.subtitles;
    const picker=$('#subtitle-picker');
    picker.hidden=!result.subtitles.length;
    const select=$('#player-subtitles');
    select.replaceChildren(new Option('Off','off'),...result.subtitles.map((item,index)=>new Option(item.label,String(index))));
    if (result.subtitles.length) {
      const preferred=result.subtitles.findIndex(item=>item.language==='en');
      const index=preferred>=0?preferred:0;
      select.value=String(index);
      setSubtitle(index);
    }
  } catch { if (generation===state.playbackGeneration) $('#subtitle-picker').hidden=true; }
}

function clearSubtitles() {
  state.subtitleTracks=[];
  $('#subtitle-picker').hidden=true;
  $('#player').querySelectorAll('track').forEach(track=>track.remove());
}

async function playVariant() {
  const generation = ++state.playbackGeneration;
  const item = state.variants[state.variantIndex];
  const video = $('#player');
  state.resolvedUrl = null;
  $('#player-message').textContent = item.resolve ? 'Connecting to your provider…' : '';
  $('#player-source').textContent = `${item.name}${item.quality ? ` · ${item.quality}` : ''} (${state.variantIndex + 1}/${state.variants.length})`;
  $('#try-next').disabled = state.variants.length < 2;
  video.pause();
  clearSubtitles();
  video.removeAttribute('src');
  video.load();
  try {
    const url = item.resolve ? (await api(`/api/variants/${item.id}/resolve`, { method:'POST' })).url : item.url;
    if (generation !== state.playbackGeneration || $('#player-overlay').hidden) return;
    if (!url) throw new Error('No stream URL was returned.');
    state.resolvedUrl = url;
    $('#player-message').textContent = '';
    video.src = url;
    video.load();
    void loadSubtitles(item,generation);
    video.play().catch(() => { if (generation === state.playbackGeneration) $('#player-message').textContent = 'Press Play to start this stream.'; });
  } catch (error) {
    if (generation !== state.playbackGeneration || $('#player-overlay').hidden) return;
    if (state.variantIndex + 1 < state.variants.length) nextSource();
    else $('#player-message').textContent = error instanceof Error ? error.message : 'Could not connect to your provider.';
  }
}

function nextSource() {
  if (state.variantIndex + 1 >= state.variants.length) {
    $('#player-message').textContent = 'None of the available sources could play in this browser. Try a different device or a supported format.';
    return;
  }
  state.pendingSeek = $('#player').currentTime || state.pendingSeek;
  state.variantIndex += 1;
  void playVariant();
}

async function jumpEpisode(direction) {
  if (!state.activeTitle) return;
  const index = state.seriesEpisodes.findIndex(item => Number(item.id) === Number(state.activeTitle.id));
  const adjacent = state.seriesEpisodes[index + direction];
  if (index < 0 || !adjacent) return;
  try { await startPlayback(adjacent.id); }
  catch (error) { notify(error.message,true); }
}

async function jumpChannel(direction) {
  if (state.activeTitle?.kind!=='channel' || state.channelQueue.length<2) return;
  const index=state.channelQueue.findIndex(id=>Number(id)===Number(state.activeTitle.id));
  if (index<0) return;
  const next=state.channelQueue[(index+direction+state.channelQueue.length)%state.channelQueue.length];
  try { await startPlayback(next); }
  catch(error) { notify(error.message,true); }
}

function closePlayer() {
  state.playbackGeneration++;
  state.resolvedUrl = null;
  const video = $('#player');
  video.pause();
  clearSubtitles();
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
  state.detailId = null;
  state.seriesDetail = null;
  clearTimeout(state.seriesRefreshTimer);
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    if (!['live','library'].includes(state.page)) navigate('library');
    else renderPage().catch(error => notify(error.message,true));
  }, 250);
});

page.addEventListener('change', event => { if (event.target?.id === 'source-type') syncSourceForm(); });
page.addEventListener('error', event => { if (event.target?.matches?.('.media-art img')) event.target.hidden=true; }, true);

page.addEventListener('submit', async event => {
  const form = event.target;
  if (!['source-form','m3u-form','user-form','folders-form','guide-form','guide-search-form','guide-map-form'].includes(form.id)) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.id === 'guide-search-form') {
      await showGuideMappingEditor(form.dataset.titleId,String(data.get('query') || ''));
      return;
    }
    if (form.id === 'guide-map-form') {
      const chosen=form.querySelector('[name=channel]').selectedOptions[0];
      if (!chosen?.dataset.feedId || !chosen.dataset.channelId) throw new Error('Choose an XMLTV channel.');
      const titleId=form.dataset.titleId;
      await api(`/api/titles/${titleId}/guide/mapping`,{method:'POST',body:{feedId:Number(chosen.dataset.feedId),channelId:chosen.dataset.channelId}});
      notify('Manual guide match saved.');
      await showLiveGuide(titleId);
      await showGuideMappingEditor(titleId);
      return;
    }
    if (form.id === 'source-form') {
      const type = data.get('type');
      const config = type === 'xtream' ? { username:data.get('username'), password:data.get('password'), allowLan:data.has('allowLan') } : type === 'stalker' ? { mac:data.get('mac'), username:data.get('stalkerUsername'), password:data.get('stalkerPassword'), serial:data.get('serial'), deviceId:data.get('deviceId'), deviceId2:data.get('deviceId2'), allowLan:data.has('allowLan') } : undefined;
      await api('/api/sources', { method:'POST', body:{ name:data.get('name'), type, location:data.get('location') || '', config } });
      notify(['xtream','stalker'].includes(type) ? 'Provider added. Discover its folders and choose what to scan.' : 'Source added. You can scan or import it now.');
    } else if (form.id === 'guide-form') {
      await api('/api/guide/feeds',{method:'POST',body:{name:data.get('name'),country:data.get('country'),location:data.get('location')}});
      notify('Guide feed saved. Click Import to load its XMLTV programmes.');
    } else if (form.id === 'folders-form') {
      const selected = Array.from(form.querySelectorAll('input[name=category]:checked'), checkbox => ({kind:checkbox.dataset.kind,id:checkbox.value}));
      await api(`/api/sources/${data.get('sourceId')}/categories`, {method:'POST',body:{selected}});
      notify(`Saved ${selected.length} provider folder selection${selected.length === 1 ? '' : 's'}. Click Scan to import them.`);
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
  if (target.dataset.guideView) { state.guideView=target.dataset.guideView==='open'; return renderPage(); }
  if (target.dataset.guideCountry !== undefined) { state.guideCountry=target.dataset.guideCountry; return renderPage(); }
  if (target.dataset.country) { state.liveCountry=target.dataset.country; state.liveGroup='all'; return renderPage(); }
  if (target.dataset.guidePreset) {
    const country=target.dataset.guidePreset;
    const form=$('#guide-form');
    if (!form) return;
    form.querySelector('[name=country]').value=country;
    form.querySelector('[name=name]').value=country==='GB'?'United Kingdom EPG':'United States EPG 1';
    form.querySelector('[name=location]').value=country==='GB'?'https://www.open-epg.com/files/unitedkingdom.xml.gz':'https://www.open-epg.com/files/unitedstates1.xml.gz';
    return;
  }
  if (target.dataset.guideImport) {
    try { await api(`/api/guide/feeds/${target.dataset.guideImport}/import`,{method:'POST'}); notify('XMLTV import started. Refresh status in a moment.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.dataset.guideRemove) {
    if (!window.confirm('Remove this guide and all of its programme records?')) return;
    try { await api(`/api/guide/feeds/${target.dataset.guideRemove}`,{method:'DELETE'}); notify('Guide removed.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.id==='refresh-guides') return renderPage();
  if (target.dataset.series) {
    state.seriesDetail = Number(target.dataset.series);
    state.detailId = null;
    state.page = 'library';
    $('#page-title').textContent = 'Library';
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('selected',el.dataset.page === 'library'));
    window.scrollTo({top:0,behavior:'instant'});
    return renderPage();
  }
  if (target.hasAttribute('data-series-back')) { state.seriesDetail = null; clearTimeout(state.seriesRefreshTimer); return renderPage(); }
  if (target.dataset.detail) {
    state.detailId=Number(target.dataset.detail);
    state.seriesDetail=null;
    state.page='library';
    $('#page-title').textContent='Library';
    document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('selected',el.dataset.page==='library'));
    window.scrollTo({top:0,behavior:'instant'});
    return renderPage();
  }
  if (target.hasAttribute('data-detail-back')) { state.detailId=null; return renderPage(); }
  if (target.dataset.seriesRefresh) {
    try { await api(`/api/titles/${target.dataset.seriesRefresh}/episodes/refresh`,{method:'POST'}); notify('Retrieving available episodes.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.dataset.guideMap) return showGuideMappingEditor(target.dataset.guideMap);
  if (target.dataset.guideUnmap) {
    const titleId=target.dataset.guideUnmap;
    try { await api(`/api/titles/${titleId}/guide/mapping`,{method:'DELETE'}); notify('Automatic guide matching restored.'); await showLiveGuide(titleId); await showGuideMappingEditor(titleId); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.dataset.guide) return showLiveGuide(target.dataset.guide);
  if (target.dataset.kind) { state.kind = target.dataset.kind; return renderPage(); }
  if (target.dataset.group) { state.liveGroup = target.dataset.group; return renderPage(); }
  if (target.dataset.settings) { state.settingsTab = target.dataset.settings; return renderPage(); }
  if (target.dataset.play) {
    try { await startPlayback(target.dataset.play,target.dataset.preferred || null); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.favourite) {
    try {
      await api(`/api/titles/${target.dataset.favourite}/favourite`, { method:'POST', body:{ favourite:target.dataset.next === '1' } });
      await renderPage();
    } catch (error) { notify(error.message,true); }
  }
  if (target.dataset.scan) {
    try { await api(`/api/sources/${target.dataset.scan}/scan`, { method:'POST' }); notify('Scan started. New items appear as batches finish.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.discover) {
    try { await api(`/api/sources/${target.dataset.discover}/discover`, { method:'POST' }); notify('Discovering provider folders. Refresh status in a moment, then choose folders.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.folders) {
    try { await showProviderFolders(target.dataset.folders); }
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
$('#player-subtitles').addEventListener('change', event=>setSubtitle(Number(event.target.value)));
$('#previous-channel').addEventListener('click',()=>jumpChannel(-1));
$('#next-channel').addEventListener('click',()=>jumpChannel(1));
$('#previous-episode').addEventListener('click', () => jumpEpisode(1));
$('#next-episode').addEventListener('click', () => jumpEpisode(-1));
$('#open-stream').addEventListener('click', () => {
  if (state.resolvedUrl && /^https?:\/\//i.test(state.resolvedUrl)) window.open(state.resolvedUrl, '_blank', 'noopener,noreferrer');
  else notify('The local stream is available only inside Hearthwave.');
});
$('#player').addEventListener('error', () => { if (!$('#player-overlay').hidden && state.resolvedUrl) nextSource(); });
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
