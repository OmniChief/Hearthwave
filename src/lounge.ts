import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { MediaKind, User } from './model.ts';
import { hasUsers, listTitles, getTitleDetail, listVariants, getVariant, getSource, listSeriesEpisodes, storedGuide, listCollections, ownedCollection, createCollection, setCollectionMembership, setFavourite, setWatchlisted, saveProgress, getUserPreferences, setUserPreferences, dashboardStats, db } from './db.ts';
import { resolveProviderStream, debugStalkerStream } from './adapters/providers.ts';
import { libraryGenres } from './library-genres.ts';
import { liveGenres } from './catalogue.ts';
import { qualityPreferences, type QualityPreference } from './quality.ts';
import type { LoungeCall } from './lounge-features.ts';

type Identity={user:User;csrf:string;tokenHash:string};
type Services={
  session:(req:IncomingMessage)=>Identity|null;
  login:(req:IncomingMessage,values:Record<string,unknown>)=>User;
  issueSession:(req:IncomingMessage,res:ServerResponse,user:User)=>string;
  logout:(req:IncomingMessage,res:ServerResponse,hash:string)=>void;
  refreshEpisodes:(id:number)=>void;
  episodeStatus:(id:number)=>{status:string;processed:number;total:number;episodes:number;error:string}|undefined;
  activity:()=>{busy:boolean};
  version:string;
  call:LoungeCall;
  backup:()=>Promise<void>;
};
type Kind=MediaKind|'library'|'all';
type View='all'|'favourites'|'watchlist'|'continue';
type Entry={id:number;kind:MediaKind;title:string;artwork?:string;year?:number;season?:number;episode?:number;episode_name?:string;description?:string;position_seconds?:number;favourite?:number;watchlisted?:number;source_count?:number;epg_backed?:number;source_types?:string;genres?:string;rating?:number;duration_seconds?:number;live_genre?:string};
const kinds:Kind[]=['library','all','film','series','episode','channel','music','photo','game'];
const kindNames:Record<Kind,string>={all:'Everything',library:'Your library',film:'Films',series:'Series',episode:'Episodes',channel:'Live television',music:'Music',photo:'Photos',game:'Games'};
const views:View[]=['all','favourites','watchlist','continue'];
const esc=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const query=(values:Record<string,string|number>)=>'/tv?'+new URLSearchParams(Object.entries(values).map(([k,v])=>[k,String(v)])).toString();
const idOf=(value:unknown)=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:0;};
const pageNo=(value:unknown)=>Math.max(0,Math.min(10000,Math.floor(Number(value)||0)));
const href=(url:string,title:string,cls='chip')=>'<a class="'+esc(cls)+'" href="'+esc(url)+'">'+esc(title)+'</a>';
const hidden=(key:string,value:unknown)=>'<input type="hidden" name="'+esc(key)+'" value="'+esc(value)+'">';
function post(token:string,operation:string,fields:Record<string,string|number>,label:string,cls='smallform'){
  return '<form class="'+esc(cls)+'" action="/tv/submit" method="post">'+hidden('csrf',token)+hidden('op',operation)+Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')+'<input class="commit" type="submit" value="'+esc(label)+'"></form>';
}
function select(name:string,entries:Array<[string,string]>,selected:string){
  return '<select name="'+esc(name)+'">'+entries.map(([value,label])=>'<option value="'+esc(value)+'"'+(value===selected?' selected="selected"':'')+'>'+esc(label)+'</option>').join('')+'</select>';
}
function internalReturn(value:unknown):string{
  if(typeof value!=='string'||value.length>700||!value.startsWith('/tv?'))return '/tv';
  try{const u=new URL(value,'http://hearthwave.invalid');return u.origin==='http://hearthwave.invalid'&&u.pathname==='/tv'?u.pathname+u.search:'/tv';}catch{return '/tv';}
}
// Compact, validated navigation history travels with links and forms. No client storage,
// browser history API, server sessions or extra requests are needed for Back.
type Navigation={route:string;trail:string[];fallback?:string};
function cleanRoute(value:unknown):string{
  if(typeof value!=='string'||value.length>1800||!/^\/tv(?:[?#]|$)/.test(value))return '';
  try{
    const u=new URL(value,'http://hearthwave.invalid');
    if(u.origin!=='http://hearthwave.invalid'||u.pathname!=='/tv')return '';
    u.searchParams.delete('nav');u.searchParams.delete('back');
    if(!/^#lounge-(?:focus|item)-[\d-]+$/.test(u.hash))u.hash='';
    return u.pathname+u.search+u.hash;
  }catch{return '';}
}
function encodeTrail(entries:string[]):string{
  const list=entries.map(cleanRoute).filter(Boolean).slice(-8);
  while(list.length){
    const value=Buffer.from(JSON.stringify(list),'utf8').toString('base64url');
    if(value.length<=2200)return value;
    list.shift();
  }
  return '';
}
function decodeTrail(value:string|null):string[]{
  if(!value||value.length>2200||! /^[A-Za-z0-9_-]+$/.test(value))return [];
  try{
    const parsed:unknown=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!Array.isArray(parsed)||parsed.length>8)return [];
    return parsed.map(cleanRoute).filter(Boolean);
  }catch{return [];}
}
function pushRoute(trail:string[],route:string):string[]{
  const clean=cleanRoute(route);
  if(!clean)return trail.slice();
  const result=trail.slice();
  if(result[result.length-1]?.split('#')[0]===clean.split('#')[0])result.pop();
  result.push(clean);
  return decodeTrail(encodeTrail(result));
}
function carry(route:string,trail:string[]):string{
  const clean=cleanRoute(route)||'/tv',u=new URL(clean,'http://hearthwave.invalid'),token=encodeTrail(trail);
  if(token)u.searchParams.set('nav',token);
  return u.pathname+u.search+u.hash;
}
function backDestination(n:Navigation):string{
  if(n.trail.length)return carry(n.trail[n.trail.length-1],n.trail.slice(0,-1));
  if(n.fallback&&cleanRoute(n.fallback)&&cleanRoute(n.fallback)!==n.route)return cleanRoute(n.fallback);
  return n.route&&n.route!=='/tv'&&n.route!=='/tv?screen=home'?'/tv':'';
}
function decorateNavigation(html:string,n:Navigation):string{
  const previous=backDestination(n);
  let sequence=0;const used=new Set<string>();
  // Only trusted server-generated anchor tags are rewritten. Route validation
  // excludes media addresses, external sites and the desktop interface.
  html=html.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>/gi,(tag:string,encoded:string)=>{
    const target=cleanRoute(encoded.replace(/&amp;/g,'&'));
    if(!target)return tag;
    if(/\breturn-target\b/.test(tag)){
      return tag.replace('href="'+encoded+'"','href="'+esc(previous||'/tv')+'"');
    }
    const url=new URL(target,'http://hearthwave.invalid'),id=url.searchParams.get('screen')==='item'?idOf(url.searchParams.get('id')):0;
    let focus=id?'lounge-item-'+id:'lounge-focus-'+(++sequence);
    if(used.has(focus))focus+='-'+(++sequence);
    used.add(focus);
    const origin=n.route?n.route.split('#')[0]+'#'+focus:'';
    const history=target.split('#')[0]===n.route.split('#')[0]?n.trail:pushRoute(n.trail,origin);
    return tag.replace('href="'+encoded+'"','id="'+focus+'" href="'+esc(carry(target,history))+'"');
  });
  // A search/filter submission is also a navigation step. POST mutations carry
  // the originating GET route separately so Back never replays a submission.
  html=html.replace(/<form\b[^>]*\baction="\/tv"[^>]*>/gi,tag=>tag+hidden('nav',encodeTrail(pushRoute(n.trail,n.route))));
  html=html.replace(/<form\b[^>]*\baction="\/tv\/submit"[^>]*>[\s\S]*?<\/form>/gi,form=>{
    const id=/<input type="hidden" name="id" value="(\d+)">/.exec(form)?.[1];
    const anchor=id?'lounge-item-'+id:'';
    const origin=n.route&&anchor&&used.has(anchor)?n.route.split('#')[0]+'#'+anchor:n.route;
    return form.replace(/^[^>]+>/,tag=>tag+hidden('nav',encodeTrail(n.trail))+hidden('route',origin));
  });
  return html;
}

function imageUrl(value:unknown):string{
  if(typeof value!=='string'||value.length>4096)return '';
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
function respond(res:ServerResponse,code:number,html:string){
  res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' http: https:; media-src 'self' http: https:; connect-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'"});
  res.end(html);
}
const navItems=[['home','Home','/tv'],['library','Library',query({screen:'browse',kind:'library'})],['live','Live',query({screen:'browse',kind:'channel'})],['play','Play',query({screen:'browse',kind:'game'})],['create','Create',query({screen:'create'})],['community','Community',query({screen:'community'})],['my-space','My Space',query({screen:'my-space'})],['saved','Collections',query({screen:'collections'})],['settings','Settings',query({screen:'settings'})]];
function frame(res:ServerResponse,user:User|null,section:string,heading:string,content:string,status=200,navigation?:Navigation){
  const rail=user?'<td id="rail" valign="top"><div class="railcaption">YOUR WORLD</div>'+navItems.map(([key,label,path])=>href(path,label,'railitem'+(section===key?' active':''))).join('')+'<div class="railfooter">'+esc(user.username)+'</div></td>':'';
  const back=navigation?backDestination(navigation):'';
  const search=user?'<form class="global-search" action="/tv" method="get">'+hidden('screen','browse')+hidden('kind','all')+'<input type="text" name="q" maxlength="120" aria-label="Search your entertainment"><input class="commit" type="submit" value="Search"></form>':'';
  const backButton=back?'<a id="lounge-back" class="chip backbutton" href="'+esc(back)+'">&#8592; Back</a>':'';
  let html='<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+esc(heading)+' | Hearthwave</title><link rel="stylesheet" type="text/css" href="/lounge.css?v=0342"><script type="text/javascript" src="/lounge-keys.js?v=0360" defer="defer"></script></head><body><div id="screen"><div id="mast"><a class="wordmark" href="/tv"><span class="emblem">&#9672;</span> hearthwave<span class="accent">.</span></a>'+search+'<span class="edition">YOUR ENTERTAINMENT &nbsp; / &nbsp; TV</span></div><table class="shell" cellpadding="0" cellspacing="0"><tr>'+rail+'<td id="stage" valign="top"><div class="heading"><h1>'+esc(heading)+'</h1><!--LOUNGE_BACK--></div>'+content+'</td></tr></table><div class="footer">Move with arrows &nbsp; &middot; &nbsp; OK to select &nbsp; &middot; &nbsp; Back to return <span>'+href('/?modern=1','Desktop interface','plain')+'</span></div></div></body></html>';
  if(navigation)html=decorateNavigation(html,navigation);
  respond(res,status,html.replace('<!--LOUNGE_BACK-->',backButton));
}
export function loungeError(res:ServerResponse,status:number,user:User|null,message:string,navigation?:Navigation){
  frame(res,user,'','Something went wrong','<div class="notice">'+esc(message)+'</div><p>'+href('/tv','Return home')+'</p>',status,navigation);
}

function redirect(res:ServerResponse,path:string){res.writeHead(303,{'Location':path,'Cache-Control':'no-store'});res.end();}
async function formData(req:IncomingMessage):Promise<URLSearchParams>{
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))throw new Error('Unsupported form encoding.');
  let length=0;const parts:Buffer[]=[];
  for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>32768)throw new Error('Form exceeds the limit.');parts.push(b);}
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}
function requestHost(req:IncomingMessage):string{
  const forwarded=req.headers['x-forwarded-host'];
  const value=(Array.isArray(forwarded)?forwarded[0]:forwarded)?.split(',')[0].trim()||req.headers.host||'';
  return value.toLowerCase();
}
function loginScreen(req:IncomingMessage,res:ServerResponse,message='',status=200){
  const ticket=randomBytes(24).toString('hex');
  const secure=(req.socket as {encrypted?:boolean}).encrypted||req.headers['x-forwarded-proto']==='https';
  res.setHeader('Set-Cookie','hw_lounge_login='+ticket+'; Path=/tv; HttpOnly; SameSite=Lax; Max-Age=600; Expires='+new Date(Date.now()+600000).toUTCString()+(secure?'; Secure':''));
  const login=hasUsers()?'<form method="post" action="/tv/login">'+hidden('ticket',ticket)+'<label for="account">Account</label><input id="account" name="username" type="text" maxlength="50"><label for="secret">Password</label><input id="secret" name="password" type="password" maxlength="256"><input class="commit" type="submit" value="Enter Hearthwave"></form>':'<p>Set up your first administrator using the desktop interface.</p>'+href('/?modern=1','Open setup');
  frame(res,null,'','Welcome home','<table class="welcome" cellpadding="0" cellspacing="0"><tr><td valign="top"><div class="kicker">THE LIVING ROOM</div><h2>Everything you love, together.</h2><p>Watch, listen and discover your own entertainment.</p></td><td valign="top"><div class="panel">'+(message?'<p class="notice">'+esc(message)+'</p>':'')+login+'</div></td></tr></table>',status);
}
function itemUrl(item:Entry,back:string){return query({screen:'item',id:item.id,back});}
function tile(item:Entry,back:string,csrf:string){
  const art=imageUrl(item.artwork),resume=Number(item.position_seconds)>10&&['film','episode','music'].includes(item.kind);
  const subtitle=[item.year,item.kind==='episode'?'S'+(item.season||'?')+' E'+(item.episode||'?'):'',(item.source_count||0)+' sources'].filter(Boolean).join(' / ');
  const shape=['film','series','episode'].includes(item.kind)?'portrait':item.kind==='channel'?'station':item.kind==='photo'?'snapshot':'square';
  const link=itemUrl(item,back),fields={id:item.id,back},title=item.kind==='photo'?'View':item.kind==='music'?'Listen':'Play';
  const cover='<a class="cardart" href="'+esc(link)+'" title="'+esc(item.title)+'"><span class="artwork">'+(art?'<img src="'+esc(art)+'" alt="">':'<span class="artlabel">'+esc((item.title||'?').slice(0,1).toUpperCase())+'</span>')+'</span><span class="artbadge">'+esc(item.kind)+'</span>'+(resume?'<span class="watched">'+Math.max(1,Math.floor((item.position_seconds||0)/60))+'m watched</span>':'')+'</a>';
  const controls='<div class="cardactions">'+href(link,'Details','cardbutton')+(item.kind==='series'?href(link,'Episodes','cardbutton'):item.kind==='game'?href(link,'Game','cardbutton'):post(csrf,'watch',{...fields,resume:resume?'yes':'no'},resume?'Resume':title,'cardform'))+'</div><div class="cardactions">'+post(csrf,'star',fields,item.favourite?'★':'☆','starform')+(['film','series','episode'].includes(item.kind)?post(csrf,'queue',fields,item.watchlisted?'✓ Saved':'+ Watchlist','saveform'):'')+'</div>';
  return '<div class="shelfcard shelf-'+shape+'">'+cover+'<span class="cardtitle" title="'+esc(item.title)+'">'+esc(item.title)+'</span><span class="caption">'+esc(subtitle)+'</span>'+controls+'</div>';
}
function channelList(items:Entry[],back:string,csrf:string){
  if(!items.length)return '<div class="blank">No channels to display.</div>';
  return '<table class="listing channel-list" cellspacing="0" cellpadding="0">'+items.map(item=>{
    const art=imageUrl(item.artwork),fields={id:item.id,back};
    return '<tr><td class="channel-logo">'+(art?'<img src="'+esc(art)+'" alt="">':'&#9658;')+'</td><td>'+href(itemUrl(item,back),item.title,'stationlink')+'<span class="caption">'+esc([item.live_genre,(item.source_count?item.source_count+' sources'+(item.epg_backed?' / EPG matched':' / Provider only')+(item.source_types?' / '+item.source_types.split(',').map(type=>({m3u:'IPTV (M3U)',xtream:'IPTV (Xtream)',stalker:'Stalker',direct:'Direct'} as Record<string,string>)[type]||type).join(' + '):''):'EPG only / no connection')].filter(Boolean).join(' / '))+'</span></td><td class="channel-actions">'+(item.source_count?post(csrf,'watch',fields,'Watch'):'<span class="caption">EPG only</span>')+href(itemUrl(item,back),'Guide')+post(csrf,'star',fields,item.favourite?'★':'☆')+'</td></tr>';
  }).join('')+'</table>';
}
function shelf(items:Entry[],back:string,csrf:string){
  return items.length?'<div class="shelf">'+items.map(item=>tile(item,back,csrf)).join('\n')+'</div>':'<div class="blank">There is nothing here yet.</div>';
}
function section(title:string,items:Entry[],back:string,more:string,csrf:string,subtitle=''){
  return items.length?'<div class="sectionhead"><h2>'+esc(title)+'</h2>'+href(more,'See all','plain')+(subtitle?'<p class="caption">'+esc(subtitle)+'</p>':'')+'</div>'+(items.every(item=>item.kind==='channel')?channelList(items,back,csrf):shelf(items,back,csrf)):'';
}
function catalogue(kind:Kind,uid:number,view:View='all',limit=4,sort:'added'|'title'|'activity'='title'){return listTitles(kind,uid,'',view,sort,limit) as Entry[];}
const sectionFor=(kind:Kind)=>kind==='channel'?'live':kind==='game'?'play':'library';
function programmeTime(raw:string){const d=new Date(raw);return Number.isFinite(d.getTime())?d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'';}
function programmeList(schedule:{programmes:Array<{start:string;title:string;description:string}>}){
  return schedule.programmes.length?'<table class="listing" cellspacing="0" cellpadding="0">'+schedule.programmes.slice(0,8).map(p=>'<tr><td class="time">'+esc(programmeTime(p.start))+'</td><td><strong>'+esc(p.title)+'</strong><div class="caption">'+esc(p.description.slice(0,180))+'</div></td></tr>').join('')+'</table>':'<p class="caption">No stored programme information for this channel.</p>';
}
function playable(item:Entry,uid:number){
  const pref=getUserPreferences(uid).qualityPreference,rank=pref==='sd'?3:pref==='hd'?2:pref==='fhd'?1:0;
  return listVariants(item.id).filter(v=>!/^(?:xtream|stalker)-series:/.test(v.url)).sort((a,b)=>(a.quality_rank<rank?a.quality_rank+5:a.quality_rank)-(b.quality_rank<rank?b.quality_rank+5:b.quality_rank));
}
export async function loungeRequest(req:IncomingMessage,res:ServerResponse,url:URL,s:Services):Promise<void>{
  const method=req.method||'GET',path=url.pathname;
  if(path==='/tv/login'&&method==='POST'){
    const f=await formData(req),ticket=/(?:^|;\s*)hw_lounge_login=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    const origin=req.headers.origin||req.headers.referer;
    // Some older TV browsers send an opaque Origin ("null"). The one-time
    // same-site cookie/form ticket below remains the CSRF check in that case.
    if(origin&&origin!=='null'){
      try{
        const originHost=new URL(origin).host.toLowerCase();
        if(originHost!==requestHost(req))throw Error();
      }catch{return loginScreen(req,res,'Open the sign-in page on this server.',403);}
    }
    if(!ticket||f.get('ticket')!==ticket)return loginScreen(req,res,'Sign-in expired. Try again.',403);
    let account:User;
    try{account=s.login(req,{username:f.get('username'),password:f.get('password')});}
    catch(error){return loginScreen(req,res,(error as Error).message,401);}
    s.issueSession(req,res,account);return redirect(res,'/tv');
  }
  const auth=s.session(req);
  if(!auth)return loginScreen(req,res);
  const {user,csrf}=auth;
  if(path==='/tv/room-state'&&method==='GET'){
    try{const rid=idOf(url.searchParams.get('id'));if(!rid)throw Error();const {room}=await s.call('GET','/api/community/rooms/'+rid);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end([Number(room.position)||0,room.playing?1:0,room.hostOnline?1:0].join('|'));}catch{res.writeHead(404,{'Cache-Control':'no-store'});res.end();}return;
  }
  let navigation:Navigation={route:cleanRoute(url.pathname+url.search)||'/tv',trail:decodeTrail(url.searchParams.get('nav')),fallback:internalReturn(url.searchParams.get('back'))};
  const render=(where:string,title:string,body:string,status=200)=>frame(res,user,where,title,body,status,navigation);
  const error=(message:string,status=400)=>loungeError(res,status,user,message,navigation);
  if(method==='POST'&&path==='/tv/submit'){
    const f=await formData(req);
    const originalTrail=decodeTrail(f.get('nav')),originalRoute=cleanRoute(f.get('route'));
    navigation={route:'',trail:pushRoute(originalTrail,originalRoute),fallback:originalRoute||internalReturn(f.get('back'))};
    const stay=(fallback:string)=>redirect(res,carry(originalRoute||fallback,originalTrail));
    if(f.get('csrf')!==csrf)return error('Your session has expired. Open the page again.',403);
    const op=f.get('op'),id=idOf(f.get('id')),back=internalReturn(f.get('back')),item=id?getTitleDetail(id,user.id) as Entry|undefined:undefined;
    if(op==='feature.backup'){if(user.role!=='admin')return error('Administrator access required.',403);try{return await s.backup();}catch(e){return error((e as Error).message,409);}}
    if(op?.startsWith('feature.')){
      try{const {submitLoungeFeature}=await import('./lounge-features.ts');const result=await submitLoungeFeature(op,f,user,s.call);if(result.body)return render(result.section,result.title,result.body);return stay(result.route||query({screen:result.section}));}catch(e){return error((e as Error).message,400);}
    }
    if(op==='logout'){s.logout(req,res,auth.tokenHash);return redirect(res,'/tv');}
    if(op==='preferences'){
      const quality=f.get('quality') as QualityPreference;
      if(!qualityPreferences.includes(quality))return error('Select a playback quality.');
      setUserPreferences(user.id,f.get('autoplay')==='yes',quality);return stay(query({screen:'settings'}));
    }
    if(op==='newcollection'){
      const name=(f.get('name')||'').trim();
      if(!name||name.length>70||/[\p{Cc}\p{Cf}]/u.test(name))return error('Enter a collection name of up to 70 characters.');
      createCollection(user.id,name);return stay(query({screen:'saved'}));
    }
    if(!item)return error('This title is no longer in your library.',404);
    const detail=itemUrl(item,back);
    if(op==='star'){setFavourite(user.id,id,!item.favourite);return stay(detail);}
    if(op==='queue'&&['film','series','episode'].includes(item.kind)){setWatchlisted(user.id,id,!item.watchlisted);return stay(detail);}
    if(op==='collection'){
      const collection=ownedCollection(user.id,idOf(f.get('collection')));
      if(!collection||collection.mode!=='manual')return error('Choose one of your manual collections.',404);
      setCollectionMembership(user.id,collection.id,id,f.get('include')==='yes');return stay(detail);
    }
    if(op==='refresh'&&item.kind==='series'){
      if(user.role!=='admin')return error('Only an administrator can refresh episodes.',403);
      try{s.refreshEpisodes(id);}catch(e){return error((e as Error).message,409);}return stay(detail);
    }
    if(op==='room-sync'){
      const rid=idOf(f.get('room')),position=Number(f.get('seconds'));
      if(!rid||!f.has('seconds')||!Number.isFinite(position)||position<0||position>604800||!['0','1'].includes(f.get('playing')||'')){res.writeHead(400);res.end();return;}
      try{await s.call('POST','/api/community/rooms/'+rid+'/sync',{position,playing:f.get('playing')==='1'});res.writeHead(204);}catch{res.writeHead(403);}res.end();return;
    }
    if(op==='position'){
      const seconds=Number(f.get('seconds'));
      if(!['film','episode','music'].includes(item.kind)||!f.has('seconds')||!Number.isFinite(seconds)||seconds<0||seconds>10000000){res.writeHead(400);res.end();return;}
      saveProgress(user.id,id,seconds);res.writeHead(204);res.end();return;
    }
    if(op==='watch'){
      const roomId=idOf(f.get('room'));let room:{titleId:number;own:boolean;position:number;playing:boolean}|undefined;
      if(roomId){try{room=(await s.call('GET','/api/community/rooms/'+roomId)).room;if(!room||room.titleId!==id)return error('This title is not in the watch room.',403);}catch{return error('Watch room unavailable.',404);}}
      const choice=f.has('variant')?getVariant(idOf(f.get('variant'))):playable(item,user.id)[0];
      if(!choice||choice.title_id!==id||['series','game'].includes(item.kind)||/^(xtream|stalker)-series:/.test(choice.url))return error('This version is not playable.',404);
      const debug=f.get('debug')==='yes';
      if(debug&&(user.role!=='admin'||item.kind!=='channel'||choice.source_type!=='stalker'))return error('Administrator Stalker channel access required.',403);
      let debugPanel='';
      let address=choice.source_type==='folder'?'/api/media/'+choice.id+'/file':choice.url;
      const tried=String(f.get('tried')||'').split(',').map(idOf).filter(Boolean).slice(0,20);if(!tried.includes(choice.id))tried.push(choice.id);
      const alternative=tried.length<20?playable(item,user.id).find(v=>!tried.includes(v.id)):undefined;
      const fallback=alternative?post(csrf,'watch',{id,back,...(roomId?{room:roomId}:{}),variant:alternative.id,tried:tried.join(','),resume:f.get('resume')==='yes'?'yes':'no'},'Try next source','fallbackform'):'';
      if(choice.source_type==='stalker'&&address.startsWith('stalker:')){
        const source=getSource(choice.source_id);if(!source)return error('This connection is no longer available.',404);
        if(debug){
          const result=await debugStalkerStream(source,choice.url);
          debugPanel='<h2>Stalker direct playback debug</h2><p class="caption">Variant '+choice.id+' / Source '+choice.source_id+'; no NAS media forwarding.</p><textarea rows="12" cols="55" readonly="readonly" id="stalker-debug-report">'+esc(result.trace.join('\n'))+'</textarea>';
          if(!result.url)return render(sectionFor(item.kind),item.title,'<p class="notice">Provider link resolution failed.</p>'+debugPanel+href(detail,'Other versions'),502);
          address=result.url;
        }else try{address=await resolveProviderStream(source,choice.url);}catch{return render(sectionFor(item.kind),item.title,'<p class="notice">This connection could not start playback.</p>'+fallback+href(detail,'Other versions'),502);}
      }
      if(choice.source_type!=='folder'&&!imageUrl(address))return error('The source does not offer a supported HTTP media address.');
      if(!originalRoute&&!originalTrail.length)navigation.trail=pushRoute(pushRoute(originalTrail,back),detail);
      const offset=room?Math.max(0,Number(room.position)||0):f.get('resume')==='yes'?Math.max(0,Number(item.position_seconds)||0):0;
      const attrs=' id="media" src="'+esc(address)+ '" controls="controls"'+(!room||room.own||room.playing?' autoplay="autoplay"':'')+' preload="metadata" data-item="'+id+'" data-kind="'+esc(item.kind)+'" data-offset="'+offset+'" data-token="'+esc(csrf)+'"'+(room?' data-room="'+roomId+'" data-host="'+(room.own?'yes':'no')+'"':'');
      const tag=item.kind==='music'?'audio':'video';
      const media=item.kind==='photo'?'<img class="viewphoto" src="'+esc(address)+'" alt="'+esc(item.title)+'">':'<'+tag+attrs+'>Native media playback is not available in this browser.</'+tag+'>';
      let adjacent='',autoNext='';
      if(item.kind==='episode'&&!room){
        const parent=db.prepare('SELECT series_parent_id AS id FROM variants WHERE title_id=? AND series_parent_id IS NOT NULL LIMIT 1').get(id) as {id:number}|undefined;
        if(parent){const list=listSeriesEpisodes(parent.id,user.id) as Entry[],at=list.findIndex(x=>x.id===id);if(at>0){adjacent=post(csrf,'watch',{id:list[at-1].id,back},'Next episode','nextform');if(getUserPreferences(user.id).autoplayNext)autoNext='yes';}if(at>=0&&at+1<list.length)adjacent+=post(csrf,'watch',{id:list[at+1].id,back},'Previous episode');}
      }
      if(item.kind==='channel'){
        const ref=navigation.trail.map(x=>new URL(x,'http://hearthwave.invalid')).reverse().find(u=>u.searchParams.get('kind')==='channel');
        const q=(ref?.searchParams.get('q')||'').slice(0,120),r=ref?.searchParams.get('region')||'',g=ref?.searchParams.get('genre')||'',region=['GB','US','other'].includes(r)?r:'',genre=liveGenres.includes(g as typeof liveGenres[number])?g:'',view=ref?.searchParams.get('view')==='favourites'?'favourites':'all',page=pageNo(ref?.searchParams.get('page'));
        const start=Math.max(0,(page-1)*12),channels=(listTitles('channel',user.id,q,view,'title',36,start,region,genre) as Entry[]).filter(v=>Number(v.source_count)>0),at=channels.findIndex(v=>v.id===id);
        if(at>0)adjacent+=post(csrf,'watch',{id:channels[at-1].id,back},'Previous channel','prevchannel');
        if(at>=0&&at+1<channels.length)adjacent+=post(csrf,'watch',{id:channels[at+1].id,back},'Next channel','nextchannel');
      }
      return render(sectionFor(item.kind),item.title,'<div class="toolbar">'+href(detail,'Back','chip return-target')+(room?href(query({screen:'room',id:roomId}),'Watch room'):'')+adjacent+'</div><div class="screenmedia">'+media+'</div><div class="toolbar player-toolbar"><input class="commit" type="button" id="media-toggle" value="Play / pause"><input class="commit" type="button" id="media-full" value="Full screen">'+fallback+'</div><div id="media-message" class="caption" data-autonext="'+autoNext+'">'+esc(choice.source_name)+' / '+esc(choice.quality_tier)+' &middot; Native television playback</div><div class="toolbar">'+href(address,'Open stream directly')+href(detail,'Other versions')+'</div>'+debugPanel);
    }
    return error('Unknown action.');
  }
  if(method!=='GET')return error('Unsupported request.',405);
  // Retain bookmarks to the old entrypoint without serving its implementation.
  if(path!=='/tv'&&path!=='/tv/'){
    if(path==='/tv/title')return redirect(res,query({screen:'item',id:idOf(url.searchParams.get('id'))}));
    if(path==='/tv/browse')return redirect(res,query({screen:'browse',kind:url.searchParams.get('kind')||'library',view:url.searchParams.get('view')||'all',q:url.searchParams.get('q')||''}));
    if(path==='/tv/settings')return redirect(res,query({screen:'settings'}));
    return redirect(res,'/tv');
  }
  const params=url.searchParams,screen=params.get('screen')||'home';
  if(!['home','browse','guide','saved','settings','item'].includes(screen)){
    try{const {renderLoungeFeature}=await import('./lounge-features.ts');const feature=await renderLoungeFeature(screen,params,user,csrf,s.call);if(feature)return render(feature.section,feature.title,feature.body);}catch(e){console.error('TV feature request failed:',e);return error('The requested TV feature could not be loaded or completed.',400);}
  }
  if(screen==='home'){
    const stats=dashboardStats(),added=catalogue('library',user.id,'all',6,'added'),focus=catalogue('library',user.id,'continue',6,'activity'),saved=catalogue('library',user.id,'watchlist',6),favourites=catalogue('channel',user.id,'favourites',4),live=catalogue('channel',user.id,'all',4);
    const browse=(kind:Kind,view:View='all')=>query({screen:'browse',kind,view});
    return render('home','Home','<div class="spotlight"><div class="hero-disc"></div><div class="kicker">WELCOME TO HEARTHWAVE</div><h2>All your entertainment.<br>One happy place.</h2><p>Movies, music and live television belong together. Your own server, your sources and your choices.</p><div class="toolbar">'+href(browse('library'),'Explore your library','primary')+'</div></div><table class="stat-grid" cellspacing="8" cellpadding="0"><tr><td><span class="caption">Library titles</span><strong>'+stats.items+'</strong></td><td><span class="caption">Live channels</span><strong>'+stats.channels+'</strong></td><td><span class="caption">Configured sources</span><strong>'+stats.sources+'</strong></td></tr></table>'+
      section('Continue watching',focus,'/tv',browse('library','continue'),csrf,'Resume where you left off.')+section('Your watchlist',saved,'/tv',browse('library','watchlist'),csrf,'Saved for later.')+section('Favourite channels',favourites,'/tv',browse('channel','favourites'),csrf,'Jump straight to your favourites.')+section('Your library',added,'/tv',browse('library'),csrf,'Pick up something good.')+section('Live television',live,'/tv',browse('channel'),csrf,'Your shared lineup.')+
      (!added.length&&!live.length?'<p class="blank">Your library is ready when you are. Add sources from Settings.</p>':''));
  }
  if(screen==='browse'){
    const requested=params.get('kind') as Kind,kind=kinds.includes(requested)?requested:'library';
    const requestedView=params.get('view') as View,view=views.includes(requestedView)?requestedView:'all';
    const search=(params.get('q')||'').slice(0,120),country=kind==='channel'&&['GB','US','other'].includes(params.get('region')||'')?params.get('region')!:'';
    const categories:readonly string[]=kind==='channel'?liveGenres:['library','film','series'].includes(kind)?libraryGenres:[];
    const genre=categories.includes(params.get('genre')||'')?params.get('genre')!:'';
    const cid=idOf(params.get('collection')),collection=cid?ownedCollection(user.id,cid):undefined;
    if(cid&&!collection)return error('This collection is not available.',404);
    const number=pageNo(params.get('page')),limit=12;
    const requestedSort=params.get('sort'),sort=requestedSort==='year'||requestedSort==='added'||requestedSort==='activity'||requestedSort==='title'?requestedSort:view==='continue'?'activity':'title';
    const state={screen:'browse',kind,view,q:search,region:country,genre,collection:cid,page:number,sort};
    const back=query(state),rows=listTitles(kind,user.id,search,view,sort,limit+1,number*limit,country,kind==='channel'?genre:'',kind==='channel'?'':genre,collection) as Entry[];
    const kindbar=sectionFor(kind)==='library'?'<div class="toolbar">'+(['library','film','series','episode','music','photo'] as Kind[]).map(k=>href(query({screen:'browse',kind:k}),kindNames[k],k===kind?'primary':'chip')).join('')+href(query({screen:'collections'}),'Collections')+href(query({screen:'requests'}),'Media requests')+'</div>':kind==='channel'?'<div class="toolbar">'+href(query({screen:'guide'}),'Programme guide')+'</div>':'';
    const filter='<form class="filter" method="get" action="/tv">'+hidden('screen','browse')+hidden('kind',kind)+hidden('collection',cid)+'<label>Find <input type="text" name="q" maxlength="120" value="'+esc(search)+'"></label><label>Show '+select('view',[['all','All'],['favourites','Favourites'],['watchlist','Watchlist'],['continue','In progress']],view)+'</label>'+
      (kind==='channel'?'<label>Region '+select('region',[['','Everywhere'],['GB','UK'],['US','US'],['other','Other']],country)+'</label>':'')+(categories.length?'<label>Genre '+select('genre',[['','Any'],...categories.map(x=>[x,x] as [string,string])],genre)+'</label>':'')+(kind==='channel'?'':'<label>Sort '+select('sort',[['title','Title A–Z'],['year','Newest release'],['added','Recently added'],['activity','Recently watched']],sort)+'</label>')+'<input type="submit" class="commit" value="Find"></form>';
    const pages='<div class="toolbar pagination">'+(number?href(query({...state,page:number-1}),'Previous'):'')+'<span class="caption">Page '+(number+1)+'</span>'+(rows.length>limit?href(query({...state,page:number+1}),'Next'):'')+'</div>';
    return render(sectionFor(kind),collection?.name||kindNames[kind],kindbar+filter+(kind==='channel'?channelList(rows.slice(0,limit),back,csrf):shelf(rows.slice(0,limit),back,csrf))+pages);
  }
  if(screen==='guide'){
    const slot=Math.max(-4,Math.min(40,Math.floor(Number(params.get('slot'))||0))),number=pageNo(params.get('page')),region=['GB','US','other'].includes(params.get('region')||'')?params.get('region')!:'',limit=8;
    const rows=listTitles('channel',user.id,'','all','title',limit+1,number*limit,region) as Entry[];
    const here=query({screen:'guide',region,page:number,slot});
    const now=Math.floor(Date.now()/10800000)*10800+slot*10800;
    const listing=rows.slice(0,limit).map(row=>{
      const schedule=storedGuide(row.id,12,now,now+3*3600).programmes;
      return '<tr><td class="station">'+(imageUrl(row.artwork)?'<img class="guide-logo" src="'+esc(imageUrl(row.artwork))+'" alt="">':'')+href(itemUrl(row,here),row.title,'stationlink')+(row.source_count?post(csrf,'watch',{id:row.id,back:here},'Watch'):'<span class="caption">No connection</span>')+'</td><td>'+(schedule.length?schedule.map(p=>'<div class="programme"><span class="time">'+esc(programmeTime(p.start))+'</span> '+esc(p.title)+'</div>').join(''):'<span class="caption">Guide not available</span>')+'</td></tr>';
    }).join('');
    return render('live','On now','<div class="toolbar">'+href(query({screen:'browse',kind:'channel'}),'All channels')+[['','All'],['GB','UK'],['US','US'],['other','Other']].map(([key,label])=>href(query({screen:'guide',region:key,slot}),label,key===region?'primary':'chip')).join('')+'</div><div class="toolbar">'+(slot>-4?href(query({screen:'guide',region,slot:slot-1,page:number}),'Earlier'):'')+'<span class="caption">'+esc(new Date(now*1000).toLocaleString('en-GB'))+' – '+esc(programmeTime(new Date((now+10800)*1000).toISOString()))+'</span>'+href(query({screen:'guide',region,slot:0}),'Now')+(slot<40?href(query({screen:'guide',region,slot:slot+1,page:number}),'Later'):'')+'</div><table class="listing" cellspacing="0" cellpadding="0">'+listing+'</table><div class="toolbar">'+(number?href(query({screen:'guide',region,page:number-1,slot}),'Previous'):'')+(rows.length>limit?href(query({screen:'guide',region,page:number+1,slot}),'Next'):'')+'</div>');
  }
  if(screen==='saved'){
    const groups=listCollections(user.id);
    return render('saved','My collection','<div class="toolbar">'+href(query({screen:'browse',kind:'library',view:'favourites'}),'Favourite titles','primary')+href(query({screen:'browse',kind:'library',view:'watchlist'}),'Watchlist')+href(query({screen:'browse',kind:'channel',view:'favourites'}),'Favourite channels')+'</div><h2>Personal shelves</h2><div class="panel">'+(groups.length?groups.map(g=>'<p>'+href(query({screen:'browse',kind:'library',collection:g.id}),g.name)+(g.mode==='manual'?' <span class="caption">'+g.item_count+' titles</span>':' <span class="caption">Smart collection</span>')+'</p>').join(''):'<p class="caption">No collections created yet.</p>')+'<form action="/tv/submit" method="post">'+hidden('csrf',csrf)+hidden('op','newcollection')+'<label>New shelf <input type="text" name="name" maxlength="70"></label><input type="submit" class="commit" value="Create"></form></div>');
  }
  if(screen==='settings'){
    const preferences=getUserPreferences(user.id);
    return render('settings','Your preferences','<div class="toolbar">'+(user.role==='admin'?href(query({screen:'admin',tab:'sources'}),'Sources')+href(query({screen:'admin',tab:'metadata'}),'Metadata & Guide')+href(query({screen:'admin',tab:'users'}),'Users & Access')+href(query({screen:'create'}),'Downloads & Workers')+href(query({screen:'admin',tab:'system'}),'System'):'')+'</div><div class="panel"><h2>Playback</h2><form method="post" action="/tv/submit">'+hidden('csrf',csrf)+hidden('op','preferences')+'<p><label>Preferred quality '+select('quality',[['auto','Best available'],['fhd','1080p or lower'],['hd','720p or lower'],['sd','Standard definition']],preferences.qualityPreference)+'</label></p><p><label>Autoplay next episode '+select('autoplay',[['yes','On'],['no','Off']],preferences.autoplayNext?'yes':'no')+'</label></p><input type="submit" class="commit" value="Save preferences"></form></div><div class="panel"><h2>Account</h2><p>'+esc(user.username)+' &middot; '+esc(user.role)+'</p><p>Hearthwave '+esc(s.version)+'</p>'+(user.role==='admin'?'<p>Maintenance: '+(s.activity().busy?'Running':'Idle')+' . Select an administrator section above to manage imports and workers.</p>':'')+post(csrf,'logout',{},'Sign out')+'</div>');
  }
  if(screen==='item'){
    const id=idOf(params.get('id')),item=id?getTitleDetail(id,user.id) as Entry|undefined:undefined,back=internalReturn(params.get('back'));
    if(!item)return error('This title is no longer in your library.',404);
    const here=itemUrl(item,back),art=imageUrl(item.artwork),fields={id,back};
    if(!navigation.trail.length&&back!=='/tv')navigation.fallback=back;
    let content='<div class="toolbar">'+href(back,'Return to previous screen','chip return-target')+'</div><table class="feature" cellspacing="0" cellpadding="0"><tr>'+(art?'<td class="covercell" valign="top"><img src="'+esc(art)+'" alt=""></td>':'')+'<td valign="top"><div class="kicker">'+esc(kindNames[item.kind])+'</div><p class="caption">'+esc([item.year,item.episode?'Episode '+item.episode:'',item.source_count+' sources'].filter(Boolean).join(' / '))+'</p><p>'+esc(item.description||item.episode_name||'')+'</p><div class="toolbar">'+post(csrf,'star',fields,item.favourite?'Remove favourite':'Favourite')+(['film','series','episode'].includes(item.kind)?post(csrf,'queue',fields,item.watchlisted?'Remove from watchlist':'Watch later'):'')+'</div></td></tr></table>';
    if(item.kind==='series'){
      const all=listSeriesEpisodes(id,user.id) as Entry[],seasons=[...new Set(all.map(e=>e.season||0))],season=Number(params.get('season')||seasons[0]||0),number=pageNo(params.get('page'));
      const rows=all.filter(e=>(e.season||0)===season),job=s.episodeStatus(id);
      content+='<h2>Episodes</h2>';
      if(job?.status==='running')content+='<p class="notice">Importing '+job.processed+' of '+job.total+' connections &middot; '+job.episodes+' episodes '+href(here,'Refresh progress')+'</p>';
      else if(user.role==='admin')content+=post(csrf,'refresh',fields,'Refresh episode list');
      if(job?.error)content+='<p class="notice">'+esc(job.error)+'</p>';
      content+='<div class="toolbar">'+seasons.map(n=>href(query({screen:'item',id,back,season:n}),n?'Season '+n:'Other episodes',n===season?'primary':'chip')).join('')+'</div><table class="listing" cellspacing="0" cellpadding="0">'+rows.slice(number*20,number*20+20).map(ep=>'<tr><td class="time">'+esc(ep.episode||'-')+'</td><td>'+href(itemUrl(ep,here),ep.episode_name||ep.title,'stationlink')+'</td></tr>').join('')+'</table>';
      if(!all.length)content+='<p class="blank">No episodes are indexed yet.</p>';
      if(number)content+=href(query({screen:'item',id,back,season,page:number-1}),'Previous');
      if(rows.length>(number+1)*20)content+=href(query({screen:'item',id,back,season,page:number+1}),'Next');
    }else if(item.kind==='game'){
      content+='<div class="notice">This browser cannot run the EmulatorJS engine. Play this title on a modern device.</div>';
    }else{
      const sources=playable(item,user.id);
      if(sources.length){const selected=sources[0];
        content+='<div class="toolbar">'+post(csrf,'watch',{...fields,variant:selected.id},item.kind==='photo'?'View':'Play now','heroform')+((item.position_seconds||0)>10?post(csrf,'watch',{...fields,variant:selected.id,resume:'yes'},'Resume at '+Math.floor((item.position_seconds||0)/60)+' min','heroform'):'')+'</div><h2>Available versions</h2><table class="listing" cellspacing="0" cellpadding="0">'+sources.map(v=>'<tr><td>'+esc(v.source_name)+'</td><td class="caption">'+esc(v.quality_tier)+'</td><td>'+post(csrf,'watch',{...fields,variant:v.id},'Play')+(user.role==='admin'&&item.kind==='channel'&&v.source_type==='stalker'?post(csrf,'watch',{...fields,variant:v.id,debug:'yes'},'Debug'):'')+'</td></tr>').join('')+'</table>';
      }else content+='<p class="blank">No playable versions are available.</p>';
      if(item.kind==='channel')content+='<h2>Programme schedule</h2>' +programmeList(await s.call('GET','/api/titles/'+id+'/guide'))+(user.role==='admin'?post(csrf,'feature.guide-refresh',{id},'Refresh provider guide')+href(query({screen:'guide-mapping',id}),'Map guide channel'):'');
    }
    if(user.role==='admin'&&['film','series'].includes(item.kind))content+=post(csrf,'feature.title-metadata',{id},'Fetch metadata');
    if(!['channel','game'].includes(item.kind)){
      const shelves=listCollections(user.id,id).filter(c=>c.mode==='manual');
      if(shelves.length)content+='<h2>Personal shelves</h2><div class="toolbar">'+shelves.map(c=>post(csrf,'collection',{...fields,collection:c.id,include:c.included?'no':'yes'},(c.included?'Remove from ':'Add to ')+c.name)).join('')+'</div>';
    }
    return render(sectionFor(item.kind),item.title,content);
  }
  return error('Page not found.',404);
}
