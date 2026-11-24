import type {User} from './model.ts';
import { libraryGenres } from './library-genres.ts';
export type LoungeCall=(method:'GET'|'POST'|'PATCH'|'DELETE',path:string,values?:Record<string,unknown>)=>Promise<any>;
type Page={section:string;title:string;body:string};
type Result={section:string;title:string;route?:string;body?:string};
const h=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const url=(screen:string,values:Record<string,string|number>={})=>'/tv?'+new URLSearchParams([['screen',screen],...Object.entries(values).map(([k,v])=>[k,String(v)])]).toString();
const link=(to:string,label:string)=>'<a class="chip" href="'+h(to)+'">'+h(label)+'</a>';
const field=(key:string,value:unknown)=>'<input type="hidden" name="'+h(key)+'" value="'+h(value)+'">';
const text=(key:string,label:string,max=120,type='text')=>'<label class="feature-field">'+h(label)+'<input name="'+h(key)+'" type="'+type+'" maxlength="'+max+'"></label>';
const area=(key:string,label:string,max=1000)=>'<label class="feature-field">'+h(label)+'<textarea name="'+h(key)+'" rows="3" cols="30" maxlength="'+max+'"></textarea></label>';
const select=(key:string,label:string,options:Array<[string,string]>)=>'<label class="feature-field">'+h(label)+'<select name="'+h(key)+'">'+options.map(([value,name])=>'<option value="'+h(value)+'">'+h(name)+'</option>').join('')+'</select></label>';
const form=(csrf:string,op:string,fields:Record<string,unknown>,content:string,label:string,cls='featureform')=>'<form class="'+cls+'" method="post" action="/tv/submit">'+field('csrf',csrf)+field('op','feature.'+op)+Object.entries(fields).map(([k,v])=>field(k,v)).join('')+content+'<input class="commit" type="submit" value="'+h(label)+'"></form>';
const button=(csrf:string,op:string,fields:Record<string,unknown>,label:string)=>form(csrf,op,fields,'',label,'smallform');
const panel=(heading:string,body:string)=>'<div class="panel"><h2>'+h(heading)+'</h2>'+body+'</div>';
const note=(value:unknown)=>'<p class="caption">'+h(value)+'</p>';
const date=(value:unknown)=>{const d=new Date(typeof value==='number'?value:String(value??''));return Number.isFinite(d.getTime())?d.toLocaleString('en-GB'):'';};
const rows=(items:any[],row:(item:any)=>string)=>items.length?items.slice(0,100).map(item=>'<div class="feature-row">'+row(item)+'</div>').join(''):note('Nothing to display.');
const num=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw Error('Choose a valid item.');return n;};
const id=(f:URLSearchParams,key='id')=>num(f.get(key));
const get=(f:URLSearchParams,key:string)=>f.get(key)||'';
const admin=(u:User)=>{if(u.role!=='admin')throw Error('Administrator access required.');};
const tabs=(screen:string,items:Array<[string,string]>)=>'<div class="toolbar">'+items.map(([tab,label])=>link(url(screen,{tab}),label)).join('')+'</div>';
const settingsTabs:Array<[string,string]>=[['sources','Sources'],['metadata','Metadata & Guide'],['users','Users & Access'],['system','System']];
function collectionRules(c:any={}){
  const choose=(key:string,label:string,choices:Array<[string,string]>,value:string)=>'<label class="feature-field">'+h(label)+'<select name="'+key+'">'+choices.map(([k,n])=>'<option value="'+h(k)+'"'+(k===value?' selected="selected"':'')+'>'+h(n)+'</option>').join('')+'</select></label>';
  const input=(key:string,label:string,value:unknown,max:number)=>'<label class="feature-field">'+h(label)+'<input type="text" name="'+key+'" value="'+h(value)+'" maxlength="'+max+'"></label>';
  return choose('kind','Media type',[['all','All media'],['film','Films'],['series','Series'],['episode','Episodes'],['music','Music'],['photo','Photos']],c.rule_kind||'all')+choose('genre','Genre',[['','Any'],...libraryGenres.map(g=>[g,g] as [string,string])],c.rule_genre||'')+choose('view','Watch status',[['all','Any'],['favourites','Favourites'],['continue','In progress'],['unwatched','Not started']],c.rule_view||'all')+input('yearFrom','Year from',c.rule_year_from,4)+input('yearTo','Year to',c.rule_year_to,4)+input('query','Title contains',c.rule_query,80);
}
export async function renderLoungeFeature(screen:string,p:URLSearchParams,user:User,csrf:string,call:LoungeCall):Promise<Page|null>{
  if(screen==='collections'||screen==='collection-edit'){
    const data=await call('GET','/api/collections');
    if(screen==='collection-edit'){
      const cid=num(p.get('id')),c=data.collections.find((row:any)=>row.id===cid);if(!c)throw Error('Collection not found.');
      return {section:'saved',title:c.name,body:panel('Manage collection',link(url('browse',{kind:'library',collection:cid}),'Open collection')+form(csrf,'collection-rename',{id:cid},'<label class="feature-field">Name<input name="name" type="text" maxlength="70" value="'+h(c.name)+'"></label>','Rename')+(c.mode==='smart'?form(csrf,'collection-rules',{id:cid},collectionRules(c),'Save smart rules'):'')+link(url('collection-remove',{id:cid}),'Remove collection'))};
    }
    return {section:'saved',title:'Collections',body:panel('Your collections',rows(data.collections,c=>'<strong>'+h(c.name)+'</strong>'+note(c.mode==='smart'?'Smart collection':c.item_count+' titles')+link(url('browse',{kind:'library',collection:c.id}),'Open')+link(url('collection-edit',{id:c.id}),'Manage')))+panel('New collection',form(csrf,'collection-create',{mode:'manual'},text('name','Name',70),'Create collection'))+panel('New smart collection',form(csrf,'collection-create',{mode:'smart'},text('name','Name',70)+collectionRules(),'Create smart collection'))};
  }
  if(screen==='collection-remove'){
    const cid=num(p.get('id')),data=await call('GET','/api/collections'),c=data.collections.find((row:any)=>row.id===cid);if(!c)throw Error('Collection not found.');
    return {section:'saved',title:'Remove collection',body:panel('Confirm removal',note('Remove '+c.name+'? Media files and titles are retained.')+button(csrf,'collection-remove',{id:cid},'Remove')+link(url('collection-edit',{id:cid}),'Cancel'))};
  }
  if(screen==='guide-mapping'){
    admin(user);const cid=num(p.get('id')),q=(p.get('q')||'').slice(0,120),data=await call('GET','/api/titles/'+cid+'/guide/mapping'),matches=q?await call('GET','/api/guide/channels?q='+encodeURIComponent(q)):{channels:[]};
    return {section:'live',title:'Map programme guide',body:panel('Current mapping',note(data.mapping?data.mapping.name:'Automatic matching')+(data.mapping?button(csrf,'guide-unmap',{id:cid},'Use automatic matching'):''))+'<form action="/tv" method="get">'+field('screen','guide-mapping')+field('id',cid)+text('q','Search imported guide')+'<input class="commit" type="submit" value="Search"></form>'+rows(matches.channels,c=>'<strong>'+h(c.name)+'</strong>'+note(c.source)+button(csrf,'guide-map',{id:cid,feed:c.feed_id,channel:c.channel_id},'Use channel'))};
  }
  if(screen==='requests'){
    const data=await call('GET','/api/requests'+(user.role==='admin'?'?all=1':''));
    let body=panel('Request a film or series',form(csrf,'request',{},select('kind','Type',[['film','Film'],['series','Series']])+text('title','Title',150)+text('year','Release year (optional)',4)+area('notes','Notes'),'Submit request'));
    body+=panel('Media requests',rows(data.items,r=>{
      let actions=r.user_id===user.id&&['pending','approved'].includes(r.status)?button(csrf,'request-state',{id:r.id,status:'cancelled'},'Cancel'):'';
      if(user.role==='admin'&&r.status==='pending')actions+=button(csrf,'request-state',{id:r.id,status:'approved'},'Approve')+button(csrf,'request-state',{id:r.id,status:'rejected'},'Reject');
      if(user.role==='admin'&&r.status==='approved')actions+=link(url('request-matches',{id:r.id}),'Find matching title');
      if(r.available&&r.title_id)actions+=link(url('item',{id:r.title_id}),'Open title');
      return '<strong>'+h(r.title)+' '+h(r.year||'')+'</strong> <span class="status">'+h(r.status)+'</span>'+note(r.notes)+actions;
    }));
    return {section:'library',title:'Media requests',body};
  }
  if(screen==='request-matches'){
    admin(user);const rid=num(p.get('id')),q=(p.get('q')||'').slice(0,150),data=await call('GET','/api/requests/'+rid+'/matches'+(q?'?q='+encodeURIComponent(q):''));
    return {section:'library',title:'Match a request',body:'<form action="/tv" method="get">'+field('screen','request-matches')+field('id',rid)+text('q','Search library')+'<input class="commit" type="submit" value="Search"></form>'+rows(data.items,r=>'<strong>'+h(r.title)+' '+h(r.year||'')+'</strong>'+button(csrf,'request-state',{id:rid,status:'fulfilled',titleId:r.id},'Fulfil'))};
  }
  if(screen==='community'){
    const tab=p.get('tab')||'friends',navigation=tabs('community',[['friends','Friends'],['reviews','Reviews'],['rooms','Watch rooms']]);
    if(tab==='reviews'){
      const data=await call('GET','/api/community/reviews'),q=p.get('q')||'',matches=q?await call('GET','/api/community/titles?q='+encodeURIComponent(q.slice(0,80))):{items:[]};
      const search='<form action="/tv" method="get">'+field('screen','community')+field('tab','reviews')+text('q','Find a title')+'<input class="commit" type="submit" value="Find"></form>';
      const edit=matches.items.length?rows(matches.items,r=>'<strong>'+h(r.title)+'</strong>'+form(csrf,'review',{id:r.id},select('rating','Rating',[['5','5 stars'],['4','4 stars'],['3','3 stars'],['2','2 stars'],['1','1 star']])+area('review','Review',2000),'Save review')):'';
      return {section:'community',title:'Community',body:navigation+panel('Write a review',search+edit)+panel('Friends and your reviews',rows(data.items,r=>'<strong>'+h(r.title)+' &middot; '+h(r.rating)+'/5</strong>'+note(r.username)+note(r.review)+(r.own?button(csrf,'review-delete',{id:r.title_id},'Remove review'):'')))};
    }
    if(tab==='rooms'){
      const data=await call('GET','/api/community/rooms'),friends=await call('GET','/api/community/friends'),q=p.get('q')||'';
      const matches=q?await call('GET','/api/community/rooms/titles?q='+encodeURIComponent(q.slice(0,80))):{items:[]};
      const roomSearch='<form action="/tv" method="get">'+field('screen','community')+field('tab','rooms')+text('q','Find a film or episode')+'<input class="commit" type="submit" value="Find"></form>';
      const accepted=friends.items.filter(f=>f.accepted).map(f=>[String(f.id),f.username] as [string,string]);
      return {section:'community',title:'Watch rooms',body:navigation+panel('Your rooms',rows(data.items,r=>'<strong>'+h(r.title)+'</strong>'+note('Host: '+r.host)+link(url('room',{id:r.id}),'Open room')))+panel('Create a room',roomSearch+(accepted.length?rows(matches.items,r=>'<strong>'+h(r.title)+'</strong>'+form(csrf,'room-create',{id:r.id},select('friend','Invite friend',accepted),'Create room')):note('Add an accepted friend before creating a room.')))};
    }
    const data=await call('GET','/api/community/friends');
    return {section:'community',title:'Community',body:navigation+panel('Find friends',form(csrf,'friend',{},text('username','Account username',50),'Send request'))+panel('Friends and requests',rows(data.items,r=>'<strong>'+h(r.username)+'</strong>'+note(r.accepted?'Friends':r.outgoing?'Request sent':'Incoming request')+(!r.accepted&&!r.outgoing?button(csrf,'friend-accept',{id:r.id},'Accept'):'')+button(csrf,'friend-delete',{id:r.id},r.accepted?'Remove':'Decline / cancel')))};
  }
  if(screen==='room'){
    const rid=num(p.get('id')),data=await call('GET','/api/community/rooms/'+rid),r=data.room;
    return {section:'community',title:r.title,body:panel('Watch room',note('Members: '+data.members.map((m:any)=>m.username).join(', '))+note('Host position: '+Math.floor(r.position/60)+' min. The host controls shared playback.')+'<form class="smallform" action="/tv/submit" method="post">'+field('csrf',csrf)+field('op','watch')+field('id',r.titleId)+field('room',rid)+'<input class="commit" type="submit" value="Join playback"></form>'+link(url('room',{id:rid}),'Refresh room')+button(csrf,'room-delete',{id:rid},r.own?'Close room':'Leave room')+(r.own?form(csrf,'room-invite',{id:rid},select('friend','Invite an accepted friend',(await call('GET','/api/community/friends')).items.filter((f:any)=>f.accepted).map((f:any)=>[String(f.id),f.username])),'Invite') :''))+panel('Chat',rows(data.messages,m=>'<strong>'+h(m.username)+'</strong>'+note(m.message))+form(csrf,'room-chat',{id:rid},area('message','Message'),'Send'))};
  }
  if(screen==='my-space'){
    const tab=p.get('tab')||'calendar',navigation=tabs('my-space',[['calendar','Calendar'],['files','Files']]);
    if(tab==='files'){
      const data=await call('GET','/api/space/files');
      return {section:'my-space',title:'My Space',body:navigation+panel('Your files',rows(data.items,f=>'<strong>'+h(f.name)+'</strong>'+note(f.owner+' / '+Math.round(f.size/1024)+' KB')+(f.received===f.size?link('/api/space/files/'+f.id+'/download','Download'):'')+(f.own?button(csrf,'file-delete',{id:f.id},'Delete')+(f.received===f.size?form(csrf,'file-share',{id:f.id},text('username','Share with friend',50),'Share'):'')+(data.shares||[]).filter((s:any)=>s.file_id===f.id).map((s:any)=>button(csrf,'file-revoke',{id:f.id,friend:s.id},'Stop sharing with '+s.username)).join(''):'') ))+note('File upload requires a browser with the File API.'))};
    }
    const data=await call('GET','/api/space/events');
    return {section:'my-space',title:'My Space',body:navigation+panel('New calendar event',form(csrf,'event',{},text('title','Event title')+text('starts','Date and time (YYYY-MM-DD HH:mm, server local time)',16)+area('notes','Notes',2000),'Save event'))+panel('Calendar',rows(data.items,r=>'<strong>'+h(r.title)+'</strong>'+note(date(r.starts))+note(r.notes)+button(csrf,'event-delete',{id:r.id},'Delete event')))};
  }
  if(screen==='create'){
    const workers=await call('GET','/api/jobs/workers'),jobs=await call('GET','/api/jobs'+(user.role==='admin'?'?all=1':''));
    let body=panel('Downloads & Workers',rows(workers.items,w=>'<strong>'+h(w.name)+'</strong>'+note((w.online?'Online':'Offline')+' / '+w.capabilities.join(', '))+(user.role==='admin'?button(csrf,'worker-delete',{id:w.id},'Revoke'):'')));
    if(user.role==='admin'){
      body+=panel('Pair a worker',form(csrf,'worker-pair',{},text('name','Worker name',80),'Pair worker')+link('/api/jobs/agent','Download worker agent'));
      const options=workers.items.map(w=>[String(w.id),w.name] as [string,string]);
      if(options.length)body+=panel('Create a job',form(csrf,'job',{},select('worker','Worker',options)+select('kind','Task',[['download','Download'],['convert','Convert file'],['image','Generate image'],['video','Generate video']])+text('name','File name (download / conversion)',180)+text('url','Download URL',2048)+select('format','Conversion format',[['mp4','MP4'],['webm','WebM'],['mp3','MP3'],['flac','FLAC']])+area('prompt','Generation prompt',4000),'Queue job'));
    }
    return {section:'create',title:'Create',body:body+panel('Jobs',link(url('create'),'Refresh progress')+rows(jobs.items,j=>'<strong>'+h(j.kind)+' &middot; '+h(j.status)+'</strong>'+note(j.worker+' / '+j.username)+note(j.message)+(j.progress?note(j.progress.phase+' / '+j.progress.done+(j.progress.total?' of '+j.progress.total:'')):'')+(j.own&&j.file_id&&j.output_received===j.output_size?link('/api/space/files/'+j.file_id+'/download','Download result'):'')+(j.status!=='running'?button(csrf,'job-delete',{id:j.id},'Remove job'):'')))};
  }
  if(screen!=='admin')return null;
  admin(user);const tab=p.get('tab')||'sources',navigation=tabs('admin',settingsTabs);
  if(tab==='categories'){
    const sid=num(p.get('id')),data=await call('GET','/api/sources/'+sid+'/categories');
    const categories=data.categories as any[],kind=p.get('kind')||'live',page=Math.max(0,Math.min(1000,Math.floor(Number(p.get('page'))||0))),limit=40,filtered=categories.filter(c=>c.kind===kind),visible=filtered.slice(page*limit,(page+1)*limit);
    // Individual toggles avoid clearing unshown selections and bound TV page size.
    return {section:'settings',title:'Provider categories',body:navigation+['live','vod','series'].map(k=>link(url('admin',{tab:'categories',id:sid,kind:k}),k)).join('')+rows(visible,c=>'<strong>'+h(c.name)+'</strong>'+button(csrf,'category',{id:sid,kind:c.kind,category:c.category_id,enabled:c.selected?'no':'yes'},c.selected?'✓ Selected':'Select'))+(page?link(url('admin',{tab:'categories',id:sid,kind,page:page-1}),'Previous'):'')+(filtered.length>(page+1)*limit?link(url('admin',{tab:'categories',id:sid,kind,page:page+1}),'Next'):'')};
  }
  if(tab==='sources'){
    const data=await call('GET','/api/sources');
    const list=rows(data.sources,r=>{const j=data.jobs?.[r.id];return '<strong>'+h(r.name)+' &middot; '+h(r.type)+'</strong>'+note(r.status)+(r.last_error?note(r.last_error):'')+(j?note(j.phase+' / '+j.indexed+' indexed / '+j.seen+' seen / '+j.folder):'')+(r.type==='stalker'||r.type==='xtream'?button(csrf,'source-action',{id:r.id,action:'discover'},'Discover folders')+link(url('admin',{tab:'categories',id:r.id}),'Select folders'):'')+(r.type!=='direct'?button(csrf,'source-action',{id:r.id,action:'scan'},'Scan'):'')+(j&&['running','cancelling'].includes(j.phase)?button(csrf,'source-action',{id:r.id,action:'cancel'},'Cancel scan'):'')+link(url('admin',{tab:'source-remove',id:r.id}),'Remove');});
    const add=form(csrf,'source-add',{},select('type','Type',[['folder','Local folder'],['direct','Direct channel'],['m3u','M3U playlist'],['xtream','Xtream'],['stalker','Stalker']])+text('name','Name',100)+text('location','Path / URL',2048)+text('username','Provider username',512)+text('password','Provider password',512,'password')+text('mac','Stalker MAC',17)+text('serial','Serial',512)+text('deviceId','Device ID',512)+text('deviceId2','Device ID 2',512)+select('allowLan','Allow local provider',[['no','No'],['yes','Yes']]),'Add source');
    return {section:'settings',title:'Sources',body:navigation+panel('Configured sources',link(url('admin',{tab:'sources'}),'Refresh status')+list)+panel('Add a source',add)};
  }
  if(tab==='source-remove'){
    const sid=num(p.get('id')),data=await call('GET','/api/sources'),r=data.sources.find((s:any)=>s.id===sid);if(!r)throw Error('Source no longer exists.');
    return {section:'settings',title:'Remove source',body:panel('Confirm removal',note('Remove '+r.name+' and its indexed entries? Local media files are not deleted.')+button(csrf,'source-remove',{id:sid},'Remove source')+link(url('admin',{tab:'sources'}),'Cancel'))};
  }
  if(tab==='metadata'){
    const activity=await call('GET','/api/system/activity'),data=await call('GET','/api/guide/feeds'),j=activity.metadata;
    return {section:'settings',title:'Metadata & Guide',body:navigation+panel('Metadata',link(url('admin',{tab:'metadata'}),'Refresh progress')+(j?note(j.phase+' / '+j.processed+' of '+j.total+' / '+(j.current||'')+' / '+j.error):note('No metadata job started.'))+button(csrf,'metadata',{kind:'film'},'Fetch film metadata')+button(csrf,'metadata',{kind:'game'},'Fetch game artwork')+(j&&['running','cancelling'].includes(j.phase)?button(csrf,'metadata-cancel',{},'Cancel'):''))+panel('XMLTV feeds',rows(data.feeds,f=>'<strong>'+h(f.name)+'</strong>'+note(f.status+' / '+f.channel_count+' channels / '+f.programme_count+' programmes')+(f.job?note(f.job.phase+' / '+f.job.channels+' channels / '+f.job.programmes+' programmes'):'')+button(csrf,'guide-import',{id:f.id},'Import guide'))+form(csrf,'guide-add',{},text('name','Feed name',100)+text('location','XMLTV URL',2048)+select('country','Region',[['','All'],['GB','UK'],['US','US']]),'Add guide'))};
  }
  if(tab==='users'){
    const data=await call('GET','/api/users');
    return {section:'settings',title:'Users & Access',body:navigation+panel('Accounts',rows(data.users,u=>'<strong>'+h(u.username)+'</strong>'+note(u.role)))+panel('Create account',form(csrf,'user-add',{},text('username','Username',50)+text('password','Password (at least 12 characters)',256,'password')+select('role','Role',[['viewer','Viewer'],['admin','Administrator']]),'Create account'))};
  }
  if(tab==='system'){
    const status=await call('GET','/api/system/status'),update=await call('GET','/api/system/update/status');
    return {section:'settings',title:'System',body:navigation+panel('Server overview',note('Version '+status.version+' / SQLite schema '+status.schema)+note('Memory '+Math.round(status.rssBytes/1048576)+' MiB / Database '+Math.round(status.databaseBytes/1048576)+' MiB'))+panel('Built-in updater',note(update.message)+link(url('admin',{tab:'system'}),'Refresh status')+link(url('admin',{tab:'update'}),'Check GitHub'))+panel('Backup',note('Download a consistent database and encrypted configuration snapshot. Keep it private.')+button(csrf,'backup',{},'Download backup'))};
  }
  if(tab==='update'){
    const u=await call('GET','/api/system/update/check');
    return {section:'settings',title:'Built-in updater',body:navigation+panel('GitHub update',note(u.message)+note('Installed '+u.currentVersion+' / Latest '+u.latestVersion)+(u.available?button(csrf,'update',{sha:u.latestSha},'Install verified update'):''))};
  }
  return {section:'settings',title:'Settings',body:navigation};
}
export async function submitLoungeFeature(op:string,f:URLSearchParams,user:User,call:LoungeCall):Promise<Result>{
  const v=(key:string)=>get(f,key),section=op.startsWith('feature.collection')?'saved':op.startsWith('feature.request')?'library':op.startsWith('feature.friend')||op.startsWith('feature.review')||op.startsWith('feature.room')?'community':op.startsWith('feature.event')||op.startsWith('feature.file')?'my-space':op.startsWith('feature.job')||op.startsWith('feature.worker')?'create':'settings';
  const result:Result={section,title:'Operation completed'};
  const rules=()=>({kind:v('kind'),genre:v('genre'),view:v('view'),query:v('query'),yearFrom:v('yearFrom')?Number(v('yearFrom')):null,yearTo:v('yearTo')?Number(v('yearTo')):null});
  switch(op){
    case 'feature.collection-create':await call('POST','/api/collections',{name:v('name'),mode:v('mode'),...(v('mode')==='smart'?{rules:rules()}:{})});break;
    case 'feature.collection-rename':await call('PATCH','/api/collections/'+id(f),{name:v('name')});break;
    case 'feature.collection-rules':await call('PATCH','/api/collections/'+id(f)+'/rules',{rules:rules()});break;
    case 'feature.collection-remove':await call('DELETE','/api/collections/'+id(f));result.body=link(url('collections'),'Return to collections');break;
    case 'feature.guide-refresh':admin(user);await call('POST','/api/titles/'+id(f)+'/guide');break;
    case 'feature.guide-map':admin(user);await call('POST','/api/titles/'+id(f)+'/guide/mapping',{feedId:id(f,'feed'),channelId:v('channel')});break;
    case 'feature.guide-unmap':admin(user);await call('DELETE','/api/titles/'+id(f)+'/guide/mapping');break;
    case 'feature.title-metadata':admin(user);await call('POST','/api/titles/'+id(f)+'/metadata/refresh');break;
    case 'feature.request':await call('POST','/api/requests',{kind:v('kind'),title:v('title'),year:v('year')?Number(v('year')):null,notes:v('notes')});break;
    case 'feature.request-state':await call('PATCH','/api/requests/'+id(f),{status:v('status'),...(v('titleId')?{titleId:id(f,'titleId')}:{})});break;
    case 'feature.friend':await call('POST','/api/community/friends',{username:v('username')});break;
    case 'feature.friend-accept':await call('PATCH','/api/community/friends/'+id(f));break;
    case 'feature.friend-delete':await call('DELETE','/api/community/friends/'+id(f));break;
    case 'feature.review':await call('POST','/api/community/reviews',{titleId:id(f),rating:Number(v('rating')),review:v('review')});break;
    case 'feature.review-delete':await call('DELETE','/api/community/reviews/'+id(f));break;
    case 'feature.room-create':await call('POST','/api/community/rooms',{titleId:id(f),friendId:id(f,'friend')});break;
    case 'feature.room-invite':await call('POST','/api/community/rooms/'+id(f)+'/invite',{friendId:id(f,'friend')});break;
    case 'feature.room-chat':await call('POST','/api/community/rooms/'+id(f)+'/chat',{message:v('message')});break;
    case 'feature.room-delete':await call('DELETE','/api/community/rooms/'+id(f));result.body=link(url('community',{tab:'rooms'}),'Return to rooms');break;
    case 'feature.event':{
      const raw=v('starts');if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw))throw Error('Use YYYY-MM-DD HH:mm.');
      const d=new Date(raw.replace(' ','T')+':00');if(!Number.isFinite(d.getTime()))throw Error('Invalid date or time.');
      await call('POST','/api/space/events',{title:v('title'),starts:d.toISOString(),notes:v('notes')});break;
    }
    case 'feature.event-delete':await call('DELETE','/api/space/events/'+id(f));break;
    case 'feature.file-delete':await call('DELETE','/api/space/files/'+id(f));break;
    case 'feature.file-share':await call('POST','/api/space/files/'+id(f)+'/share',{username:v('username')});break;
    case 'feature.file-revoke':await call('DELETE','/api/space/files/'+id(f)+'/share/'+id(f,'friend'));break;
    case 'feature.worker-pair':{admin(user);const w=await call('POST','/api/jobs/workers',{name:v('name')});result.title='Pair your worker';result.body=panel('One-time pairing token','<p class="pair-token">'+h(w.token)+'</p>'+note('Keep this token private. Enter it on your trusted worker computer.')+link(url('create'),'Return to workers'));break;}
    case 'feature.worker-delete':admin(user);await call('DELETE','/api/jobs/workers/'+id(f));break;
    case 'feature.job':admin(user);await call('POST','/api/jobs',{kind:v('kind'),workerId:id(f,'worker'),name:v('name'),url:v('url'),format:v('format'),prompt:v('prompt')});break;
    case 'feature.job-delete':await call('DELETE','/api/jobs/'+id(f));break;
    case 'feature.source-add':admin(user);await call('POST','/api/sources',{type:v('type'),name:v('name'),location:v('location'),config:{username:v('username'),password:v('password'),mac:v('mac'),serial:v('serial'),deviceId:v('deviceId'),deviceId2:v('deviceId2'),allowLan:v('allowLan')==='yes'}});break;
    case 'feature.source-action':admin(user);if(!['scan','discover','cancel'].includes(v('action')))throw Error('Unknown source operation.');await call('POST','/api/sources/'+id(f)+'/'+v('action'));break;
    case 'feature.source-remove':admin(user);await call('DELETE','/api/sources/'+id(f));result.body=link(url('admin',{tab:'sources'}),'Return to sources');break;
    case 'feature.category':{
      admin(user);const path='/api/sources/'+id(f)+'/categories',data=await call('GET',path);
      const selected=data.categories.filter(c=>c.selected&&!(c.kind===v('kind')&&c.category_id===v('category'))).map(c=>({kind:c.kind,id:c.category_id}));
      if(v('enabled')==='yes'){if(!data.categories.some(c=>c.kind===v('kind')&&c.category_id===v('category')))throw Error('Folder not found.');selected.push({kind:v('kind'),id:v('category')});}
      await call('POST',path,{selected});break;
    }
    case 'feature.metadata':admin(user);await call('POST','/api/system/metadata',{kind:v('kind')});break;
    case 'feature.metadata-cancel':admin(user);await call('POST','/api/system/metadata/cancel');break;
    case 'feature.guide-add':admin(user);await call('POST','/api/guide/feeds',{name:v('name'),location:v('location'),country:v('country')});break;
    case 'feature.guide-import':admin(user);await call('POST','/api/guide/feeds/'+id(f)+'/import');break;
    case 'feature.user-add':admin(user);await call('POST','/api/users',{username:v('username'),password:v('password'),role:v('role')});break;
    case 'feature.update':admin(user);await call('POST','/api/system/update/install',{sha:v('sha')});result.body=panel('Update started',note('Hearthwave will restart when the verified update is ready.')+link(url('admin',{tab:'system'}),'Check update progress'));break;
    default:throw Error('Unknown action.');
  }
  return result;
}
