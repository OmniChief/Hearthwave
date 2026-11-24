import type {IncomingMessage,ServerResponse} from 'node:http';
import type {User,MediaKind} from './model.ts';
import {hasUsers,listTitles,getTitleDetail,listVariants,getVariant,getSource,listSeriesEpisodes,setFavourite,setWatchlisted,saveProgress,storedGuide,listCollections,ownedCollection,getUserPreferences} from './db.ts';
import {resolveProviderStream} from './adapters/providers.ts';
import {qualityPreferences} from './quality.ts';

type Session={user:User;csrf:string;tokenHash:string};
type Dependencies={
  session:(req:IncomingMessage)=>Session|null;
  login:(req:IncomingMessage,input:Record<string,unknown>)=>User;
  issueSession:(req:IncomingMessage,res:ServerResponse,user:User)=>string;
  logout:(req:IncomingMessage,res:ServerResponse,token:string)=>void;
  refreshEpisodes:(id:number)=>void;
  episodeStatus:(id:number)=>{status:string;processed:number;total:number;episodes:number;error:string}|undefined;
  activity:()=>{busy:boolean};
  version:string;
};
type Row={id:number;title:string;kind:MediaKind;year?:number;artwork?:string;description?:string;season?:number;episode?:number;episode_name?:string;favourite?:number;watchlisted?:number;position_seconds?:number;source_count?:number;group_name?:string};
type BrowseKind='library'|MediaKind;
type View='all'|'favourites'|'continue'|'watchlist';
const h=(value:unknown)=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const e=encodeURIComponent;
const link=(href:string,label:string,cls='button')=>'<a class="'+cls+'" href="'+h(href)+'">'+h(label)+'</a>';
const hidden=(name:string,value:unknown)=>'<input type="hidden" name="'+h(name)+'" value="'+h(value)+'">';
const action=(csrf:string,what:string,id:number,label:string,extra:Record<string,string>={})=>'<form class="inline" action="/tv/action" method="post">'+hidden('csrf',csrf)+hidden('action',what)+hidden('id',id)+Object.entries(extra).map(([k,v])=>hidden(k,v)).join('')+'<input type="submit" value="'+h(label)+'"></form>';
const validId=(raw:unknown)=>{const n=Number(raw);return Number.isSafeInteger(n)&&n>0?n:0;};
const artwork=(url:unknown)=>typeof url==='string'&&/^https?:\/\//i.test(url)?url:'';
const genres=['','General','Entertainment','Sports','Movies','News','Kids','Documentary','Music','Other'];
const kinds:BrowseKind[]=['library','film','series','episode','music','photo','channel','game'];
const views:View[]=['all','favourites','continue','watchlist'];
const labels:Record<BrowseKind,string>={library:'Library',film:'Films',series:'Series',episode:'Episodes',music:'Music',photo:'Photos',channel:'Live TV',game:'Games'};
export function isLegacyTelevision(ua:string):boolean{
  return /SMART[- ]?TV|HbbTV|NetCast|Viera|BRAVIA|Maple|Tizen|Web0S|WebOS\.TV|Opera TV|CE-HTML|DTV|SamsungBrowser\/[1-4]\./i.test(ua);
}
export function televisionPage(res:ServerResponse,status:number,title:string,user:User|null,content:string):void{
  const nav=user?'<div id="nav">'+link('/tv','Home')+link('/tv/browse?kind=library','Library')+link('/tv/browse?kind=channel','Live TV')+link('/tv/browse?kind=music','Music')+link('/tv/browse?kind=photo','Photos')+link('/tv/browse?kind=game','Play')+link('/tv/settings','Settings')+'</div>':'';
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' http: https:; media-src 'self' http: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
  res.end('<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+h(title)+' - Hearthwave TV</title><link rel="stylesheet" type="text/css" href="/tv.css"><script type="text/javascript" src="/tv.js" defer="defer"></script></head><body><div id="wrap"><div id="header"><a href="/tv" class="brand">hearthwave<span>.</span></a><span class="identity">TV MODE'+(user?' / '+h(user.username):'')+'</span></div>'+nav+'<div id="main"><h1>'+h(title)+'</h1>'+content+'</div><div id="footer">Arrows: move &nbsp; OK: select &nbsp; Back: previous page &nbsp; '+link('/?modern=1','Full interface','textlink')+'</div></div></body></html>');
}
function redirect(res:ServerResponse,path:string){res.writeHead(303,{'Location':path,'Cache-Control':'no-store'});res.end();}
async function readForm(req:IncomingMessage){
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))throw new Error('Invalid form submission.');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>8192)throw new Error('Form is too large.');chunks.push(b);}
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function signInPage(res:ServerResponse,error='',status=200){
  televisionPage(res,status,'Sign in',null,'<div class="login"><p>Use your existing Hearthwave account.</p>'+(error?'<p class="alert">'+h(error)+'</p>':'')+
    (!hasUsers()?'<p>Complete first-time administrator setup on a modern browser.</p>':'<form action="/tv/login" method="post"><label for="username">Username</label><input id="username" name="username" type="text" maxlength="50"><label for="password">Password</label><input id="password" name="password" type="password" maxlength="256"><input type="submit" value="Sign in"></form>')+'</div>');
}
const browseUrl=(kind:BrowseKind,view:View,q='',country='',genre='',offset=0,collection=0)=>'/tv/browse?kind='+e(kind)+'&view='+e(view)+'&q='+e(q)+'&country='+e(country)+'&genre='+e(genre)+'&offset='+offset+(collection?'&collection='+collection:'');
function card(r:Row){const image=artwork(r.artwork);return '<a class="tile '+(r.kind==='channel'?'channel':'')+'" href="/tv/title?id='+r.id+'"><span class="cover">'+(image?'<img src="'+h(image)+'" alt="">':'<span class="placeholder">'+h(labels[r.kind]||r.kind)+'</span>')+'</span><span class="tiletitle">'+h(r.title)+'</span><span class="meta">'+h([r.year,r.kind==='episode'&&r.episode?'Episode '+r.episode:'',r.favourite?'Favourite':''].filter(Boolean).join(' / '))+'</span></a>';}
function cards(rows:Row[]){return rows.length?'<div class="tiles">'+rows.map(card).join('')+'</div>':'<p class="empty">Nothing to display.</p>';}
function select(name:string,options:Array<[string,string]>,selected:string){return '<select name="'+h(name)+'">'+options.map(([v,l])=>'<option value="'+h(v)+'"'+(v===selected?' selected="selected"':'')+'>'+h(l)+'</option>').join('')+'</select>';}
function safeReturn(raw:string|null){return raw&&/^\/tv\/(?:title|browse)\?[a-zA-Z0-9%&=+_.~-]+$/.test(raw)?raw:'/tv';}
export async function television(req:IncomingMessage,res:ServerResponse,url:URL,d:Dependencies):Promise<void>{
  const path=url.pathname,method=req.method||'GET';
  if(path==='/tv/login'&&method==='POST'){
    const form=await readForm(req);
    // Reject cross-origin form submissions on browsers that supply Origin.
    const origin=req.headers.origin;
    if(origin){try{if(new URL(origin).host!==req.headers.host)throw Error();}catch{signInPage(res,'Sign in from the Hearthwave page.',403);return;}}
    try{const user=d.login(req,{username:form.get('username'),password:form.get('password')});d.issueSession(req,res,user);return redirect(res,'/tv');}
    catch(error){return signInPage(res,(error as Error).message,401);}
  }
  const session=d.session(req);
  if(!session)return signInPage(res);
  const {user,csrf}=session;
  const page=(title:string,content:string,status=200)=>televisionPage(res,status,title,user,content);
  if(method==='POST'&&path==='/tv/action'){
    const f=await readForm(req);
    if(f.get('csrf')!==csrf)return page('Session expired','<p>Return home and try again.</p>'+link('/tv','Home'),403);
    const id=validId(f.get('id')),what=f.get('action');
    if(what==='logout'){d.logout(req,res,session.tokenHash);return redirect(res,'/tv');}
    const row=id?getTitleDetail(id,user.id) as Row|undefined:undefined;
    if(!row)return page('Not found','<p>This title is no longer available.</p>'+link('/tv','Home'),404);
    if(what==='favourite'){setFavourite(user.id,id,!row.favourite);return redirect(res,'/tv/title?id='+id);}
    if(what==='watchlist'&&['film','series','episode'].includes(row.kind)){setWatchlisted(user.id,id,!row.watchlisted);return redirect(res,'/tv/title?id='+id);}
    if(what==='episodes'&&row.kind==='series'){
      if(user.role!=='admin')return page('Administrator only','<p>Ask an administrator to refresh this series.</p>',403);
      d.refreshEpisodes(id);return redirect(res,'/tv/title?id='+id);
    }
    if(what==='progress'){
      const seconds=Number(f.get('seconds'));
      if(!Number.isFinite(seconds)||seconds<0||seconds>10000000||!['film','episode','music'].includes(row.kind)){res.writeHead(400);res.end();return;}
      saveProgress(user.id,id,seconds);res.writeHead(204);res.end();return;
    }
    if(what==='play'){
      const variant=getVariant(validId(f.get('variant')));
      if(!variant||variant.title_id!==id||/^(xtream|stalker)-series:/.test(variant.url)||row.kind==='series'||row.kind==='game')return page('Source unavailable',link('/tv/title?id='+id,'Back to title'),404);
      let address=variant.source_type==='folder'?'/api/media/'+variant.id+'/file':variant.url;
      if(variant.source_type==='stalker'&&variant.url.startsWith('stalker:')){
        const source=getSource(variant.source_id);
        if(!source)return page('Connection unavailable',link('/tv/title?id='+id,'Choose another source'),404);
        address=await resolveProviderStream(source,variant.url);
      }
      if(!address.startsWith('/api/media/')&&!/^https?:\/\//i.test(address))return page('Unsupported source',link('/tv/title?id='+id,'Choose another source'),400);
      const resume=f.get('resume')==='1'?Math.max(0,Number(row.position_seconds)||0):0;
      const media=row.kind==='photo'?'<img class="photo" src="'+h(address)+'" alt="'+h(row.title)+'">':
        '<'+(row.kind==='music'?'audio':'video')+' id="tv-player" controls="controls" autoplay="autoplay" preload="metadata" src="'+h(address)+'" data-title="'+id+'" data-kind="'+h(row.kind)+'" data-resume="'+resume+'" data-csrf="'+h(csrf)+'"><p>Your TV does not provide native HTML media playback.</p></'+(row.kind==='music'?'audio':'video')+'>';
      return page(row.title,'<div class="player">'+media+'</div><p id="player-note">Using your television native player. If the format is unsupported, choose another source.</p><div class="actions">'+link('/tv/title?id='+id,'Back / other sources')+link(address,'Open media directly')+(row.kind==='channel'?link('/tv/browse?kind=channel','Channel list'):'')+'</div>');
    }
    return page('Unsupported action',link('/tv','Home'),400);
  }
  if(method!=='GET')return page('Unsupported request',link('/tv','Home'),405);
  if(path==='/tv'||path==='/tv/'){
    const recent=listTitles('library',user.id,'','all','added',8) as Row[];
    const progress=listTitles('library',user.id,'','continue','activity',8) as Row[];
    const saved=listTitles('library',user.id,'','watchlist','added',8) as Row[];
    const channels=listTitles('channel',user.id,'','favourites','title',8) as Row[];
    return page('Your entertainment','<div class="quick">'+link('/tv/browse?kind=film','Films')+link('/tv/browse?kind=series','Series')+link('/tv/browse?kind=channel','Watch live')+link('/tv/browse?kind=library&view=favourites','Favourites')+link('/tv/browse?kind=library&view=watchlist','Watchlist')+'</div>'+
      (progress.length?'<h2>Continue watching</h2>'+cards(progress):'')+(saved.length?'<h2>Watchlist</h2>'+cards(saved):'')+(channels.length?'<h2>Favourite channels</h2>'+cards(channels):'')+'<h2>Recently added</h2>'+cards(recent));
  }
  if(path==='/tv/browse'){
    const raw=url.searchParams.get('kind') as BrowseKind,kind=kinds.includes(raw)?raw:'library';
    const v=url.searchParams.get('view') as View,view=views.includes(v)?v:'all';
    const q=(url.searchParams.get('q')||'').slice(0,120),c=url.searchParams.get('country')||'',g=url.searchParams.get('genre')||'';
    const country=kind==='channel'&&['','GB','US','other'].includes(c)?c:'',genre=kind==='channel'&&genres.includes(g)?g:'';
    const collectionId=validId(url.searchParams.get('collection')),collection=collectionId?ownedCollection(user.id,collectionId):undefined;
    if(collectionId&&!collection)return page('Collection not found',link('/tv/browse?kind=library','Library'),404);
    const n=Number(url.searchParams.get('offset')||0),offset=Number.isSafeInteger(n)&&n>=0?Math.min(n,1000000):0,limit=24;
    const rows=listTitles(kind,user.id,q,view,view==='continue'?'activity':'title',limit+1,offset,country,genre,'',collection) as Row[];
    const tabs=kind==='channel'?'<div class="actions">'+link('/tv/browse?kind=channel','All channels')+link('/tv/browse?kind=channel&view=favourites','Favourites')+'</div>':'<div class="actions">'+(['library','film','series','episode','music','photo'] as BrowseKind[]).map(k=>link(browseUrl(k,'all'),labels[k])).join('')+link('/tv/collections','Collections')+'</div>';
    const filter='<form action="/tv/browse" method="get" class="filters">'+hidden('kind',kind)+(collectionId?hidden('collection',collectionId):'')+'<label>Search <input name="q" type="text" maxlength="120" value="'+h(q)+'"></label><label> Show '+select('view',[['all','All'],['favourites','Favourites'],['continue','Continue'],['watchlist','Watchlist']],view)+'</label>'+(kind==='channel'?'<label> Region '+select('country',[['','All'],['GB','UK'],['US','USA'],['other','Other']],country)+'</label><label> Group '+select('genre',genres.map(x=>[x,x||'All']),genre)+'</label>':'')+'<input type="submit" value="Go"></form>';
    const pager='<div class="actions pager">'+(offset?link(browseUrl(kind,view,q,country,genre,Math.max(0,offset-limit),collectionId),'Previous page'):'')+'<span>Page '+(Math.floor(offset/limit)+1)+'</span>'+(rows.length>limit?link(browseUrl(kind,view,q,country,genre,offset+limit,collectionId),'Next page'):'')+'</div>';
    return page(collection?collection.name:labels[kind],tabs+filter+cards(rows.slice(0,limit))+pager);
  }
  if(path==='/tv/collections'){
    const rows=listCollections(user.id);
    return page('Collections',rows.map(r=>'<p>'+link('/tv/browse?kind=library&collection='+r.id,r.name)+'</p>').join('')||'<p>No collections.</p>');
  }
  if(path==='/tv/title'){
    const id=validId(url.searchParams.get('id')),r=id?getTitleDetail(id,user.id) as Row|undefined:undefined;
    if(!r)return page('Title not found',link('/tv','Home'),404);
    const image=artwork(r.artwork);
    let content='<div class="detail">'+(image?'<img class="poster" src="'+h(image)+'" alt="">':'')+'<div><p class="meta">'+h([r.year,labels[r.kind],r.source_count+' sources'].filter(Boolean).join(' / '))+'</p><p>'+h(r.description||'')+'</p><div class="actions">'+action(csrf,'favourite',id,r.favourite?'Remove favourite':'Add favourite')+(['film','series','episode'].includes(r.kind)?action(csrf,'watchlist',id,r.watchlisted?'Remove from watchlist':'Add to watchlist'):'')+'</div></div></div>';
    if(r.kind==='series'){
      const episodes=listSeriesEpisodes(id,user.id) as Row[],job=d.episodeStatus(id);
      const offset=Math.min(1000,Math.max(0,Math.floor(Number(url.searchParams.get('offset'))||0)));
      if(job?.status==='running')content+='<p class="alert">Retrieving episodes: '+job.processed+'/'+job.total+' connections, '+job.episodes+' episodes. '+link('/tv/title?id='+id,'Refresh status')+'</p>';
      else if(user.role==='admin')content+=action(csrf,'episodes',id,'Refresh episodes');
      if(job?.error)content+='<p class="alert">'+h(job.error)+'</p>';
      content+='<h2>Episodes</h2>'+episodes.slice(offset,offset+40).map(ep=>'<p class="episode">'+link('/tv/title?id='+ep.id,'Season '+(ep.season||'?')+' / Episode '+(ep.episode||'?')+' '+(ep.episode_name||''))+'</p>').join('');
      if(!episodes.length)content+='<p>No episodes indexed. An administrator can refresh this series.</p>';
      if(offset)content+=link('/tv/title?id='+id+'&offset='+Math.max(0,offset-40),'Previous episodes');
      if(episodes.length>offset+40)content+=link('/tv/title?id='+id+'&offset='+(offset+40),'Next episodes');
    }else if(r.kind==='game'){
      content+='<p>EmulatorJS requires a modern browser and cannot run on an ES3 television. This game remains available in the full interface.</p>';
    }else{
      const preference=getUserPreferences(user.id).qualityPreference,preferred=preference==='fhd'?1:preference==='hd'?2:preference==='sd'?3:0;
      const variants=listVariants(id).filter(v=>!/^(xtream|stalker)-series:/.test(v.url)).sort((a,b)=>(a.quality_rank<preferred?5+a.quality_rank:a.quality_rank)-(b.quality_rank<preferred?5+b.quality_rank:b.quality_rank));
      if(variants.length){
        const first=variants[0];content+='<div class="actions">'+action(csrf,'play',id,r.kind==='photo'?'View photo':'Play', {variant:String(first.id)})+((r.position_seconds||0)>10?action(csrf,'play',id,'Resume at '+Math.floor((r.position_seconds||0)/60)+' min',{variant:String(first.id),resume:'1'}):'')+'</div><h2>Choose a source</h2>';
        content+=variants.map(v=>'<div class="source"><span>'+h(v.source_name+' / '+v.quality_tier)+'</span>'+action(csrf,'play',id,'Play',{variant:String(v.id)})+'</div>').join('');
      }else content+='<p>No playable sources.</p>';
      if(r.kind==='channel'){const guide=storedGuide(id);content+='<h2>Programme guide</h2>'+guide.programmes.map(p=>'<div class="source"><strong>'+h(p.title)+'</strong><span>'+h(p.start+' - '+p.end)+'</span></div>').join('');if(!guide.programmes.length)content+='<p>No imported guide data.</p>';}
    }
    return page(r.title,link('/tv/browse?kind='+e(r.kind==='channel'?'channel':r.kind==='game'?'game':'library'),'Back to browse')+content);
  }
  if(path==='/tv/settings'){
    const activity=user.role==='admin'?d.activity():null;
    return page('Settings','<p>Signed in as '+h(user.username)+' / '+h(user.role)+'</p><p>Hearthwave '+h(d.version)+' / TV compatibility mode</p>'+
      (activity?'<p>Administrator maintenance: '+(activity.busy?'Running':'Idle')+'. Manage sources and imports from the full interface.</p>':'')+
      action(csrf,'logout',0,'Sign out')+link('/?modern=1','Full interface'));
  }
  return page('Page not found',link('/tv','Home'),404);
}
