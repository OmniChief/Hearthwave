import { requestPages } from './requests.js';
import { watchRooms } from './rooms.js';
import { workerPages } from './workers.js';
import { spacePages } from './space.js';
import { installTvNavigation } from './tv-navigation.js';
import { orderPlaybackVariants, playbackVariantLabel } from './playback-variants.js';
import { prepareMedia } from './hls-playback.js';
import { browserPlaybackCapabilities, connectionAdvice, nativeMediaFailure, playbackReport, streamFormat } from './playback-diagnostics.js';
import { adjacentMedia, mediaQueue, presentation } from './local-media.js';

const state = { session: null, page: 'home', requestView:false, playOffset: 0, playView:'all',liveView:'all', settingsTab: 'sources', kind: 'all', libraryView: 'all', libraryGenre: '', librarySort: 'title', libraryOffset: 0, libraryScroll: 0, libraryRequest: 0, collectionOverview: false, collectionId: 0, collectionName: '', collectionMode: 'manual', liveGroup: 'all', liveCountry: 'all', liveOffset: 0, liveRequest: 0, guideView: false, guideCountry: '', guideOffset: 0, guideChannelIds: [], guideDay: 0, guideSlot: Math.floor(new Date().getHours()/6)*6, guideRequest: 0, query: '', items: [], browseItems: [], mediaQueue: [], channelQueue: [], subtitleTracks: [], stats: null, sources: [], sourceJobs: {}, sourcePollTimer: null, detailId: null, seriesDetail: null, seriesEpisodes: [], seriesRefreshTimer: null, autoplayNext: false, qualityPreference: 'auto', activeTitle: null, variants: [], variantIndex: 0, resolvedUrl: null, playbackRequest: 0, playbackGeneration: 0, playbackAttempts: [], recoveryTimer: null, playbackStarted: false, lastMediaTime: 0, lastProgressSave: 0 };
let releaseMedia = () => {};
let failedPlaybackGeneration = -1;
let latestUpdateCheck = null;
let updatePollTimer = null;
let updateStartedHere = false;
let activityTimer=null;
let activityState=null;
let updateWaitStarted = 0;
const $ = (selector) => document.querySelector(selector);
const page = $('#page');

function esc(input) {
  return String(input ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unknown';
  const unit = value >= 1024 ** 3 ? 'GiB' : value >= 1024 ** 2 ? 'MiB' : 'KiB';
  const divisor = unit === 'GiB' ? 1024 ** 3 : unit === 'MiB' ? 1024 ** 2 : 1024;
  return `${(value / divisor).toFixed(1)} ${unit}`;
}

const qualityChoices=[['auto','Auto · best available'],['fhd','Prefer FHD / 1080p or below'],['hd','Prefer HD / 720p or below'],['sd','Prefer SD']];
function qualityOptions(selected) {
  return qualityChoices.map(([key,label])=>`<option value="${key}" ${key===selected?'selected':''}>${label}</option>`).join('');
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
  space.reset(); workers.reset(); rooms.reset(); requests.reset();
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  $('#current-user').textContent = state.session.user.username;
  $('#current-role').textContent = state.session.user.role;
  $('#avatar').textContent = state.session.user.username.charAt(0).toUpperCase();
  document.querySelectorAll('[data-page="settings"]').forEach(button => { button.hidden = state.session.user.role !== 'admin'; });
  state.autoplayNext=false;
  state.qualityPreference='auto';
  const userId=state.session.user.id;
  api('/api/preferences').then(preferences=>{
    if(state.session?.user.id!==userId) return;
    state.autoplayNext=preferences.autoplayNext===true;
    state.qualityPreference=preferences.qualityPreference || 'auto';
    const checkbox=$('#autoplay-next');
    if(checkbox) checkbox.checked=state.autoplayNext;
    for(const selector of ['#player-quality-preference','#settings-quality-preference']) {
      const input=$(selector);if(input) input.value=state.qualityPreference;
    }
  }).catch(()=>{});
  navigate('home');
}

const headings = { home:'Home', library:'Library', live:'Live', play:'Play', create:'Create', community:'Community', 'my-space':'My Space', settings:'Settings' };
const pageHistory = [];
function rememberPage(destination) {
  if (destination === state.page) return;
  pageHistory.push(state.page);
  if (pageHistory.length > 20) pageHistory.shift();
}
async function navigate(destination, recordHistory = true) {
  if (destination === 'settings' && state.session?.user.role !== 'admin') return;
  const next = headings[destination] ? destination : 'home';
  if (recordHistory) rememberPage(next);
  state.requestView=false;
  state.guideView = false;
  state.guideOffset = 0;
  state.guideRequest++;
  state.libraryRequest++;
  state.liveRequest++;
  clearTimeout(state.sourcePollTimer);clearTimeout(activityTimer);clearTimeout(updatePollTimer);workers.stopPolling();
  state.seriesDetail = null;
  state.detailId = null;
  state.seriesEpisodes = [];
  clearTimeout(state.seriesRefreshTimer);
  state.page = next;
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

function watchlistButton(item) {
  return ['film','series','episode'].includes(item.kind)?`<button class="button button-quiet button-small" data-watchlist="${item.id}" data-next="${item.watchlisted?'0':'1'}">${item.watchlisted?'Remove from watchlist':'＋ Watchlist'}</button>`:'';
}
function cardWatchlistButton(item) {
  if (!['film','series','episode'].includes(item.kind)) return '';
  const saved=Boolean(item.watchlisted),label=saved?'Remove from watchlist':'Add to watchlist';
  return `<button class="button button-quiet button-small media-watchlist ${saved?'is-watchlisted':''}" data-watchlist="${item.id}" data-next="${saved?'0':'1'}" title="${label}" aria-label="${label}" aria-pressed="${saved}">${saved?'✓ Saved':'+ Watchlist'}</button>`;
}
function mediaCard(item) {
  const initial = Array.from(item.title || '?')[0].toUpperCase();
  const tone = Number(item.id) % 4;
  const detail = [item.year, item.kind === 'episode' ? `S${item.season || '?'}E${item.episode || '?'}` : null, `${item.source_count} source${item.source_count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const cover = typeof item.artwork === 'string' && /^https?:\/\//i.test(item.artwork) ? `<img src="${esc(item.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  const resume=Number(item.position_seconds)>10 && !['channel','photo'].includes(item.kind);
  const action=item.kind==='photo'?'View':item.kind==='music'?(resume?'Resume':'Listen'):(resume?'Resume':'Play');
  return `<article class="media-card"><button class="media-art media-art-button tone-${tone}${['film','series','episode'].includes(item.kind)?' media-poster':''}" data-card-detail="${item.id}" aria-label="Details for ${esc(item.title)}"><span class="art-initial">${esc(initial)}</span>${cover}<span class="media-kind">${esc(item.kind)}</span>${resume?`<span class="resume-label">${Math.max(1,Math.floor(item.position_seconds/60))}m watched</span>`:''}</button><div class="media-info"><strong title="${esc(item.title)}">${esc(item.title)}</strong><small>${esc(detail)}</small><div class="media-actions"><div class="media-primary-actions"><button class="button button-quiet button-small" data-detail="${item.id}">Details</button>${item.kind === 'series' ? `<button class="button button-quiet button-small" data-series="${item.id}">Episodes</button>` : `<button class="button button-quiet button-small" data-play="${item.id}">${action}</button>`}</div><div class="media-save-actions"><button class="star-button ${item.favourite ? 'is-favourite':''}" data-favourite="${item.id}" data-next="${item.favourite ? '0':'1'}" aria-label="${item.favourite ? 'Remove from' : 'Add to'} favourites">${item.favourite ? '★':'☆'}</button>${cardWatchlistButton(item)}</div></div></div></article>`;
}

function liveCard(item) {
  const artwork=typeof item.artwork==='string' && /^https?:\/\//i.test(item.artwork) ? `<img src="${esc(item.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '▻';
  return `<div class="channel-row"><button class="channel-play" ${item.source_count?`data-play="${item.id}"`:`data-guide="${item.id}"`}><span class="channel-icon">${artwork}</span><span><strong>${esc(item.title)}</strong><small>${esc(liveGenre(item))} · ${item.source_count?`${item.source_count} source${item.source_count===1?'':'s'}${item.epg_backed?' · EPG matched':' · Provider only'}${item.source_types?' · '+esc(item.source_types.split(',').map(type=>({m3u:'IPTV (M3U)',xtream:'IPTV (Xtream)',stalker:'Stalker',direct:'Direct'})[type]||type).join(' + ')):''}`:'EPG only · no connection'}</small></span></button><div class="channel-controls">${state.liveView==='favourites'?`<button class="button button-quiet button-small" data-favourite-move="${item.id}" data-direction="up" aria-label="Move ${esc(item.title)} up">↑</button><button class="button button-quiet button-small" data-favourite-move="${item.id}" data-direction="down" aria-label="Move ${esc(item.title)} down">↓</button>`:''}<button class="button button-quiet button-small" data-guide="${item.id}" aria-label="Programme guide for ${esc(item.title)}">Guide</button>${state.session?.user?.role==='admin'&&item.source_types?.split(',').includes('stalker')?`<button class="button button-quiet button-small" data-stalker-debug="${item.id}">Debug</button>`:''}<button class="star-button ${item.favourite?'is-favourite':''}" data-favourite="${item.id}" data-next="${item.favourite?'0':'1'}" aria-label="${item.favourite?'Remove from':'Add to'} favourites">${item.favourite?'★':'☆'}</button></div></div>`;
}

function sourceOptions(variants,titleId,kind='film') {
  const tiers=['music','photo'].includes(kind)?['All']:['4K','FHD','HD','SD','Unknown'];
  return tiers.map(tier=>{
    const entries=tier==='All'?variants:variants.filter(variant=>variant.qualityTier===tier);
    if(!entries.length) return '';
    return `<section class="source-quality-group"><h3>${tier==='All'?(kind==='photo'?'Photo files':'Audio files'):tier==='Unknown'?'Unspecified quality':tier} <span class="tag">${entries.length} connection${entries.length===1?'':'s'}</span></h3><div class="episode-list">${entries.map(variant=>`<div class="episode-row"><div><strong>${esc(variant.name)}</strong><small>${esc(variant.type)}${variant.group?` · ${esc(variant.group)}`:''}${variant.quality?` · Label: ${esc(variant.quality)}`:''}</small></div>${variant.playable?`<button class="button button-quiet button-small" data-play="${titleId}" data-preferred="${variant.id}">${kind==='photo'?'View this file':kind==='music'?'Listen to this file':'Play this version'}</button>${variant.type==='folder'?`<a class="button button-quiet button-small" href="/api/media/${Number(variant.id)}/file" download>Download file</a>`:''}`:'<span class="field-note">Open series episodes to play</span>'}</div>`).join('')}</div></section>`;
  }).join('');
}

const liveGenres=['General','Entertainment','Sports','Movies','News','Kids','Documentary','Music','Other'];
function liveGenre(item) { return liveGenres.includes(item.live_genre)?item.live_genre:'Other'; }

function cataloguePager(result,scope) {
  const total=Number(result.total)||0,limit=Number(result.limit)||1,offset=Number(result.offset)||0;
  const pages=Math.max(1,Math.ceil(total/limit)),current=Math.floor(offset/limit)+1;
  return `<nav class="catalogue-pagination" aria-label="${scope==='library'?'Library':scope==='play'?'Play':'Live'} pages"><div><strong>${total?`${offset+1}–${offset+result.items.length} of ${total}`:'0'} items</strong><small>Page ${current} of ${pages}</small></div><div class="catalogue-pager-controls"><button class="button button-quiet button-small" data-catalogue-move="${scope}" data-direction="-1" ${offset===0?'disabled':''}>← Previous</button><form id="${scope}-pager" data-limit="${limit}" data-pages="${pages}"><label>Page <input type="number" name="page" min="1" max="${pages}" value="${current}" required></label><button class="button button-quiet button-small" type="submit">Go</button></form><button class="button button-quiet button-small" data-catalogue-move="${scope}" data-direction="1" ${offset+result.items.length>=total?'disabled':''}>Next →</button></div></nav>`;
}

async function renderHome() {
  const [stats, library, continueWatching,watchlist,favouriteChannels] = await Promise.all([api('/api/stats'), api('/api/catalogue?kind=library&limit=6&sort=added&preview=1'), api('/api/catalogue?kind=library&view=continue&sort=activity&limit=6&preview=1'),api('/api/catalogue?kind=library&view=watchlist&limit=6&preview=1'),api('/api/catalogue?kind=channel&view=favourites&limit=6&preview=1')]);
  if(state.page!=='home'||!state.session)return;
  state.stats = stats;
  state.items = [...continueWatching.items,...library.items,...watchlist.items,...favouriteChannels.items];
  state.browseItems=state.items;
  state.channelQueue = favouriteChannels.items.filter(item=>item.source_count>0).map(item=>item.id);
  const recent = library.items.filter(item => item.kind !== 'channel').slice(0, 6);
  page.innerHTML = `<section class="hero"><div><span class="eyebrow">WELCOME TO HEARTHWAVE</span><h2>All your entertainment.<br>One happy place.</h2><p>Movies, music and live television belong together. Your own server, your sources and your choices.</p><button class="button button-primary" data-page="library">Explore your library <span>↗</span></button></div><div class="hero-art"><div class="hero-disc"></div></div></section>
    <div class="stat-grid"><div class="stat"><small>Library titles</small><strong>${stats.items}</strong><span>Grouped across sources</span></div><div class="stat"><small>Live channels</small><strong>${stats.channels}</strong><span>One shared lineup</span></div><div class="stat"><small>Configured sources</small><strong>${stats.sources}</strong><span>Managed in Settings</span></div></div>
    ${continueWatching.items.length?`${heading('Continue watching','Resume where you left off.',`<button class="link-button" data-page="library" data-continue>See progress →</button>`)}<div class="cards">${continueWatching.items.map(mediaCard).join('')}</div>`:''}
    ${watchlist.items.length?`${heading('Your watchlist','Saved for later.','<button class="link-button" data-home-watchlist>See watchlist →</button>')}<div class="cards">${watchlist.items.map(mediaCard).join('')}</div>`:''}
    ${favouriteChannels.items.length?`${heading('Favourite channels','Jump straight to your favourites.','<button class="link-button" data-home-live-favourites>See favourites →</button>')}<div class="live-list">${favouriteChannels.items.map(liveCard).join('')}</div>`:''}
    ${heading('Your library', 'Pick up something good.', `<button class="link-button" data-page="library">View library →</button>`)}
    ${recent.length ? `<div class="cards">${recent.map(mediaCard).join('')}</div>` : emptyState('Your library starts here', 'Add a media folder in Settings, then scan it to discover films, episodes, music and photos.', '▣')}`;
}

const smartKindOptions = [{key:'all',label:'All Library media'},{key:'film',label:'Films'},{key:'series',label:'Series'},{key:'episode',label:'Episodes'},{key:'music',label:'Music'},{key:'photo',label:'Photos'}];
const smartViewOptions = [{key:'all',label:'Any watch status'},{key:'favourites',label:'Favourites only'},{key:'continue',label:'Started watching or listening'},{key:'unwatched',label:'Not started'}];
function smartRuleFields(collection,genres) {
  const kind=collection?.rule_kind || 'film',genre=collection?.rule_genre || '',view=collection?.rule_view || 'all';
  const genreDisabled=!['all','film','series'].includes(kind);
  return `<div class="smart-rule-grid">
    <label>Media type<select name="kind" data-smart-kind>${smartKindOptions.map(option=>`<option value="${option.key}" ${kind===option.key?'selected':''}>${option.label}</option>`).join('')}</select></label>
    <label>Genre<select name="genre" data-smart-genre ${genreDisabled?'disabled':''}><option value="">Any genre</option>${genres.map(value=>`<option value="${esc(value)}" ${genre===value?'selected':''}>${esc(value)}</option>`).join('')}</select></label>
    <label>Watch status<select name="view">${smartViewOptions.map(option=>`<option value="${option.key}" ${view===option.key?'selected':''}>${option.label}</option>`).join('')}</select></label>
    <label>Title contains<input name="query" maxlength="80" placeholder="Optional words" value="${esc(collection?.rule_query || '')}"></label>
    <label>Year from<input name="yearFrom" type="number" min="1880" max="2100" placeholder="Any" value="${collection?.rule_year_from??''}"></label>
    <label>Year to<input name="yearTo" type="number" min="1880" max="2100" placeholder="Any" value="${collection?.rule_year_to??''}"></label>
  </div><p class="field-note">Rules update as indexed media, favourites and playback history change. No automatic background scans.</p>`;
}
function smartRulesFromForm(form) {
  const data=new FormData(form);
  return {kind:String(data.get('kind')||'all'),genre:String(data.get('genre')||''),view:String(data.get('view')||'all'),query:String(data.get('query')||'').trim(),yearFrom:data.get('yearFrom')?Number(data.get('yearFrom')):null,yearTo:data.get('yearTo')?Number(data.get('yearTo')):null};
}
function collectionControls(titleId,collections) {
  const manual=collections.filter(collection=>collection.mode!=='smart');
  return `<section class="collection-membership"><h3>Your collections</h3><div class="collection-tags">${manual.map(collection=>`<button class="pill ${collection.included?'active':''}" data-collection-membership="${collection.id}" data-title-id="${titleId}" data-next="${collection.included?'0':'1'}" aria-label="${collection.included?'Remove from':'Add to'} ${esc(collection.name)}">${collection.included?'✓ ':'＋ '}${esc(collection.name)}</button>`).join('')||'<span class="field-note">Create a manual collection to save this title.</span>'}</div>${collections.some(collection=>collection.mode==='smart')?'<p class="field-note">Smart Collections are updated by their rules, so titles cannot be added to them manually.</p>':''}<button class="button button-quiet button-small" data-library-collections>Manage collections</button></section>`;
}

async function renderCollectionsOverview() {
  const request=++state.libraryRequest;
  const result=await api('/api/collections');
  if(request!==state.libraryRequest || state.page!=='library' || !state.collectionOverview || state.detailId || state.seriesDetail) return;
  state.items=[];
  page.innerHTML=`<section class="surface"><div class="row-actions collection-header"><button class="button button-quiet" data-collection-exit>← Back to Library</button></div>
    <div class="collection-creation">
      <div><h3>Manual collection</h3><form id="collection-create-form" class="collection-create-form"><label for="collection-name">Choose a name</label><input id="collection-name" name="name" maxlength="70" placeholder="e.g. Family film night" required><button class="button button-primary" type="submit">Create collection</button></form></div>
      <details class="smart-create"><summary>＋ Create Smart Collection</summary><form id="smart-collection-create-form" class="smart-rule-form"><label class="smart-name">Collection name<input name="name" maxlength="70" placeholder="e.g. Unwatched thrillers" required></label>${smartRuleFields(null,result.genres)}<button class="button button-primary" type="submit">Create Smart Collection</button></form></details>
    </div>
    ${result.collections.length?`<div class="collection-grid">${result.collections.map(collection=>`<article class="collection-card"><button class="collection-open" data-collection-open="${collection.id}" data-mode="${collection.mode}" data-name="${esc(collection.name)}"><span class="collection-icon">${collection.mode==='smart'?'⚙':'▣'}</span><strong>${esc(collection.name)}</strong><small>${collection.mode==='smart'?'Smart · updates automatically':`${collection.item_count} item${collection.item_count===1?'':'s'}`}</small></button><form class="collection-rename-form" data-collection-rename-form="${collection.id}"><input name="name" value="${esc(collection.name)}" maxlength="70" aria-label="Rename ${esc(collection.name)}" required><button class="button button-quiet button-small" type="submit">Rename</button></form>${collection.mode==='smart'?`<details class="smart-edit"><summary>Edit rules</summary><form class="smart-rule-form" data-smart-rules-form="${collection.id}">${smartRuleFields(collection,result.genres)}<button class="button button-quiet button-small" type="submit">Save rules</button></form></details>`:''}<button class="button button-danger button-small" data-collection-delete="${collection.id}" data-name="${esc(collection.name)}">Delete</button></article>`).join('')}</div>`:emptyState('No collections yet','Create a manual shelf or a Smart Collection to begin.','▣')}
    <p class="field-note">Collections are private to each household account. Removing a collection does not delete your media.</p></section>`;
}

async function renderLibrary() {
  if(state.requestView)return requests.render();
  if (state.detailId) return renderTitleDetail();
  if (state.seriesDetail) return renderSeriesDetail();
  if (state.collectionOverview) return renderCollectionsOverview();
  const request=++state.libraryRequest;
  const types = [{key:'all',name:'All media'}, {key:'film',name:'Films'}, {key:'series',name:'Series'}, {key:'episode',name:'Episodes'}, {key:'music',name:'Music'}, {key:'photo',name:'Photos'}];
  const result = await api(`/api/catalogue?kind=${encodeURIComponent(state.kind === 'all' ? 'library' : state.kind)}&q=${encodeURIComponent(state.query)}&view=${encodeURIComponent(state.libraryView)}&genre=${encodeURIComponent(state.collectionId?'':state.libraryGenre)}&sort=${encodeURIComponent(state.librarySort)}&limit=48&offset=${state.libraryOffset}${state.collectionId?`&collection=${state.collectionId}`:''}`);
  if (state.page!=='library' || state.detailId || state.seriesDetail || request!==state.libraryRequest) return;
  if(state.libraryOffset && state.libraryOffset>=result.total) {state.libraryOffset=Math.max(0,Math.ceil(result.total/48)-1)*48;return renderLibrary();}
  state.items = result.items;
  state.browseItems=result.items;
  const items = result.items.filter(item => item.kind !== 'channel');
  const genreChoices = [...result.genres];
  if(state.libraryGenre && !genreChoices.some(item=>item.name===state.libraryGenre)) genreChoices.push({name:state.libraryGenre,count:0});
  genreChoices.sort((a,b)=>a.name==='Other'?1:b.name==='Other'?-1:b.count-a.count||a.name.localeCompare(b.name));
  page.innerHTML = `${state.collectionId?`<div class="collection-active"><span>${state.collectionMode==='smart'?'⚙':'▣'} ${esc(state.collectionName)} · ${state.collectionMode==='smart'?'Smart Collection':'Your collection'}</span><div><button class="button button-quiet button-small" data-collection-back>All collections</button><button class="button button-quiet button-small" data-collection-exit>Full Library</button></div></div>`:'<div class="preview-banner">One title across your sources, with provider artwork and descriptions when available. Choose Details to see editions and start a specific version; series episodes load only when opened.</div>'}
    <div class="toolbar">${types.map(type => `<button class="pill ${state.kind === type.key ? 'active':''}" data-kind="${type.key}">${type.name}</button>`).join('')}</div>
    <div class="toolbar"><button class="pill ${state.libraryView==='all'?'active':''}" data-library-view="all">Everything</button><button class="pill ${state.libraryView==='favourites'?'active':''}" data-library-view="favourites">★ Favourites</button><button class="pill ${state.libraryView==='continue'?'active':''}" data-library-view="continue">Continue watching</button><button class="pill ${state.libraryView==='watchlist'?'active':''}" data-library-view="watchlist">Watchlist</button><button class="pill ${state.collectionId?'active':''}" data-library-collections>▣ Collections</button><button class="pill" data-open-requests>Media requests</button><label class="library-sort">Sort <select id="library-sort" aria-label="Sort library"><option value="title" ${state.librarySort==='title'?'selected':''}>Title A–Z</option><option value="year" ${state.librarySort==='year'?'selected':''}>Newest release</option><option value="added" ${state.librarySort==='added'?'selected':''}>Recently added</option><option value="activity" ${state.librarySort==='activity'?'selected':''}>Recently watched</option></select></label></div>
    ${!state.collectionId&&['all','film','series'].includes(state.kind)?`<div class="toolbar genre-rail" role="group" aria-label="Filter Library by genre"><button class="pill ${state.libraryGenre===''?'active':''}" data-library-genre="">All genres</button>${genreChoices.map(item=>`<button class="pill ${state.libraryGenre===item.name?'active':''}" data-library-genre="${esc(item.name)}">${esc(item.name)} (${item.count})</button>`).join('')}</div>`:''}
    ${heading(state.kind === 'all' ? state.collectionId ? state.collectionName : 'Your collection' : types.find(t => t.key === state.kind).name, `${result.total} item${result.total===1?'':'s'} match this view${!state.collectionId&&state.libraryGenre?` · ${esc(state.libraryGenre)}`:''}`)}
    ${items.length ? `<div class="cards">${items.map(mediaCard).join('')}</div>` : emptyState('No matching media', state.libraryView==='favourites'?'Star a film, show or song to see it here.':state.libraryView==='continue'?'Play a film or episode to start a resume position.':state.libraryView==='watchlist'?'Add films or series to your watchlist to see them here.':state.collectionId?state.collectionMode==='smart'?'Edit this Smart Collection’s rules from All collections, or choose another filter.':'Add titles from their detail pages, or choose another filter.':'Try another filter, or add a folder in Settings > Sources.', '▣')}
    ${cataloguePager(result,'library')}`;
}

async function renderTitleDetail() {
  const titleId=state.detailId;
  const [result,versions,collectionList]=await Promise.all([api(`/api/titles/${titleId}`),api(`/api/titles/${titleId}/variants`),api(`/api/collections?titleId=${titleId}`)]);
  if (state.detailId!==titleId || state.page!=='library') return;
  const title=result.title;
  state.items=[title];
  const art=typeof title.artwork==='string' && /^https?:\/\//i.test(title.artwork)
    ? `<img src="${esc(title.artwork)}" alt="" referrerpolicy="no-referrer">` : '';
  const facts=[title.year,title.genres,title.rating ? `★ ${title.rating}/10` : '',title.duration_seconds ? `${Math.round(title.duration_seconds/60)} min` : '',title.imdb_id ? `IMDb ${title.imdb_id}` : '',title.tmdb_id ? `TMDB ${title.tmdb_id}` : ''].filter(Boolean);
  page.innerHTML=`<section class="surface"><button class="button button-quiet button-small" data-detail-back>← ${state.seriesDetail?'Back to episodes':'Back to Library'}</button>
    <div class="detail-layout"><div class="detail-poster media-art tone-${Number(title.id)%4}"><span class="art-initial">${esc(Array.from(title.title||'?')[0].toUpperCase())}</span>${art}</div>
    <div><span class="eyebrow">${esc(title.kind.toUpperCase())} · ${title.source_count} SOURCE${title.source_count===1?'':'S'}</span><h2 class="detail-title">${esc(title.title)}${title.kind==='episode'?` · S${esc(title.season||'?')}E${esc(title.episode||'?')}`:''}</h2>
    ${title.episode_name?`<p class="detail-episode-name">${esc(title.episode_name)}</p>`:''}
    <p class="detail-facts">${facts.map(esc).join(' · ') || 'No metadata supplied yet'}</p>
    <p class="detail-description">${esc(title.description || 'A description has not been supplied by your sources yet.')}</p>
    <div class="row-actions">${title.kind==='series' ? `<button class="button button-primary" data-series="${title.id}">Browse episodes</button>` : versions.variants.some(v=>v.playable) ? `<button class="button button-primary" data-play="${title.id}">${title.kind==='photo'?'View photo':title.kind==='music'?'Listen now':'Play best available'}</button>` : ''}
    <button class="button button-quiet" data-favourite="${title.id}" data-next="${title.favourite?'0':'1'}">${title.favourite?'★ In favourites':'☆ Add to favourites'}</button>${watchlistButton(title)}${state.session.user.role==='admin' && ['film','series'].includes(title.kind)?`<button class="button button-quiet" data-metadata-refresh="${title.id}">Fetch metadata</button>`:''}</div></div></div>
    ${heading('Available sources',`${versions.variants.length} connection${versions.variants.length===1?'':'s'} across your providers. Choose a particular version or let Hearthwave try alternatives if playback fails.`)}
    ${sourceOptions(versions.variants,title.id,title.kind)}
    ${collectionControls(title.id,collectionList.collections)}</section>`;
}

function seriesProgress(status){return `<p class="field-note">Retrieving episodes · ${status.processed||0}/${status.total||0} connections · ${status.episodes||0} episodes received</p><progress max="${Math.max(1,status.total||1)}" value="${status.processed||0}"></progress>`;}
function scheduleSeriesProgress(id){
  clearTimeout(state.seriesRefreshTimer);
  const visible=()=>state.session?.user.role==='admin'&&state.page==='library'&&state.seriesDetail===id&&!state.detailId;
  if(!visible())return;
  state.seriesRefreshTimer=setTimeout(async()=>{if(!visible())return;try{const {status}=await api(`/api/titles/${id}/episodes/status`);if(!visible())return;if(status.status!=='running'){await renderSeriesDetail();return;}const p=$('#series-job-progress');if(p)p.innerHTML=seriesProgress(status);scheduleSeriesProgress(id);}catch(error){notify(error.message,true);}},5000);
}
async function renderSeriesDetail() {
  const seriesId = state.seriesDetail;
  const [result,detail,collectionList]=await Promise.all([api(`/api/titles/${seriesId}/episodes`),api(`/api/titles/${seriesId}`),api(`/api/collections?titleId=${seriesId}`)]);
  if (state.seriesDetail !== seriesId || state.page !== 'library') return;
  state.items = [result.series,...result.items];
  state.seriesEpisodes = result.items;
  const status = result.status;
  const seasons = [...new Set(result.items.map(row => row.season || 0))].sort((a,b)=>b-a);
  page.innerHTML = `<section class="surface"><button class="button button-quiet button-small" data-series-back>← Back to Library</button><div class="section-heading"><div><span class="eyebrow">SERIES</span><h2>${esc(result.series.title)}</h2><p>${esc(result.series.year || 'Year unknown')} · ${result.items.length} episode${result.items.length === 1 ? '' : 's'} across ${seasons.length} season${seasons.length === 1 ? '' : 's'}</p>${detail.title.description ? `<p class="detail-description">${esc(detail.title.description)}</p>`:''}</div><div class="row-actions">${watchlistButton(detail.title)}<button class="star-button ${detail.title.favourite?'is-favourite':''}" data-favourite="${seriesId}" data-next="${detail.title.favourite?'0':'1'}" aria-label="${detail.title.favourite?'Remove from':'Add to'} favourites">${detail.title.favourite?'★':'☆'}</button>${state.session.user.role==='admin'?`<button class="button button-quiet button-small" data-metadata-refresh="${seriesId}">Fetch metadata</button>`:''}${state.session.user.role==='admin'?`<button class="button button-quiet button-small" data-series-refresh="${seriesId}" ${status.status==='running'?'disabled':''}>${status.status==='running'?'Loading…':'Refresh episodes'}</button>`:''}</div></div>
  ${collectionControls(seriesId,collectionList.collections)}
  <label class="autoplay-setting"><input type="checkbox" id="autoplay-next" ${state.autoplayNext?'checked':''}> Automatically play the next episode when one finishes <small>Saved to your household profile</small></label>
  ${status.status==='running'?`<div id="series-job-progress">${seriesProgress(status)}</div>`:''}
  ${status.error ? `<p class="field-note alert-note">${esc(status.error)}</p>`:''}
  ${seasons.map(season => `<details class="season-accordion" ${season===seasons[0]?'open':''}><summary>${season ? `Season ${season}` : 'Unknown season'} <small>${result.items.filter(row => (row.season||0)===season).length} episodes</small></summary><div class="episode-list">${result.items.filter(row => (row.season || 0) === season).map(row => {
    const image=typeof (row.artwork||detail.title.artwork)==='string' && /^https?:\/\//i.test(row.artwork||detail.title.artwork)?`<img src="${esc(row.artwork||detail.title.artwork)}" loading="lazy" referrerpolicy="no-referrer" alt="">`:'';
    return `<div class="episode-row"><div class="episode-thumbnail">${image||'<span>▻</span>'}</div><div class="episode-copy"><strong>${row.episode ? `Episode ${row.episode}` : 'Episode'}${row.episode_name?` · ${esc(row.episode_name)}`:''}</strong>${row.description?`<span class="episode-summary">${esc(row.description)}</span>`:''}<small>${row.source_count} source${row.source_count === 1 ? '' : 's'}${Number(row.position_seconds)>10?` · ${Math.floor(row.position_seconds/60)}m watched`:''}</small></div><div class="episode-controls"><button class="button button-quiet button-small" data-episode-detail="${row.id}">Details</button><button class="button button-primary button-small" data-play="${row.id}">Play</button></div></div>`;
  }).join('')}</div></details>`).join('')}
  ${!result.items.length && status.status !== 'running' ? emptyState('No episodes found yet',state.session.user.role==='admin'?'Click Refresh episodes to retrieve them manually.':'Ask an administrator to refresh this series.','▣') : ''}</section>`;
  clearTimeout(state.seriesRefreshTimer);
  if(status.status==='running'&&state.session.user.role==='admin')scheduleSeriesProgress(seriesId);
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
    panel.innerHTML = `<div class="row-actions"><h2>${esc(channel?.title || 'Channel')} · Programme guide</h2><button class="button button-quiet button-small" data-guide-close>← Close guide</button></div><p class="field-note">${result.source ? `Guide from ${esc(result.source)} · ` : ''}XMLTV timestamps use your device timezone; other provider times are shown as supplied.</p>${result.programmes.length ? `<div class="episode-list">${result.programmes.map(row => `<div class="episode-row"><div><strong>${esc(row.title)}</strong><small>${esc(localGuideTime(row.start))}${row.end ? ` – ${esc(localGuideTime(row.end))}`:''}</small>${row.description ? `<p class="field-note">${esc(row.description)}</p>`:''}</div></div>`).join('')}</div>` : '<p class="field-note">No guide entries were returned for this channel. Live playback is unaffected.</p>'}${state.session.user.role==='admin'?`<div class="guide-map-actions"><button class="button button-quiet button-small" data-provider-guide-refresh="${titleId}">Fetch provider guide</button><button class="button button-quiet button-small" data-guide-map="${titleId}">Match an XMLTV channel</button></div><div id="guide-map-editor"></div>`:''}`;
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
  const request=++state.liveRequest;
  const result = await api(`/api/catalogue?kind=channel&q=${encodeURIComponent(state.query)}&view=${state.liveView}&limit=60&offset=${state.liveOffset}&country=${encodeURIComponent(state.liveCountry==='all'?'':state.liveCountry)}&genre=${encodeURIComponent(state.liveGroup==='all'?'':state.liveGroup)}`);
  if(state.page!=='live' || state.guideView || request!==state.liveRequest) return;
  if(state.liveOffset && state.liveOffset>=result.total) {state.liveOffset=Math.max(0,Math.ceil(result.total/60)-1)*60;return renderLive();}
  const countries=[['all','All regions'],['GB','United Kingdom'],['US','United States'],['other','Other']];
  const genreCounts=Object.fromEntries(result.genres.map(item=>[item.name,item.count]));
  const genres=liveGenres.filter(genre=>(genreCounts[genre]||0)>0 || genre===state.liveGroup);
  const selected=result.items;
  state.items=result.items;
  state.channelQueue=selected.filter(item=>item.source_count>0).map(item=>item.id);
  page.innerHTML = `<div class="preview-banner">Imported EPG stations define the lineup. IPTV and Stalker connections attach to matching stations. Only stations with an available indexed stream are listed; unmatched provider channels remain available.</div>
    <div class="toolbar"><button class="pill ${state.liveView==='all'?'active':''}" data-live-view="all">All channels</button><button class="pill ${state.liveView==='favourites'?'active':''}" data-live-view="favourites">★ Favourites</button></div>
    <div class="toolbar">${countries.map(([key,label])=>`<button class="pill ${state.liveCountry===key?'active':''}" data-country="${key}">${label}</button>`).join('')}</div>
    <div class="toolbar"><button class="pill ${state.liveGroup==='all'?'active':''}" data-group="all">All genres</button>${genres.map(genre=>`<button class="pill ${state.liveGroup===genre?'active':''}" data-group="${genre}">${genre} (${genreCounts[genre]||0})</button>`).join('')}</div>
    ${heading('Your live lineup', `${result.total} channel${result.total===1?'':'s'} · ${genres.length} genre${genres.length===1?'':'s'}`, '<button class="button button-quiet button-small" data-guide-view="open">Programme guide</button>')}
    ${selected.length ? `<div class="live-list">${selected.map(liveCard).join('')}</div>` : emptyState('No channels to show', 'Import an M3U playlist or create a direct channel in Settings > Sources.', '▻')}
    ${cataloguePager(result,'live')}
    <section class="surface" id="guide-panel" hidden></section>`;
}

function localGuideTime(value) {
  if (!value) return 'Time unavailable';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}) : value;
}

// Calculate display intervals in absolute time, clipped to the visible window.
// Keep the original programme index for the details panel.
function guideProgrammeLayout(programmes,start,end) {
  const span=end-start;
  if(!Number.isFinite(span)||span<=0)return [];
  const entries=programmes.map((programme,index)=>({programme,index,from:Date.parse(programme.start),until:Date.parse(programme.end)}))
    .filter(entry=>Number.isFinite(entry.from)&&Number.isFinite(entry.until)&&entry.until>entry.from&&entry.until>start&&entry.from<end)
    .sort((a,b)=>a.from-b.from||b.until-a.until||a.index-b.index);
  const unique=entries.filter((entry,i)=>!i||entry.from!==entries[i-1].from);
  return unique.flatMap((entry,i)=>{
    const from=Math.max(start,entry.from),until=Math.min(end,entry.until,unique[i+1]?.from??end);
    return until>from?[{...entry,left:(from-start)/span*100,width:(until-from)/span*100}]:[];
  });
}
function positionGuideProgrammes(root) {
  for(const button of root.querySelectorAll('[data-guide-left][data-guide-width]')){
    const left=Number(button.dataset.guideLeft),width=Number(button.dataset.guideWidth);
    if(!Number.isFinite(left)||!Number.isFinite(width)||left<0||left>=100||width<=0)continue;
    // CSSOM property assignments work with style-src 'self'; inline HTML style attributes do not.
    button.style.left=left+'%';
    button.style.width=Math.min(width,100-left)+'%';
  }
}
async function renderGuideGrid() {
  const request=++state.guideRequest;
  const today=new Date();
  const day=new Date(today.getFullYear(),today.getMonth(),today.getDate()+state.guideDay);
  const beginning=new Date(day.getFullYear(),day.getMonth(),day.getDate(),state.guideSlot);
  const ending=new Date(day.getFullYear(),day.getMonth(),day.getDate(),state.guideSlot+6);
  const start=Math.floor(beginning.getTime()/1000),end=Math.floor(ending.getTime()/1000);
  const windowMs=(end-start)*1000;
  const clock=value=>new Date(value).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  const windowLabel=day.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'short'});
  const result=await api(`/api/guide/grid?country=${encodeURIComponent(state.guideCountry)}&limit=30&offset=${state.guideOffset}&ids=${encodeURIComponent(state.guideChannelIds.join(','))}&q=${encodeURIComponent(state.query)}&start=${start}&end=${end}`);
  if (state.page !== 'live' || !state.guideView || request!==state.guideRequest) return;
  state.items=result.items;
  state.channelQueue=result.items.filter(item=>item.source_count>0).map(item=>item.id);
  const windowBeginning=start*1000;
  const renderProgramme=(entry,row)=>{
    const {programme,index,from,until,left,width}=entry;
    const playing=from<=Date.now() && until>Date.now();
    return `<button type="button" class="guide-programme ${playing?'is-current':''}" data-guide-left="${left.toFixed(6)}" data-guide-width="${width.toFixed(6)}" data-guide-programme="${row.id}" data-programme-index="${index}" title="${esc(programme.title)} · ${esc(clock(from))}–${esc(clock(until))}" aria-label="${esc(programme.title)} on ${esc(row.title)}, ${esc(clock(from))} to ${esc(clock(until))}"><span class="guide-programme-copy"><strong>${esc(programme.title)}</strong><small>${esc(clock(from))}–${esc(clock(until))}</small></span></button>`;
  };
  page.innerHTML=`<div class="preview-banner">Programme listings for your available channels from imported XMLTV feeds. Browse times in your device's timezone; channels without matched guide data can still be played.</div>
    ${heading('Programme guide',`${esc(windowLabel)} · ${esc(clock(beginning))}–${esc(clock(ending))}`,'<button class="button button-quiet button-small" data-guide-view="close">← Live channels</button>')}
    <div class="toolbar">${[['','All'],['GB','United Kingdom'],['US','United States']].map(([key,label])=>`<button class="pill ${state.guideCountry===key?'active':''}" data-guide-country="${key}">${label}</button>`).join('')}</div>
    <div class="guide-navigation"><div class="guide-date-nav"><button class="button button-quiet button-small" data-guide-day="-1" ${state.guideDay===0?'disabled':''}>← Previous day</button><strong>${esc(windowLabel)}</strong><button class="button button-quiet button-small" data-guide-day="1" ${state.guideDay===6?'disabled':''}>Next day →</button></div><div class="guide-slot-nav">${[0,6,12,18].map(hour=>`<button class="pill ${state.guideSlot===hour?'active':''}" data-guide-slot="${hour}">${String(hour).padStart(2,'0')}:00–${String(hour+6).padStart(2,'0')}:00</button>`).join('')}<button class="button button-primary button-small" data-guide-now>Now</button></div></div>
    <div id="guide-programme-details" class="guide-programme-details" hidden></div>
    <div class="guide-scroll" tabindex="0" aria-label="Programme guide timeline, scroll horizontally to see more hours"><div class="guide-ruler"><span>Channel</span><div>${[0,1,2].map(index=>`<span>${esc(clock(windowBeginning+index*windowMs/3))}</span>`).join('')}<span>${esc(clock(ending))}</span></div></div>
    ${result.items.length?`<div class="guide-grid">${result.items.map(row=>{
      const image=typeof row.artwork==='string' && /^https?:\/\//i.test(row.artwork)?`<img src="${esc(row.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'';
      const programmes=guideProgrammeLayout(row.guide.programmes,windowBeginning,windowBeginning+windowMs);
      return `<div class="guide-row"><div class="guide-channel"><div class="guide-logo"><span>▻</span>${image}</div><div class="guide-channel-text"><strong>${esc(row.title)}</strong><small>${esc(row.channel_country || 'Unspecified region')}</small></div>${row.source_count?`<button class="button button-quiet button-small" data-play="${row.id}">Watch</button>`:`<span class="field-note">No connection</span>`}</div><div class="guide-timeline">${programmes.length?programmes.map(entry=>renderProgramme(entry,row)).join(''):'<span class="guide-empty-slot">No matched programme data in this window</span>'}</div></div>`;
    }).join('')}</div>`:emptyState('No live channels yet','Import channels in Settings → Sources to populate the lineup.','▻')}</div>
    <div class="guide-pagination"><span>${result.total?`${result.offset+1}–${result.offset+result.items.length} of ${result.total} channels`:'No matching channels'}</span><div><button class="button button-quiet button-small" data-guide-page="-1" ${result.offset===0?'disabled':''}>← Previous channels</button><button class="button button-quiet button-small" data-guide-page="1" ${result.offset+result.items.length>=result.total?'disabled':''}>More channels →</button></div></div>`;
  positionGuideProgrammes(page);
}

const settingsSections = [ ['sources','Sources'],['metadata','Metadata & Guide'],['users','Users & Access'],['workers','Downloads & Workers'],['appearance','Appearance & Playback'],['system','System'] ];

function renderSourceRows() {
  if(!state.sources.length) return '<p class="field-note">No sources configured yet.</p>';
  return state.sources.map(source=>{
    const job=state.sourceJobs[source.id],live=state.liveCounts?.[source.id];
    const active=job && ['running','cancelling'].includes(job.phase);
    const progress=job?.kind==='scan'?`${Number(job.seen||0).toLocaleString()} items received · ${Number(job.indexed||0).toLocaleString()} indexed${job.folder?` · Folder ${job.folderIndex}/${job.folderCount}: ${job.folder}${job.page?` · Page ${job.page}`:''}`:''}`
      :job?.kind==='discover'?`${job.phase==='completed'?`${job.seen} folders found`:'Contacting provider for folder list'}`:'';
    return `<div class="list-row"><div><strong>${esc(source.name)}</strong> <span class="tag">${esc(source.type)}</span><small>${esc(source.location||'No location specified')} · ${esc(source.status)}${source.last_error?` · ${esc(source.last_error)}`:''}</small>${source.type!=='folder'?`<small>${live?.streams||0} Live streams · ${live?.channels||0} channels · ${live?.matched||0} EPG-matched streams${['xtream','stalker'].includes(source.type)?` · ${live?.selectedLive||0} Live folders selected`:''}</small>`:''}${job?`<small class="source-job-note ${active?'source-job-running':''}">${esc(job.phase)} · ${progress}${job.error?` · ${esc(job.error)}`:''}</small>`:''}</div><div class="row-actions">${source.type==='folder'||(source.type==='m3u'&&source.location)||['xtream','stalker'].includes(source.type)?`<button class="button button-quiet button-small" data-scan="${source.id}" ${active?'disabled':''}>Scan</button>`:''}${['xtream','stalker'].includes(source.type)?`<button class="button button-quiet button-small" data-discover="${source.id}" ${active?'disabled':''}>Discover folders</button><button class="button button-quiet button-small" data-folders="${source.id}" ${active?'disabled':''}>Choose folders</button>`:''}${source.type==='m3u'?`<button class="button button-quiet button-small" data-import="${source.id}" ${active?'disabled':''}>Import M3U</button>`:''}${active&&job.kind==='scan'?`<button class="button button-danger button-small" data-cancel-scan="${source.id}" ${job.cancelRequested?'disabled':''}>${job.cancelRequested?'Cancelling…':'Cancel scan'}</button>`:''}<button class="button button-danger button-small" data-remove="${source.id}" ${active?'disabled':''}>Remove</button></div></div>`;
  }).join('');
}

function scheduleSourcePoll() {
  clearTimeout(state.sourcePollTimer);
  if(state.page!=='settings' || state.settingsTab!=='sources' || !Object.values(state.sourceJobs).some(job=>['running','cancelling'].includes(job.phase))) return;
  state.sourcePollTimer=setTimeout(()=>{
    refreshSourceStatus().catch(()=>{ if(state.page==='settings' && state.settingsTab==='sources') scheduleSourcePoll(); });
  },3500);
}

async function refreshSourceStatus() {
  const result=await api('/api/sources?progress=1');
  if(state.page!=='settings' || state.settingsTab!=='sources') return;
  state.sources=result.sources;
  state.sourceJobs=result.jobs||{};
  if(result.liveCounts)state.liveCounts=result.liveCounts;
  const container=$('#source-status-list');
  if(container) container.innerHTML=renderSourceRows();
  scheduleSourcePoll();
}

function updaterPanel(status) {
  const busy=status.busy===true;
  const last=latestUpdateCheck;
  return `<section class="surface" id="updater-panel"><h2>Built-in updater</h2>
    <p>Check the public <strong>OmniChief/Hearthwave</strong> repository for the latest verified commit on <code>main</code>. Updates are started manually by an administrator.</p>
    <div class="info-banner">Hearthwave downloads and verifies the exact GitHub commit, keeps a temporary recovery snapshot, restarts itself, and restores the previous version if startup fails. It never removes your media or stored settings.</div>
    <p class="field-note" id="update-progress" aria-live="polite">${esc(status.message||'Ready to check for updates.')}${status.version?` · Target ${esc(status.version)}`:''}</p>
    ${last?`<div class="list-row"><div><strong>Installed ${esc(last.currentVersion)} → GitHub ${esc(last.latestVersion)}</strong><small>${esc(last.message)} · ${esc(last.latestSha.slice(0,12))}</small></div><span class="tag">${last.available?'Update available':'Up to date'}</span></div>`:''}
    <div class="row-actions"><button class="button button-quiet" id="check-update" ${busy?'disabled':''}>Check GitHub</button>
    ${last?.available?`<button class="button button-primary" id="install-update" ${busy?'disabled':''}>Install verified update</button>`:''}</div>
    <p class="field-note">Updates require outbound HTTPS access to GitHub and write access to the installation folder. No Git command, npm packages, Docker or cron task is required.</p>
  </section>`;
}

function scheduleUpdatePolling(busy=updateStartedHere) {
  clearTimeout(updatePollTimer);
  if(!busy || state.page!=='settings' || state.settingsTab!=='system') return;
  updatePollTimer=setTimeout(async()=>{
    if(state.page!=='settings' || state.settingsTab!=='system') return;
    try {
      const status=await api('/api/system/update/status');
      const panel=$('#updater-panel');
      if(panel) panel.outerHTML=updaterPanel(status);
      if(status.phase==='complete' && updateStartedHere) {
        updateStartedHere=false;
        notify('Hearthwave updated successfully. Reloading the new interface.');
        setTimeout(()=>window.location.reload(),1200);
        return;
      }
      if(status.phase==='failed' && updateStartedHere) {
        updateStartedHere=false;notify(status.message,true);return;
      }
      if(status.busy || updateStartedHere) {
        if(updateStartedHere && Date.now()-updateWaitStarted>300000) {updateStartedHere=false;notify('Update status timed out. Reconnect to Hearthwave and check Settings > System.',true);return;}
        scheduleUpdatePolling(true);
      }
    } catch {
      if(updateStartedHere && Date.now()-updateWaitStarted<300000) scheduleUpdatePolling();
    }
  },2000);
}

function maintenancePanel(activity,controls=true){
  const j=activity.metadata, lineup=activity.lineup;
  const active=[];
  for(const [id,job] of Object.entries(activity.sources||{}))if(['running','cancelling'].includes(job.phase))active.push('Source '+id+' · '+job.kind+' · '+job.indexed+' indexed / '+job.seen+' received');
  for(const [id,job] of Object.entries(activity.episodes||{}))if(job.status==='running')active.push('Series '+id+' · '+job.processed+'/'+job.total+' connections · '+job.episodes+' episodes');
  for(const [id,job] of Object.entries(activity.guides||{}))if(job.phase==='running')active.push('XMLTV feed '+id+' · '+job.channels+' channels / '+job.programmes+' programmes');
  for(const id of activity.titleMetadata||[])active.push('Title '+id+' · fetching metadata');
  if(activity.providerGuide!==null)active.push('Channel '+activity.providerGuide+' · fetching provider guide');
  if(activity.backup)active.push('Preparing database backup');
  if(activity.systemOperation&&!activity.backup)active.push('System maintenance / update');
  if(j&&['running','cancelling'].includes(j.phase))active.push('Manual '+j.kind+' metadata lookup');
  return '<section id="maintenance-panel" class="surface"><h2>Administrator activity</h2><p class="field-note">'+(activity.busy?'Administrator operation in progress. Only one heavy NAS job can run at once.':'Idle — no catalogue, metadata or guide maintenance is running.')+'</p>'+
    active.map(item=>'<p>'+esc(item)+'</p>').join('')+
    (lineup?'<div class="list-row"><div><strong>Live lineup · '+esc(lineup.phase)+'</strong><small>'+esc(lineup.stage)+' · '+lineup.processed+'/'+lineup.total+' · '+lineup.stations+' EPG stations · '+lineup.matched+' matched streams · '+lineup.unmatched+' unmatched ('+lineup.ambiguous+' ambiguous)</small><small>'+esc(lineup.error||'')+'</small><progress max="'+Math.max(1,lineup.total)+'" value="'+lineup.processed+'"></progress></div></div>':'')+
    (controls?'<p>Use imported EPG stations as the Live lineup and attach existing provider streams. No provider re-download is needed.</p><button class="button button-primary" data-lineup-rebuild '+(activity.busy?'disabled':'')+'>Rebuild Live lineup</button>':'')+
    (j?'<div class="list-row"><div><strong>'+esc(j.kind==='game'?'Game artwork':'Local film metadata')+' · '+esc(j.phase)+'</strong><small>'+j.processed+'/'+j.total+' checked · '+j.matched+' updated · '+j.missed+' no match · '+j.failed+' failed</small><small>'+esc(j.current||j.error||'')+'</small><progress max="'+Math.max(1,j.total)+'" value="'+j.processed+'"></progress></div>'+(['running','cancelling'].includes(j.phase)?'<button class="button button-danger button-small" data-maintenance-cancel '+(j.cancelRequested?'disabled':'')+'>Cancel</button>':'')+'</div>':'')+
    (controls?'<p>Metadata retrieval never starts automatically. Each run checks up to 500 missing local films or game covers. Recent unsuccessful matches are skipped for 24 hours unless you explicitly retry them.</p><label class="checkbox-row"><input type="checkbox" id="maintenance-retry"> Include recent unmatched titles</label><div class="row-actions"><button class="button button-primary" data-maintenance-start="film" '+(activity.busy?'disabled':'')+'>Fetch film metadata</button><button class="button button-primary" data-maintenance-start="game" '+(activity.busy?'disabled':'')+'>Fetch game artwork</button></div>':'')+
    '<button class="button button-quiet button-small" data-maintenance-refresh>Refresh activity</button></section>';
}
function scheduleActivityPolling(){
  clearTimeout(activityTimer);
  if(state.page!=='settings'||!['metadata','system'].includes(state.settingsTab)||!activityState?.busy)return;
  activityTimer=setTimeout(()=>refreshActivity().catch(()=>{}),5000);
}
async function refreshActivity(){
  if(state.page!=='settings'||!['metadata','system'].includes(state.settingsTab))return;
  const tab=state.settingsTab,result=await api('/api/system/activity');
  if(state.page!=='settings'||state.settingsTab!==tab)return;
  const wasBusy=activityState?.busy;
  activityState=result;
  const p=$('#maintenance-panel');if(p)p.outerHTML=maintenancePanel(result,tab==='metadata');
  if(tab==='metadata'&&wasBusy&&!result.busy&&Object.values(result.guides||{}).some(j=>j.phase==='completed'||j.phase==='error')){await renderSettings();return;}
  if(tab==='metadata'){
    for(const [id,job] of Object.entries(result.guides||{})){
      const button=page.querySelector('[data-guide-import="'+Number(id)+'"]');
      const row=button?.closest('.list-row');const label=row?.querySelector('small');
      if(label&&job.phase==='running')label.textContent='importing · '+job.channels+' channels · '+job.programmes+' programmes received';
    }
  }
  scheduleActivityPolling();
}

async function renderSettings() {
  clearTimeout(state.sourcePollTimer);clearTimeout(activityTimer);clearTimeout(updatePollTimer);workers.stopPolling();
  if (state.settingsTab === 'sources') {const result=await api('/api/sources');state.sources=result.sources;state.sourceJobs=result.jobs||{};state.liveCounts=result.liveCounts||{};}
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
      <p class="field-note" id="source-note">Adding a source never scans it. Click Scan to begin an import with progress tracking.</p>
      <button type="submit" class="button button-primary">Add source</button></form></section>
      <section class="surface"><h2>Configured sources</h2><p class="field-note">Imports run in bounded batches. While a scan is active, item counts, the current provider folder and its page are refreshed automatically. Counts indicate work done, not a percentage of the whole provider.</p>
      <div id="source-status-list">${renderSourceRows()}</div>
      <button class="button button-quiet button-small" id="refresh-sources">Refresh status</button></section></div>
      <section class="surface" id="provider-folders-panel" hidden></section>
      <section class="surface" id="m3u-import-panel" hidden><h2>Import M3U playlist</h2><p class="field-note">Paste an authorised playlist. Stream entries are indexed progressively; the server does not proxy or transcode them.</p><form class="field-stack" id="m3u-form"><input type="hidden" name="sourceId"><label>M3U text<textarea name="playlist" spellcheck="false" required placeholder="#EXTM3U\n#EXTINF:-1 tvg-id=..."></textarea></label><button class="button button-primary" type="submit">Import playlist</button></form></section>`;
  } else if (state.settingsTab === 'metadata') {
    const [guideResult,activity]=await Promise.all([api('/api/guide/feeds'),api('/api/system/activity')]);
    const feeds=guideResult.feeds;activityState=activity;
    contents=`${maintenancePanel(activity)}<div class="info-banner">XMLTV feeds are imported when an administrator clicks Import. No NAS scheduler is required. Existing guide data stays available until a new import succeeds.</div>
      <div class="two-col"><section class="surface"><h2>Add XMLTV guide</h2><p class="field-note">Choose a prepared guide or enter any public XMLTV/XMLTV.gz URL. UK and US public files update roughly daily, so importing once a day is sufficient.</p><div class="row-actions"><button class="button button-quiet button-small" data-guide-preset="GB">Use UK example</button><button class="button button-quiet button-small" data-guide-preset="US">Use US example</button></div><form id="guide-form" class="field-stack">
        <label>Guide name<input name="name" required maxlength="100" placeholder="UK free guide"></label>
        <label>Region<select name="country"><option value="GB">United Kingdom</option><option value="US">United States</option><option value="">Other / mixed</option></select></label>
        <label>XMLTV URL<input name="location" type="url" required maxlength="2048" placeholder="https://example.org/guide.xml.gz"></label>
        <button class="button button-primary" type="submit">Add guide feed</button></form></section>
      <section class="surface"><h2>Configured guides</h2><p class="field-note">The import reads a compressed XMLTV stream in bounded chunks. It never transcodes videos.</p>
        <div id="guide-status-list">${feeds.length?feeds.map(feed=>`<div class="list-row"><div><strong>${esc(feed.name)}</strong> <span class="tag">${esc(feed.country||'Mixed')}</span><small>${esc(feed.status)} · ${feed.job?.phase==='running'?`${feed.job.channels} channels · ${feed.job.programmes} programmes received`: `${feed.channel_count} channels · ${feed.programme_count} programmes`}${feed.last_import ? ` · Last import ${esc(feed.last_import)}`:''}${feed.last_error ? ` · ${esc(feed.last_error)}`:''}</small></div><div class="row-actions"><button class="button button-quiet button-small" data-guide-import="${feed.id}" ${feed.status==='importing'?'disabled':''}>Import</button><button class="button button-danger button-small" data-guide-remove="${feed.id}">Remove</button></div></div>`).join(''):'<p class="field-note">No XMLTV guides configured.</p>'}</div>
        <button class="button button-quiet button-small" id="refresh-guides">Refresh status</button></section></div>`;
  } else if (state.settingsTab === 'users') {
    const users = (await api('/api/users')).users;
    contents = `<div class="two-col"><section class="surface"><h2>Household accounts</h2><p class="field-note">Each account has its own favourites and playback positions, saved on this server.</p>${users.map(user => `<div class="list-row"><strong>${esc(user.username)}</strong><span class="tag">${esc(user.role)}</span></div>`).join('')}</section>
      <section class="surface"><h2>Add a viewer</h2><form id="user-form" class="field-stack"><label>Username<input name="username" minlength="3" maxlength="50" required></label><label>Temporary password<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><label>Role<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="button button-primary" type="submit">Create account</button></form></section></div>`;
  } else if (state.settingsTab === 'appearance') {
    contents=`<section class="surface"><h2>Playback quality</h2><p>Choose which versions Hearthwave should try first when a title has multiple connections.</p><div class="field-stack"><label>Preferred quality<select id="settings-quality-preference">${qualityOptions(state.qualityPreference)}</select></label></div>
      <div class="info-banner">This is a preference, not a conversion setting. If the preferred quality is unavailable, all existing sources remain available as fallbacks. Your selection is saved to your account and works across devices. No NAS transcoding is performed.</div></section>
      <section class="surface"><h2>TV controls</h2><p class="field-note">Use arrows to move between controls, OK/Enter to select and Back/Escape to return. The player also lets you choose a connection directly. TV manufacturers differ in which remote buttons they expose to the browser.</p></section>`;
  } else if (state.settingsTab === 'system') {
    const [status,updater,activity] = await Promise.all([api('/api/system/status'),api('/api/system/update/status'),api('/api/system/activity')]);
    activityState=activity;
    const days = Math.floor(status.uptimeSeconds / 86400);
    const hours = Math.floor(status.uptimeSeconds % 86400 / 3600);
    contents = `<section class="surface"><h2>Server overview</h2><p class="field-note">Local diagnostics from this Hearthwave process. Memory measures the server, not your browser.</p>
      <div class="stat-grid"><div class="stat"><small>Version</small><strong>${esc(status.version)}</strong><span>SQLite schema ${esc(status.schema)}</span></div><div class="stat"><small>Process memory</small><strong>${formatBytes(status.rssBytes)}</strong><span>Resident memory (RSS)</span></div><div class="stat"><small>Database file</small><strong>${formatBytes(status.databaseBytes)}</strong><span>Does not include active WAL</span></div></div>
      <p class="field-note">Uptime: ${days ? `${days} day${days === 1 ? '' : 's'}, ` : ''}${hours}h ${Math.floor(status.uptimeSeconds % 3600 / 60)}m.</p></section>
      <section class="surface"><h2>Download a backup</h2><p>Save a consistent snapshot of your Hearthwave accounts, catalogue, preferences and encrypted provider configuration.</p>
      <div class="info-banner"><strong>Keep this archive private.</strong> It contains the SQLite database and its encryption key, which together expose account data and saved provider credentials. Store it somewhere secure. Local media files and external folders are not included.</div>
      <button id="download-backup" class="button button-primary" ${status.backupBusy ? 'disabled' : ''}>${status.backupBusy ? 'Backup in progress…' : 'Download backup (.tar.gz)'}</button>
      <p class="field-note">A temporary, consistent SQLite snapshot is created on the NAS, streamed to your browser and removed afterwards. No cloud upload or scheduler is involved. Restoring is an offline, administrator-managed operation.</p></section>
      ${updaterPanel(updater)}
      ${maintenancePanel(activity,false)}`;
  } else {
    contents = await workers.contents(true);
  }
  page.innerHTML = `<div class="settings-layout"><div class="settings-menu">${settingsSections.map(section => `<button class="${state.settingsTab === section[0] ? 'active':''}" data-settings="${section[0]}">${section[1]}</button>`).join('')}</div><div class="settings-content">${contents}</div></div>`;
  if (state.settingsTab === 'sources') {syncSourceForm();scheduleSourcePoll();}
  if (state.settingsTab === 'system') scheduleUpdatePolling(updateStartedHere||Boolean($('#updater-panel')?.querySelector('#check-update')?.disabled));
  if(['metadata','system'].includes(state.settingsTab))scheduleActivityPolling();
}

function syncSourceForm() {
  const type = $('#source-type')?.value;
  const label = $('#source-location-label');
  const input = $('#source-location');
  if (!input || !label) return;
  label.hidden = false;
  input.required = type !== 'm3u';
  if (type === 'folder') { label.firstChild.textContent = 'Absolute folder path'; input.placeholder = '/volume1/media'; }
  if (type === 'm3u') { label.firstChild.textContent = 'Playlist URL (optional)'; input.placeholder = 'https://example.com/channels.m3u'; }
  if (type === 'direct') { label.firstChild.textContent = 'Direct stream URL'; input.placeholder = 'https://example.com/live.m3u8'; }
  if (['stalker','xtream'].includes(type)) { label.firstChild.textContent = 'Provider server / portal URL'; input.placeholder = type === 'xtream' ? 'https://provider.example:8080' : 'https://portal.example/stalker_portal/c/'; }
  $('#xtream-fields').hidden = type !== 'xtream';
  $('#stalker-fields').hidden = type !== 'stalker';
  $('#provider-lan').hidden = !['xtream','stalker'].includes(type);
  for (const selector of ['#xtream-fields [name=username]','#xtream-fields [name=password]','#stalker-fields [name=mac]']) {
    const field = $(selector);
    field.required = type === 'xtream' && field.name !== 'mac' || type === 'stalker' && field.name === 'mac';
  }
  $('#source-note').textContent = type === 'm3u' ? 'Enter a public playlist URL to import its channels, or leave it blank and paste the playlist after adding the source.' : ['stalker','xtream'].includes(type) ? 'Provider credentials are encrypted on the NAS. Discover folders, choose the live/VOD categories to import, then scan. Use only services you are authorised to access.' : type === 'direct' ? 'The channel appears in Live immediately. Your browser must support its stream format.' : 'Scan runs in bounded batches and updates the Library as items are discovered.';
}

async function showProviderFolders(sourceId) {
  const source = state.sources.find(item => String(item.id) === String(sourceId));
  const result = await api(`/api/sources/${sourceId}/categories`);
  const panel = $('#provider-folders-panel');
  if (!result.categories.length) {
    panel.innerHTML = `<h2>${esc(source?.name || 'Provider')} folders</h2><p class="field-note">No folders discovered. Click Discover folders above, wait for the status to change, then refresh and try again.</p>`;
  } else {
    const kinds = [['live','Live TV'],['vod','Films / VOD'],['series','Series listings']];
    panel.innerHTML = `<h2>${esc(source?.name || 'Provider')} · Choose folders</h2><p class="field-note">Only checked categories are scanned. Series titles are listed, but individual episodes are not indexed yet. Saved choices remain through later discovery runs.</p><form id="folders-form" class="field-stack"><input name="sourceId" type="hidden" value="${esc(sourceId)}">${kinds.map(([kind,title]) => { const categories = result.categories.filter(row => row.kind === kind); return categories.length ? `<fieldset class="category-set" data-folder-section="${kind}"><legend>${title} (${categories.length})</legend><div class="folder-filter-row"><input type="search" data-folder-filter="${kind}" placeholder="Search ${title.toLowerCase()}…" aria-label="Search ${title} folders"><button class="button button-quiet button-small" type="button" data-select-filtered="${kind}">Add filtered</button></div><div class="category-grid">${categories.map(row => `<label class="checkbox-row" data-folder-option><input type="checkbox" name="category" data-kind="${esc(row.kind)}" value="${esc(row.category_id)}" ${row.selected ? 'checked':''}> ${esc(row.name)}</label>`).join('')}</div></fieldset>` : ''; }).join('')}<button class="button button-primary" type="submit">Save folder choices</button></form>`;
  }
  panel.hidden = false;
  panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

async function renderGames() {
  const offset = state.playOffset;
  const query=state.query;
  const view=state.playView;
  const result = await api('/api/catalogue?kind=game&limit=60&view='+view+'&q='+encodeURIComponent(query)+'&offset=' + offset);
  if (state.page !== 'play' || offset !== state.playOffset || query !== state.query || view!==state.playView) return;
  if(offset&&offset>=result.total){state.playOffset=Math.max(0,Math.ceil(result.total/60)-1)*60;return renderGames();}
  const games = result.items.map(game => `<article class="surface">${game.artwork?`<img class="game-cover" src="${esc(game.artwork)}" alt="${esc(game.title)} box art" loading="lazy" referrerpolicy="no-referrer">`:''}<h3>${esc(game.title)}</h3><p>${esc(game.system || game.group_name || '')}</p>${game.core?`<button class="button button-primary" data-game="${Number(game.variant_id)}">Play game</button>`:'<span>Emulator unavailable</span>'}<a class="button button-quiet" download href="/api/media/${Number(game.variant_id)}/file">Download ROM</a><button class="star-button ${game.favourite?'is-favourite':''}" data-favourite="${game.id}" data-next="${game.favourite?'0':'1'}" aria-label="${game.favourite?'Remove from':'Add to'} favourites">${game.favourite?'★':'☆'}</button></article>`);
  page.innerHTML = heading('Game library') + `<div class="toolbar"><button class="pill ${view==='all'?'active':''}" data-play-view="all">All games</button><button class="pill ${view==='favourites'?'active':''}" data-play-view="favourites">★ Favourites</button></div>` + (games.length
    ? '<div class="cards">' + games.join('') + '</div>' + cataloguePager(result,'play')
    : emptyState('No games indexed', 'Scan your ROM folder under Settings > Sources.', '◈'));
}

const requests = requestPages({page,state,api,esc,notify});
const rooms = watchRooms({page,state,api,esc,notify,startPlayback});
const space = spacePages({page,state,api,esc,notify,rooms});
const workers = workerPages({page,state,api,esc,notify});
async function renderPage() {
  switch (state.page) {
    case 'home': return renderHome();
    case 'library': return renderLibrary();
    case 'live': return renderLive();
    case 'play': return renderGames();
    case 'settings': return renderSettings();
    case 'community': case 'my-space': return space.render(state.page);
    case 'create': return workers.render();
    default: return renderHome();
  }
}

function currentPlaybackAttempt() {return state.playbackAttempts.at(-1);}

function setPlaybackStatus(generation,status,failure='none') {
  const attempt=currentPlaybackAttempt();
  if(!attempt || attempt.generation!==generation || failedPlaybackGeneration===generation && status!=='Failed') return;
  attempt.status=status;
  if(failure!=='none') attempt.failure=failure;
  renderPlaybackDiagnostics();
}

function renderPlaybackDiagnostics() {
  if($('#player-diagnostics').hidden) return;
  const attempts=state.playbackAttempts;
  const failed=attempts.filter(attempt=>attempt.status==='Failed').length;
  $('#player-diagnostics-summary').textContent=`${attempts.length} connection attempt${attempts.length===1?'':'s'} · ${failed} failed`;
  $('#player-attempts').innerHTML=attempts.map(attempt=>`<li><strong>Connection ${attempt.index+1} · ${esc(attempt.quality)}</strong><span class="diagnostic-status" data-status="${esc(attempt.status)}">${esc(attempt.status)}</span><small>${esc(attempt.format)} · ${esc(attempt.engine)}${attempt.failure!=='none' ? ` · ${esc(attempt.failure)}`:''}</small>${attempt.status==='Failed'?`<small>${esc(connectionAdvice(attempt.failure,attempt.format,attempt.mixedContent))}</small>`:''}</li>`).join('');
  const current=currentPlaybackAttempt();
  $('#player-advice').textContent=current?.status==='Playing' ? 'This connection is playing. Browser capability checks are hints, not a guarantee for every video.' : current?.failure!=='none' && current ? connectionAdvice(current.failure,current.format,current.mixedContent) : current?.mixedContent ? connectionAdvice('unknown',current.format,true) : 'If a connection fails, its cause and suggested next step will appear here.';
  const debugReport=$('#stalker-debug-report');
  debugReport.hidden=!state.stalkerDebug;
  $('#stalker-header-check').hidden=!state.stalkerDebug;
  $('#stalker-header-check').disabled=!current || current.headerBusy || !['Failed','Paused'].includes(current.status);
  $('#stalker-get-check').hidden=!state.stalkerDebug;
  $('#stalker-get-check').disabled=$('#stalker-header-check').disabled;
  $('#stalker-compare-check').hidden=!state.stalkerDebug;
  $('#stalker-compare-check').disabled=$('#stalker-header-check').disabled;
  if(state.stalkerDebug) debugReport.value=playbackReport(attempts,browserPlaybackCapabilities($('#player')))+'\n'+clientDebugSnapshot();
  const caps=browserPlaybackCapabilities($('#player'));
  $('#player-browser-support').innerHTML=caps.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
}

function clientDebugSnapshot() {
  const media=$('#player');
  return ['Device: '+navigator.userAgent,'Page protocol: '+location.protocol,'Native media error: '+(media.error?.code||0),'Ready state: '+media.readyState+'; network state: '+media.networkState,'Decoded size: '+media.videoWidth+' x '+media.videoHeight,'Playback seconds: '+Math.round(media.currentTime||0),'MPEG-TS support: '+(media.canPlayType('video/mp2t')||'not reported')].join('\n');
}
function beginPlaybackAttempt(generation,item) {
  const previous=currentPlaybackAttempt();
  if(previous && !['Failed','Switched'].includes(previous.status)) previous.status='Switched';
  state.playbackAttempts.push({generation,variantId:item.id,sourceId:item.sourceId,index:state.variantIndex,quality:item.qualityTier || 'Unknown',format:'Unknown',engine:'Unresolved',status:'Connecting',failure:'none',mixedContent:false});
  if(state.playbackAttempts.length>12) state.playbackAttempts.shift();
  renderPlaybackDiagnostics();
}

function currentMedia() {return presentation(state.activeTitle?.kind)==='audio' ? $('#music-player') : $('#player');}

function resetMediaElement(media) {
  media.pause();
  media.removeAttribute('src');
  media.load();
}

async function startPlayback(titleId,preferredId=null,roomPosition=null,debug=false) {
  rooms.beforePlayback(titleId);
  const request=++state.playbackRequest;
  const result = await api(`/api/titles/${titleId}/variants`);
  if(request!==state.playbackRequest) return;
  const playable = orderPlaybackVariants(result.variants.filter(variant => variant.playable && (variant.url || variant.resolve) && (!debug || variant.type==='stalker')),state.qualityPreference,preferredId);
  if (!playable.length) throw new Error('There is no playable stream for this title yet.');
  const title = state.items.find(item => Number(item.id) === Number(titleId)) || (await api(`/api/titles/${titleId}`)).title;
  if(request!==state.playbackRequest) return;
  state.stalkerDebug=debug && state.session?.user?.role==='admin' && title.kind==='channel';
  state.activeTitle = title;
  const kind=presentation(title.kind);
  state.variants = playable;
  state.variantIndex = 0;
  state.playbackAttempts=[];
  const queued=mediaQueue(state.browseItems,title.kind);
  state.mediaQueue=queued.includes(Number(title.id)) ? queued : kind==='video'?[]:[Number(title.id)];
  renderVariantPicker();
  state.pendingSeek = kind==='photo' ? 0 : (Number.isFinite(roomPosition)?Math.max(0,roomPosition):Number(title.position_seconds)||0);
  $('#player').hidden=kind!=='video';
  $('#music-panel').hidden=kind!=='audio';
  $('#photo-viewer').hidden=kind!=='photo';
  $('#photo-viewer').alt=title.title;
  $('#music-caption').textContent=title.title;
  $('#player-quality-picker').hidden=kind!=='video';
  $('#player-diagnostics-toggle').hidden=kind!=='video';
  $('#open-stream').hidden=kind!=='video';
  if(kind!=='video') {
    $('#player-diagnostics').hidden=true;
    $('#player-diagnostics-toggle').setAttribute('aria-expanded','false');
  }
  const mediaIndex=state.mediaQueue.indexOf(Number(title.id));
  for(const [selector,direction] of [['#previous-media',-1],['#next-media',1]]) {
    const button=$(selector);
    button.hidden=kind==='video' || mediaIndex<0;
    button.disabled=adjacentMedia(state.mediaQueue,title.id,direction)==null;
    button.textContent=direction<0 ? (kind==='audio'?'← Previous track':'← Previous photo') : (kind==='audio'?'Next track →':'Next photo →');
  }
  $('#player-title').textContent = title.kind === 'episode' ? `${title.title} · S${title.season || '?'}E${title.episode || '?'}${title.episode_name ? ` · ${title.episode_name}`:''}` : title.title;
  const index = state.seriesEpisodes.findIndex(item => Number(item.id) === Number(titleId));
  $('#previous-episode').hidden = index < 0 || index === state.seriesEpisodes.length - 1;
  $('#next-episode').hidden = index <= 0;
  if (title.kind==='channel' && !state.channelQueue.some(id=>Number(id)===Number(titleId))) state.channelQueue=state.items.filter(item=>item.kind==='channel'&&item.source_count>0).map(item=>item.id);
  $('#previous-channel').hidden=title.kind!=='channel' || state.channelQueue.length<2;
  $('#next-channel').hidden=title.kind!=='channel' || state.channelQueue.length<2;
  $('#player-overlay').hidden = false;
  tvNavigation.enterPlayer();
  if(state.stalkerDebug){$('#player-diagnostics').hidden=false;$('#player-diagnostics-toggle').setAttribute('aria-expanded','true');$('#player-diagnostics-copy').hidden=false;}
  void playVariant();
}

function renderVariantPicker() {
  const picker=$('#player-variant');
  const video=presentation(state.activeTitle?.kind)==='video';
  picker.replaceChildren(...state.variants.map((variant,index)=>new Option(`${video?playbackVariantLabel(variant):(variant.name||'Local file')} · ${variant.type}${variant.group?` · ${variant.group}`:''}`,String(index))));
  picker.disabled=state.variants.length<2;
  picker.value=String(state.variantIndex);
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

function clearPlaybackRecovery() {
  clearTimeout(state.recoveryTimer);
  state.recoveryTimer=null;
}

/** Startup can time out before playback begins; intentional pauses after starting never switch sources. */
function schedulePlaybackRecovery(generation,delay,startup=false) {
  clearPlaybackRecovery();
  state.recoveryTimer=setTimeout(()=>{
    if(generation!==state.playbackGeneration || $('#player-overlay').hidden || (presentation(state.activeTitle?.kind)!=='photo' && currentMedia().ended)) return;
    if(!startup && currentMedia().paused) return;
    failSource(generation,'The stream did not start or has stalled. Try another connection or open it externally.',startup?'startup':'stall');
  },delay);
}

function disposeMedia() {
  const dispose=releaseMedia;
  releaseMedia=()=>{};
  dispose();
}

function failSource(generation,message,code='unknown') {
  if(generation!==state.playbackGeneration || $('#player-overlay').hidden || failedPlaybackGeneration===generation) return;
  failedPlaybackGeneration=generation;
  setPlaybackStatus(generation,'Failed',code);
  clearPlaybackRecovery();
  if(!state.stalkerDebug && state.variantIndex+1<state.variants.length) {nextSource();return;}
  disposeMedia();
  if(presentation(state.activeTitle?.kind)!=='photo') currentMedia().pause();
  $('#player-message').textContent=message;

}

/** An authenticated <img> only decodes the one selected photo in the viewer. */
function preparePhoto(address,generation) {
  const image=$('#photo-viewer');
  const alive=()=>generation===state.playbackGeneration && !$('#player-overlay').hidden;
  const loaded=()=>{
    if(!alive()) return;
    clearPlaybackRecovery();
    $('#player-message').textContent='';
    setPlaybackStatus(generation,'Displaying');
  };
  const failed=()=>{if(alive()) failSource(generation,'This photo could not be displayed. Try another connection or a browser-supported image format.','unsupported');};
  image.addEventListener('load',loaded);
  image.addEventListener('error',failed);
  image.src=address;
  return ()=>{
    image.removeEventListener('load',loaded);
    image.removeEventListener('error',failed);
    image.removeAttribute('src');
  };
}

async function playVariant() {
  const generation = ++state.playbackGeneration;
  failedPlaybackGeneration=-1;
  const item = state.variants[state.variantIndex];
  beginPlaybackAttempt(generation,item);
  const kind=presentation(state.activeTitle?.kind);
  const media=currentMedia();
  const alive=()=>generation===state.playbackGeneration && !$('#player-overlay').hidden;
  clearPlaybackRecovery();
  state.playbackStarted=false;
  state.lastMediaTime=0;
  state.resolvedUrl = null;
  $('#player-message').textContent = item.resolve ? 'Connecting to your provider…' : '';
  $('#player-source').textContent = `${kind==='video'?playbackVariantLabel(item):(item.name||'Local file')} (${state.variantIndex + 1}/${state.variants.length})`;
  $('#player-variant').value=String(state.variantIndex);
  $('#try-next').disabled = state.variants.length < 2;
  disposeMedia();
  resetMediaElement($('#player'));
  resetMediaElement($('#music-player'));
  clearSubtitles();
  $('#photo-viewer').removeAttribute('src');
  let failureStage='provider';
  try {
    const result = item.resolve ? await api(`/api/variants/${item.id}/${state.stalkerDebug?'debug-playback':'resolve'}`, { method:'POST' }) : {url:item.url};
    if(!alive()) return;
    const traceAttempt=currentPlaybackAttempt();
    if(state.stalkerDebug && traceAttempt?.generation===generation) {traceAttempt.trace=result.trace||[];renderPlaybackDiagnostics();}
    const url=result.url;
    if (!alive()) return;
    if (!url) throw new Error('No stream URL was returned.');
    state.resolvedUrl = url;
    const attempt=currentPlaybackAttempt();
    if(attempt?.generation===generation) {
      attempt.format=streamFormat(url);
      try {attempt.mixedContent=location.protocol==='https:' && new URL(url,location.href).protocol==='http:';} catch { /* Invalid URLs fail normally. */ }
    }
    $('#player-message').textContent='Preparing stream…';
    setPlaybackStatus(generation,'Preparing');
    schedulePlaybackRecovery(generation,20000,true);
    failureStage='unsupported';
    if(kind==='photo') {
      if(attempt?.generation===generation) attempt.engine='Image viewer';
      const dispose=preparePhoto(url,generation);
      if(!alive() || failedPlaybackGeneration===generation) dispose();
      else releaseMedia=dispose;
      return;
    }
    const dispose=await prepareMedia(media,url,{
      alive, live:state.activeTitle?.kind==='channel',
      onEngine:name=>{if(attempt?.generation===generation){attempt.engine=name;renderPlaybackDiagnostics();}},
      onDiagnostic:message=>{if(alive()&&state.stalkerDebug&&attempt?.generation===generation){(attempt.engineTrace??=[]).push(message);renderPlaybackDiagnostics();}},
      fatal:(message,code)=>failSource(generation,message,code),
      ready:()=>{
        if(!alive()) return;
        $('#player-message').textContent='';
        setPlaybackStatus(generation,'Starting');
        if(kind==='video') void loadSubtitles(item,generation);
        media.play().catch(error=>{
          if(!alive() || failedPlaybackGeneration===generation) return;
          if(error.name==='NotAllowedError') {clearPlaybackRecovery();$('#player-message').textContent='Press Play to start this stream.';setPlaybackStatus(generation,'Paused','autoplay');}
          else if(error.name!=='AbortError') failSource(generation,'This format could not play in your browser. Try opening the stream externally.','unsupported');
        });
      }
    });
    if(!alive() || failedPlaybackGeneration===generation) dispose();
    else releaseMedia=dispose;
  } catch (error) {
    if (!alive()) return;
    failSource(generation,error instanceof Error ? error.message : 'Could not connect to your provider.',failureStage);
  }
}

function nextSource(manual=false) {
  if (state.variantIndex + 1 >= state.variants.length) {
    if(!manual || state.variants.length<2) {
      clearPlaybackRecovery();
      $('#player-message').textContent = 'None of the available sources could play in this browser. Try a different device or a supported format.';
      return;
    }
    state.variantIndex=-1;
  }
  if(!['channel','photo'].includes(state.activeTitle?.kind)) state.pendingSeek = currentMedia().currentTime || state.pendingSeek;
  state.variantIndex += 1;
  void playVariant();
}

async function updateQualityPreference(select) {
  const previous=state.qualityPreference;
  select.disabled=true;
  try {
    const updated=await api('/api/preferences',{method:'POST',body:{qualityPreference:select.value}});
    state.qualityPreference=updated.qualityPreference;
    for(const selector of ['#player-quality-preference','#settings-quality-preference']) {
      const input=$(selector);if(input) input.value=state.qualityPreference;
    }
    notify('Quality preference saved. It will be used the next time you start a title.');
  } catch(error) {select.value=previous;notify(error.message,true);}
  finally {select.disabled=false;}
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

async function jumpLocalMedia(direction) {
  if(!['music','photo'].includes(state.activeTitle?.kind)) return;
  const next=adjacentMedia(state.mediaQueue,state.activeTitle.id,direction);
  if(next==null) return;
  try {await startPlayback(next);}
  catch(error) {notify(error.message,true);}
}

function closePlayer() {
  void rooms.detach(true);
  state.playbackRequest++;
  state.playbackGeneration++;
  clearPlaybackRecovery();
  disposeMedia();
  if(document.fullscreenElement===$('#player-panel')) void document.exitFullscreen?.();
  state.resolvedUrl = null;
  resetMediaElement($('#player'));
  resetMediaElement($('#music-player'));
  $('#photo-viewer').removeAttribute('src');
  clearSubtitles();
  $('#player-overlay').hidden = true;
  state.activeTitle = null;
  state.variants = [];
  state.mediaQueue = [];
  state.playbackAttempts=[];
  $('#player-diagnostics').hidden=true;
  $('#player-diagnostics-toggle').setAttribute('aria-expanded','false');
  tvNavigation.exitPlayer();
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
  await rooms.detach(true);
  try { await api('/api/logout', { method:'POST' }); } catch { /* Expired sessions may already be gone. */ }
  workers.stopPolling();state.session = null;clearTimeout(state.sourcePollTimer);clearTimeout(state.seriesRefreshTimer);clearTimeout(activityTimer);clearTimeout(updatePollTimer);closePlayer();
  showAuth(false);
});

$('#global-search').addEventListener('input', (event) => {
  state.query = event.target.value;
  state.libraryOffset=0;
  state.liveOffset=0;
  state.playOffset=0;
  state.guideOffset = 0;
  state.detailId = null;
  state.seriesDetail = null;
  clearTimeout(state.seriesRefreshTimer);
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    if (!['live','library','play'].includes(state.page)) navigate('library');
    else renderPage().catch(error => notify(error.message,true));
  }, 250);
});

page.addEventListener('input', event => {
  const search=event.target?.closest?.('[data-folder-filter]');
  if(!search) return;
  const section=search.closest('[data-folder-section]');
  if(!section) return;
  const query=search.value.trim().toLocaleLowerCase();
  section.querySelectorAll('[data-folder-option]').forEach(option=>{
    option.hidden=!option.textContent.toLocaleLowerCase().includes(query);
  });
});

page.addEventListener('change', event => {
  if (event.target?.id === 'source-type') syncSourceForm();
  if (event.target?.matches?.('[data-smart-kind]')) {
    const genre=event.target.closest('form')?.querySelector('[data-smart-genre]');
    if(genre) {genre.disabled=!['all','film','series'].includes(event.target.value);if(genre.disabled) genre.value='';}
  }
  if (event.target?.id === 'library-sort') { state.librarySort=event.target.value;state.libraryOffset=0;void renderPage().catch(error=>notify(error.message,true)); }
  if (event.target?.id === 'settings-quality-preference') void updateQualityPreference(event.target);
  if (event.target?.id === 'autoplay-next') {
    const checkbox=event.target;
    const next=checkbox.checked;
    api('/api/preferences',{method:'POST',body:{autoplayNext:next}}).then(()=>{state.autoplayNext=next;notify(next?'Next-episode autoplay enabled.':'Next-episode autoplay disabled.');})
      .catch(error=>{checkbox.checked=state.autoplayNext;notify(error.message,true);});
  }
});
page.addEventListener('error', event => { if (event.target?.matches?.('.media-art img')) event.target.hidden=true; }, true);

page.addEventListener('submit', async event => {
  const form = event.target;
  if(form.dataset.requestForm)return requests.submit(event);
  if(form.dataset.roomForm) return rooms.submit(event,()=>space.render('community'));
  if(form.dataset.workerForm) return workers.submit(event);
  if(form.dataset.spaceForm) return space.submit(event);
  if(form.id==='smart-collection-create-form' || form.dataset.smartRulesForm) {
    event.preventDefault();
    const creating=form.id==='smart-collection-create-form';
    const name=creating?String(new FormData(form).get('name')||'').trim():'';
    if(creating && (!name || name.length>70)) return notify('Enter a Smart Collection name of up to 70 characters.',true);
    const submit=form.querySelector('button[type=submit]');
    submit.disabled=true;
    try {
      const rules=smartRulesFromForm(form);
      if(creating) await api('/api/collections',{method:'POST',body:{name,mode:'smart',rules}});
      else await api(`/api/collections/${form.dataset.smartRulesForm}/rules`,{method:'PATCH',body:{rules}});
      notify(creating?'Smart Collection created. Its contents update automatically.':'Smart Collection rules updated.');
      await renderPage();
    } catch(error) {notify(error.message,true);submit.disabled=false;}
    return;
  }
  if(form.id==='collection-create-form' || form.dataset.collectionRenameForm) {
    event.preventDefault();
    const name=String(new FormData(form).get('name') || '').trim();
    if(!name || name.length>70) return notify('Enter a collection name of up to 70 characters.',true);
    const submit=form.querySelector('button[type=submit]');
    submit.disabled=true;
    try {
      if(form.id==='collection-create-form') await api('/api/collections',{method:'POST',body:{name}});
      else await api(`/api/collections/${form.dataset.collectionRenameForm}`,{method:'PATCH',body:{name}});
      notify(form.id==='collection-create-form'?'Collection created. Add titles from their Library detail pages.':'Collection renamed.');
      await renderPage();
    } catch(error) {notify(error.message,true);submit.disabled=false;}
    return;
  }
  if (['library-pager','live-pager','play-pager'].includes(form.id)) {
    event.preventDefault();
    const requested=Number(new FormData(form).get('page'));
    if(!Number.isSafeInteger(requested) || requested<1 || requested>Number(form.dataset.pages)) return notify('Enter a valid page number.',true);
    const scope=form.id.split('-')[0];
    state[`${scope}Offset`]=(requested-1)*Number(form.dataset.limit);
    try {await renderPage();window.scrollTo({top:0,behavior:'instant'});} catch(error) {notify(error.message,true);}
    return;
  }
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
  if(target.dataset.stalkerDebug){try{await startPlayback(Number(target.dataset.stalkerDebug),null,null,true);}catch(error){notify(error.message,true);}return;}
  if(target.hasAttribute('data-lineup-rebuild')){try{target.disabled=true;await api('/api/system/live-lineup',{method:'POST'});await refreshActivity();}catch(error){notify(error.message,true);target.disabled=false;}return;}
  if(target.dataset.maintenanceStart){try{target.disabled=true;await api('/api/system/metadata',{method:'POST',body:{kind:target.dataset.maintenanceStart,retry:$('#maintenance-retry')?.checked===true}});await refreshActivity();}catch(error){notify(error.message,true);target.disabled=false;}return;}
  if(target.hasAttribute('data-maintenance-cancel')){try{await api('/api/system/metadata/cancel',{method:'POST'});await refreshActivity();}catch(error){notify(error.message,true);}return;}
  if(target.hasAttribute('data-maintenance-refresh'))return refreshActivity();
  if(target.hasAttribute('data-open-requests')){state.requestView=true;state.detailId=null;state.seriesDetail=null;state.collectionOverview=false;state.collectionId=0;return renderPage();}
  if(target.dataset.requestAction)return requests.click(event,renderPage);
  if(target.dataset.roomAction) return rooms.click(event,()=>space.render('community'));
  if(target.dataset.workerAction) return workers.click(event);
  if(target.dataset.spaceAction) return space.click(event);
  if(target.dataset.game) {
    const title=target.closest('article').querySelector('h3').textContent;
    page.innerHTML=heading(title,'','<button class="button button-quiet" data-close-game>Back to games</button>')+'<iframe class="game-frame" title="EmulatorJS" allow="autoplay; fullscreen; gamepad" allowfullscreen src="/game.html?id='+Number(target.dataset.game)+'"></iframe>';
    return;
  }
  if(target.hasAttribute('data-close-game')) return renderGames();
  if(target.hasAttribute('data-library-collections')) {
    state.detailId=null;state.seriesDetail=null;state.collectionId=0;state.collectionName='';state.collectionOverview=true;state.libraryOffset=0;state.libraryGenre='';
    state.page='library';$('#page-title').textContent='Library';document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('selected',el.dataset.page==='library'));
    return renderPage();
  }
  if(target.hasAttribute('data-collection-exit')) {state.collectionId=0;state.collectionName='';state.collectionOverview=false;state.libraryOffset=0;return renderPage();}
  if(target.hasAttribute('data-collection-back')) {state.collectionId=0;state.collectionName='';state.collectionOverview=true;state.libraryOffset=0;return renderPage();}
  if(target.dataset.collectionOpen) {
    state.collectionId=Number(target.dataset.collectionOpen);state.collectionName=target.dataset.name || 'Collection';state.collectionMode=target.dataset.mode==='smart'?'smart':'manual';state.collectionOverview=false;state.libraryOffset=0;state.libraryGenre='';state.libraryView='all';state.kind='all';return renderPage();
  }
  if(target.dataset.collectionDelete) {
    if(!window.confirm(`Delete “${target.dataset.name}”? Your media files will not be deleted.`)) return;
    try {await api(`/api/collections/${target.dataset.collectionDelete}`,{method:'DELETE'});notify('Collection deleted. Your media remains available.');await renderPage();}
    catch(error){notify(error.message,true);}return;
  }
  if(target.dataset.collectionMembership) {
    target.disabled=true;
    try {
      const id=target.dataset.collectionMembership,titleId=Number(target.dataset.titleId),include=target.dataset.next==='1';
      await api(include?`/api/collections/${id}/items`:`/api/collections/${id}/items/${titleId}`,include?{method:'POST',body:{titleId}}:{method:'DELETE'});
      notify(include?'Added to collection.':'Removed from collection.');await renderPage();
    }catch(error){target.disabled=false;notify(error.message,true);}return;
  }
  if (target.hasAttribute('data-continue')) {state.libraryView='continue';state.librarySort='activity';state.libraryOffset=0;return navigate('library');}
  if (target.dataset.page) return navigate(target.dataset.page);
  if(target.hasAttribute('data-home-watchlist')){state.libraryView='watchlist';state.kind='all';state.libraryGenre='';state.collectionId=0;state.collectionOverview=false;state.libraryOffset=0;return navigate('library');}
  if(target.hasAttribute('data-home-live-favourites')){state.liveView='favourites';state.liveGroup='all';state.liveCountry='all';state.liveOffset=0;return navigate('live');}
  if(target.dataset.liveView){state.liveView=target.dataset.liveView;state.liveOffset=0;state.liveGroup='all';return renderPage();}
  if(target.dataset.playView){state.playView=target.dataset.playView;state.playOffset=0;return renderPage();}
  if(target.dataset.watchlist){try{await api(`/api/titles/${target.dataset.watchlist}/watchlist`,{method:'POST',body:{include:target.dataset.next==='1'}});await renderPage();}catch(error){notify(error.message,true);}return;}
  if (target.dataset.libraryView) {state.libraryView=target.dataset.libraryView;state.libraryOffset=0;if(state.libraryView==='continue') state.librarySort='activity';return renderPage();}
  if (target.dataset.catalogueMove) {
    const scope=target.dataset.catalogueMove;
    if (!['library','live','play'].includes(scope)) return;
    state[`${scope}Offset`]=Math.max(0,state[`${scope}Offset`]+Number(target.dataset.direction)*(scope==='library'?48:60));
    try {await renderPage();window.scrollTo({top:0,behavior:'instant'});}catch(error){notify(error.message,true);}
    return;
  }
  if (target.dataset.guideView) {const opening=target.dataset.guideView==='open';if(opening){state.guideChannelIds=state.items.map(item=>Number(item.id)).filter(id=>Number.isSafeInteger(id)&&id>0);state.guideDay=0;state.guideSlot=Math.floor(new Date().getHours()/6)*6;}else state.guideChannelIds=[];state.guideView=opening;state.guideOffset=0;state.guideRequest++;return renderPage();}
  if (target.dataset.guideCountry !== undefined) { state.guideCountry=target.dataset.guideCountry;state.guideOffset=0;return renderPage(); }
  if (target.dataset.guideSlot !== undefined) {state.guideSlot=Number(target.dataset.guideSlot);return renderPage();}
  if (target.dataset.guideDay !== undefined) {state.guideDay=Math.max(0,Math.min(6,state.guideDay+Number(target.dataset.guideDay)));return renderPage();}
  if (target.hasAttribute('data-guide-now')) {state.guideDay=0;state.guideSlot=Math.floor(new Date().getHours()/6)*6;return renderPage();}
  if (target.dataset.guidePage !== undefined) {state.guideOffset=Math.max(0,state.guideOffset+Number(target.dataset.guidePage)*30);return renderPage();}
  if (target.dataset.guideProgramme !== undefined) {
    const row=state.items.find(item=>String(item.id)===target.dataset.guideProgramme);
    const programme=row?.guide?.programmes[Number(target.dataset.programmeIndex)];
    const panel=$('#guide-programme-details');
    if (programme && panel) {
      panel.hidden=false;
      panel.innerHTML=`<strong>${esc(programme.title)}</strong><small>${esc(row.title)} · ${esc(localGuideTime(programme.start))} – ${esc(localGuideTime(programme.end))}</small><p>${esc(programme.description || 'No description provided by this guide.')}</p>`;
      panel.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
    return;
  }
  if (target.dataset.country) { state.liveCountry=target.dataset.country; state.liveGroup='all';state.liveOffset=0; return renderPage(); }
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
    if (!state.detailId && !state.seriesDetail && state.page==='library') state.libraryScroll=window.scrollY;
    else if (state.page!=='library') state.libraryScroll=0;
    rememberPage('library');
    state.seriesDetail = Number(target.dataset.series);
    state.detailId = null;
    state.page = 'library';
    $('#page-title').textContent = 'Library';
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('selected',el.dataset.page === 'library'));
    window.scrollTo({top:0,behavior:'instant'});
    return renderPage();
  }
  if (target.hasAttribute('data-series-back')) { state.seriesDetail = null; clearTimeout(state.seriesRefreshTimer);await renderPage();window.scrollTo({top:state.libraryScroll,behavior:'instant'});return; }
  if (target.dataset.episodeDetail) {state.detailId=Number(target.dataset.episodeDetail);clearTimeout(state.seriesRefreshTimer);return renderPage();}
  if (target.dataset.detail || target.dataset.cardDetail) {
    if (!state.detailId && !state.seriesDetail && state.page==='library') state.libraryScroll=window.scrollY;
    else if (state.page!=='library') state.libraryScroll=0;
    rememberPage('library');
    state.detailId=Number(target.dataset.detail || target.dataset.cardDetail);
    state.seriesDetail=null;
    state.page='library';
    $('#page-title').textContent='Library';
    document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('selected',el.dataset.page==='library'));
    window.scrollTo({top:0,behavior:'instant'});
    return renderPage();
  }
  if (target.hasAttribute('data-detail-back')) {state.detailId=null;const returnToSeries=Boolean(state.seriesDetail);await renderPage();if(!returnToSeries)window.scrollTo({top:state.libraryScroll,behavior:'instant'});return;}
  if (target.dataset.seriesRefresh) {
    try { await api(`/api/titles/${target.dataset.seriesRefresh}/episodes/refresh`,{method:'POST'}); notify('Retrieving available episodes.'); await renderPage(); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.dataset.metadataRefresh) {
    const titleId=target.dataset.metadataRefresh;
    target.disabled=true;target.textContent='Fetching details…';
    try {
      const result=await api(`/api/titles/${titleId}/metadata/refresh`,{method:'POST'});
      notify(result.updated?`Updated details from ${result.providers} provider${result.providers===1?'':'s'}.`:'No additional provider details were available for this title.');
      await renderPage();
    } catch(error) {target.disabled=false;target.textContent='Fetch metadata';notify(error.message,true);}
    return;
  }
  if(target.dataset.providerGuideRefresh){target.disabled=true;target.textContent='Fetching provider guide…';try{await api(`/api/titles/${target.dataset.providerGuideRefresh}/guide`,{method:'POST'});await showLiveGuide(target.dataset.providerGuideRefresh);}catch(error){notify(error.message,true);target.disabled=false;target.textContent='Fetch provider guide';}return;}
  if (target.dataset.guideMap) return showGuideMappingEditor(target.dataset.guideMap);
  if (target.dataset.guideUnmap) {
    const titleId=target.dataset.guideUnmap;
    try { await api(`/api/titles/${titleId}/guide/mapping`,{method:'DELETE'}); notify('Automatic guide matching restored.'); await showLiveGuide(titleId); await showGuideMappingEditor(titleId); }
    catch (error) { notify(error.message,true); }
    return;
  }
  if (target.dataset.guide) return showLiveGuide(target.dataset.guide);
  if (target.hasAttribute('data-guide-close')) {const guide=$('#guide-panel');if(guide){guide.hidden=true;guide.innerHTML='';}return;}
  if (target.dataset.kind) { state.kind = target.dataset.kind; if(!['all','film','series'].includes(state.kind)) state.libraryGenre='';state.libraryOffset=0; return renderPage(); }
  if (target.dataset.libraryGenre !== undefined) {state.libraryGenre=target.dataset.libraryGenre;state.libraryOffset=0;return renderPage();}
  if (target.dataset.group) { state.liveGroup = target.dataset.group;state.liveOffset=0; return renderPage(); }
  if (target.dataset.settings) { state.settingsTab = target.dataset.settings; return renderPage(); }
  if (target.id === 'check-update') {
    target.disabled=true;target.textContent='Checking GitHub…';
    try {
      latestUpdateCheck=await api('/api/system/update/check');
      const status=await api('/api/system/update/status');
      const panel=$('#updater-panel');
      if(panel) panel.outerHTML=updaterPanel(status);
    } catch(error) {notify(error.message,true);target.disabled=false;target.textContent='Check GitHub';}
    return;
  }
  if (target.id === 'install-update') {
    if(!latestUpdateCheck?.available) return;
    if(!window.confirm(`Install Hearthwave ${latestUpdateCheck.latestVersion} from GitHub commit ${latestUpdateCheck.latestSha.slice(0,12)}? The server will briefly restart. If startup fails, the updater will try to restore the previous version.`)) return;
    target.disabled=true;target.textContent='Preparing update…';
    try {
      await api('/api/system/update/install',{method:'POST',body:{sha:latestUpdateCheck.latestSha}});
      updateStartedHere=true;updateWaitStarted=Date.now();latestUpdateCheck=null;
      const status=await api('/api/system/update/status');
      const panel=$('#updater-panel');
      if(panel) panel.outerHTML=updaterPanel(status);
      scheduleUpdatePolling();
      notify('Update accepted. The existing server remains running while files are downloaded and checked.');
    } catch(error) {notify(error.message,true);target.disabled=false;target.textContent='Install verified update';}
    return;
  }
  if (target.id === 'download-backup') {
    target.disabled = true;
    target.textContent = 'Preparing backup…';
    try {
      const response = await fetch('/api/system/backup', { method:'POST', credentials:'same-origin', headers:{ 'X-CSRF-Token':state.session.csrf } });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || `Backup failed (${response.status}).`);
      }
      const file = await response.blob();
      const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'hearthwave-backup.tar.gz';
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notify('Backup ready for download. Store the archive securely; it includes your encryption key.');
    } catch (error) { notify(error.message, true); }
    finally { target.disabled = false;target.textContent = 'Download backup (.tar.gz)'; }
    return;
  }
  if (target.dataset.selectFiltered !== undefined) {
    const section=target.closest('[data-folder-section]');
    if(!section) return;
    const search=section.querySelector('[data-folder-filter]');
    const query=search?.value.trim().toLocaleLowerCase() || '';
    section.querySelectorAll('[data-folder-option]').forEach(option=>{
      if(!option.hidden && (!query || option.textContent.toLocaleLowerCase().includes(query))) {
        const checkbox=option.querySelector('input[name="category"]');
        if(checkbox) checkbox.checked=true;
      }
    });
    return;
  }
  if (target.dataset.play) {
    try { await startPlayback(target.dataset.play,target.dataset.preferred || null); }
    catch (error) { notify(error.message,true); }
  }
  if (target.dataset.favouriteMove) {
    try { await api('/api/favourites/' + target.dataset.favouriteMove + '/' + target.dataset.direction,{method:'POST'}); await renderPage(); }
    catch(error){notify(error.message,true);}
    return;
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
  if (target.dataset.cancelScan) {
    try {await api(`/api/sources/${target.dataset.cancelScan}/cancel`,{method:'POST'});notify('Cancellation requested. The current provider request may take a few seconds to finish; previously indexed items will be kept.');await refreshSourceStatus();}
    catch(error){notify(error.message,true);}
    return;
  }
  if (target.id === 'refresh-sources') return refreshSourceStatus();
});

document.querySelectorAll('.sidebar [data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
$('#brand-link').addEventListener('click', event => { event.preventDefault(); navigate('home'); });
$('#close-player').addEventListener('click', closePlayer);
$('#try-next').addEventListener('click',()=>nextSource(true));
$('#player-variant').addEventListener('change',event=>{
  const index=Number(event.target.value);
  if(!Number.isSafeInteger(index) || index<0 || index>=state.variants.length || index===state.variantIndex) return;
  if(!['channel','photo'].includes(state.activeTitle?.kind)) state.pendingSeek=currentMedia().currentTime || state.pendingSeek;
  state.variantIndex=index;
  void playVariant();
});
$('#player-quality-preference').addEventListener('change',event=>{void updateQualityPreference(event.target);});
$('#player-subtitles').addEventListener('change', event=>setSubtitle(Number(event.target.value)));
$('#previous-channel').addEventListener('click',()=>jumpChannel(-1));
$('#next-channel').addEventListener('click',()=>jumpChannel(1));
$('#previous-media').addEventListener('click',()=>jumpLocalMedia(-1));
$('#next-media').addEventListener('click',()=>jumpLocalMedia(1));
$('#previous-episode').addEventListener('click', () => jumpEpisode(1));
$('#next-episode').addEventListener('click', () => jumpEpisode(-1));
$('#open-stream').addEventListener('click', () => {
  if (state.resolvedUrl && /^https?:\/\//i.test(state.resolvedUrl)) window.open(state.resolvedUrl, '_blank', 'noopener,noreferrer');
  else notify('The local stream is available only inside Hearthwave.');
});
$('#player-diagnostics-toggle').addEventListener('click',()=>{
  const panel=$('#player-diagnostics');
  panel.hidden=!panel.hidden;
  $('#player-diagnostics-toggle').setAttribute('aria-expanded',String(!panel.hidden));
  $('#player-diagnostics-copy').hidden=!state.stalkerDebug&&!navigator.clipboard?.writeText;
  renderPlaybackDiagnostics();
});
async function checkStalkerHeaders(method){
  const attempt=currentPlaybackAttempt();
  if(!state.stalkerDebug||state.session?.user?.role!=='admin'||!attempt||attempt.headerBusy||!['Failed','Paused'].includes(attempt.status)) return;
  // Stop the failed/paused media request before asking the provider for a fresh link.
  disposeMedia();
  state.resolvedUrl=null;
  resetMediaElement($('#player'));
  clearPlaybackRecovery();
  attempt.headerBusy=true;
  const prior=(attempt.headerTrace||[]).filter(line=>!line.startsWith('Checking '));
  attempt.headerTrace=[...prior,'Checking fresh provider link with '+method+'…'];
  renderPlaybackDiagnostics();
  try {
    const result=await api('/api/variants/'+attempt.variantId+'/debug-headers',{method:'POST',body:{origin:location.origin,method}});
    attempt.headerTrace=[...prior,...(result.trace||['No header information returned.'])];
  } catch {attempt.headerTrace=[...prior,'Header check request failed; no stream was relayed.'];}
  finally {attempt.headerBusy=false;if(currentPlaybackAttempt()===attempt)renderPlaybackDiagnostics();}
}
$('#stalker-header-check').addEventListener('click',()=>checkStalkerHeaders('HEAD'));
$('#stalker-get-check').addEventListener('click',()=>checkStalkerHeaders('GET'));
$('#stalker-compare-check').addEventListener('click',()=>checkStalkerHeaders('COMPARE'));
$('#player-diagnostics-copy').addEventListener('click',()=>{
  const report=playbackReport(state.playbackAttempts,browserPlaybackCapabilities($('#player')))+(state.stalkerDebug?'\n'+clientDebugSnapshot():'');
  const copy=navigator.clipboard?.writeText?.(report);
  if(!copy) {if(state.stalkerDebug){const field=$('#stalker-debug-report');field.value=report;field.focus();field.select();return notify('Select and copy the report manually.');}return notify('Clipboard access is not available on this device.',true);}
  Promise.resolve(copy).then(()=>notify('Safe playback report copied. Provider URLs and tokens were excluded.')).catch(()=>notify('Clipboard access is not available on this device.',true));
});
for(const media of [$('#player'),$('#music-player')]) {
  const active=()=>!$('#player-overlay').hidden && currentMedia()===media;
  media.addEventListener('error',()=>{
    if(!active() || !state.resolvedUrl || currentPlaybackAttempt()?.engine==='HLS.js') return;
    const failure=nativeMediaFailure(media.error?.code);
    failSource(state.playbackGeneration,failure.message,failure.code);
  });
  media.addEventListener('playing',()=>{
    if(!active()) return;
    state.playbackStarted=true;
    clearPlaybackRecovery();
    $('#player-message').textContent='';
    setPlaybackStatus(state.playbackGeneration,'Playing');
  });
  for(const eventName of ['waiting','stalled']) media.addEventListener(eventName,()=>{
    if(active() && state.playbackStarted && !media.paused) {
      setPlaybackStatus(state.playbackGeneration,'Buffering');
      if(!state.recoveryTimer) schedulePlaybackRecovery(state.playbackGeneration,25000);
    }
  });
  media.addEventListener('pause',()=>{
    if(!active() || !state.playbackStarted) return;
    clearPlaybackRecovery();
    if(state.playbackStarted && ['Playing','Buffering'].includes(currentPlaybackAttempt()?.status)) setPlaybackStatus(state.playbackGeneration,'Paused');
  });
  media.addEventListener('loadedmetadata',()=>{
    if(!active()) return;
    if(state.pendingSeek>5 && Number.isFinite(media.duration) && state.pendingSeek<media.duration-5) {
      try {media.currentTime=state.pendingSeek;} catch { /* Live streams may not allow seeking. */ }
    }
    state.pendingSeek=0;
  });
  media.addEventListener('timeupdate',()=>{
    if(!active()) return;
    if(Math.abs(media.currentTime-state.lastMediaTime)>0.25) {
      state.lastMediaTime=media.currentTime;
      if(state.playbackStarted) {clearPlaybackRecovery();if(currentPlaybackAttempt()?.status==='Buffering') setPlaybackStatus(state.playbackGeneration,'Playing');}
    }
    if(!state.activeTitle || state.activeTitle.kind==='channel' || Date.now()-state.lastProgressSave<30000) return;
    state.lastProgressSave=Date.now();
    api(`/api/titles/${state.activeTitle.id}/progress`,{method:'POST',body:{seconds:media.currentTime}}).catch(()=>{});
  });
  media.addEventListener('ended',()=>{
    if(!active()) return;
    if(state.activeTitle?.kind==='music') void jumpLocalMedia(1);
    else if(state.autoplayNext && state.activeTitle?.kind==='episode') void jumpEpisode(-1);
  });
}
$('#player-fullscreen').addEventListener('click',()=>{
  const target=$('#player-panel');
  if(document.fullscreenElement) void document.exitFullscreen?.();
  else target.requestFullscreen?.().catch(()=>notify('Fullscreen is not available on this device.',true));
});
function tvBack(inPlayer) {
  if (inPlayer) return closePlayer();
  if(state.page==='library'&&state.requestView){state.requestView=false;void renderPage().catch(error=>notify(error.message,true));return;}
  if (state.detailId && $('[data-detail-back]')) return $('[data-detail-back]').click();
  if (state.seriesDetail && $('[data-series-back]')) return $('[data-series-back]').click();
  if(state.page==='library' && state.collectionId) {state.collectionId=0;state.collectionName='';state.collectionOverview=true;state.libraryOffset=0;void renderPage().catch(error=>notify(error.message,true));return;}
  if(state.page==='library' && state.collectionOverview) {state.collectionOverview=false;void renderPage().catch(error=>notify(error.message,true));return;}
  if (state.guideView) {state.guideView=false;state.guideRequest++;void renderPage().catch(error=>notify(error.message,true));return;}
  const guide=$('#guide-panel');
  if (guide && !guide.hidden) {guide.hidden=true;guide.innerHTML='';return;}
  if (pageHistory.length) return navigate(pageHistory.pop(), false);
  if (state.page!=='home') return navigate('home',false);
}
const tvNavigation = installTvNavigation({
  onBack: tvBack,
  onChannel(direction) {
    if (state.activeTitle?.kind !== 'channel' || state.channelQueue.length < 2) return false;
    void jumpChannel(direction);
    return true;
  },
});

try {
  state.session = await api('/api/session');
  if (state.session.user) showShell(); else showAuth(state.session.needsSetup);
} catch (error) { showAuth(false); $('#auth-error').textContent = error.message; }
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
