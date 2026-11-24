export function watchRooms({state,page,api,esc,notify,startPlayback}){
  let query='',results=[],active=null,timer=null,busy=false,generation=0;
  const panel=document.querySelector('#watch-room-panel'),video=document.querySelector('#player');
  const base='/api/community/rooms';
  const post=(path,body,method='POST')=>api(base+path,{method,body});
  const friendOptions=friends=>friends.filter(f=>f.accepted).map(f=>'<option value="'+f.id+'">'+esc(f.username)+'</option>').join('');
  const button=(label,action,id)=>'<button class="button button-quiet button-small" data-room-action="'+action+'" data-id="'+id+'">'+label+'</button>';
  async function contents(friends){
    const {items}=await api(base);
    const options=friendOptions(friends);
    return '<section class="surface"><h2>Watch together</h2><p>Invite friends to watch a film or episode. The host controls playback while members chat and stay synchronized using their own available media source.</p>'+
      '<form class="field-stack" data-room-form="search"><label>Find film or episode<input name="query" required maxlength="80" value="'+esc(query)+'"></label><button class="button button-primary" type="submit">Find title</button></form>'+
      (results.length&&options?'<form class="field-stack" data-room-form="create"><label>Title<select name="titleId">'+results.map(t=>'<option value="'+t.id+'">'+esc(t.title+(t.year?' ('+t.year+')':'')+(t.season!=null?' S'+t.season+' E'+t.episode:''))+'</option>').join('')+'</select></label><label>Invite friend<select name="friendId">'+options+'</select></label><button class="button button-primary" type="submit">Create watch room</button></form>':query&&!results.length?'<p>No matching playable films or episodes.</p>':'')+
      (!options?'<p>Accept a friend request to create a watch room.</p>':'')+
      items.map(r=>'<div class="list-row"><div><strong>'+esc(r.title)+'</strong><small>Hosted by '+esc(r.host)+'</small></div><div class="row-actions">'+button('Watch','join',r.id)+button(r.own?'Close room':'Leave room','delete',r.id)+'</div></div>'+
        (r.own&&options?'<form class="field-stack" data-room-form="invite"><input type="hidden" name="room" value="'+r.id+'"><label>Invite another friend<select name="friendId">'+options+'</select></label><button class="button button-quiet button-small" type="submit">Invite</button></form>':'')).join('')+
      (!items.length?'<p>No watch rooms yet.</p>':'')+'</section>';
  }
  async function detach(publish=false){
    const old=active;active=null;generation++;clearTimeout(timer);panel.hidden=true;panel.replaceChildren();
    if(publish&&old?.own&&state.activeTitle?.id===old.titleId&&Number.isFinite(video.currentTime))await post('/'+old.id+'/sync',{position:video.currentTime,playing:false}).catch(()=>{});
  }
  function beforePlayback(title){if(active&&Number(title)!==Number(active.titleId))void detach(true);}
  function show(data){
    const label=panel.querySelector('[data-room-status]');
    if(!label)return;
    label.textContent=(data.room.own?'You are hosting':data.room.hostOnline?'Following '+data.room.host:'Waiting for '+data.room.host)+' · '+data.members.map(m=>m.username).join(', ');
    const log=panel.querySelector('[data-room-chat]'),scroll=log.scrollTop+log.clientHeight>=log.scrollHeight-30;
    const previous=log.dataset.last||'';
    const last=String(data.messages.at(-1)?.id||'');
    if(previous!==last||!log.children.length){
      log.innerHTML=data.messages.map(m=>'<p><strong>'+esc(m.username)+'</strong> · '+esc(new Date(m.created).toLocaleTimeString())+'<br>'+esc(m.message)+'</p>').join('')||'<p>No messages yet.</p>';
      log.dataset.last=last;if(scroll)log.scrollTop=log.scrollHeight;
    }
  }
  async function tick(myGeneration){
    if(!active||myGeneration!==generation||!state.session)return;
    const room=active;
    try{
      if(Number(state.activeTitle?.id)!==Number(room.titleId)){await detach();return;}
      if(room.own&&video.readyState>=2&&Number.isFinite(video.currentTime))await post('/'+room.id+'/sync',{position:video.currentTime,playing:!video.paused&&!video.ended});
      const data=await api(base+'/'+room.id);
      if(myGeneration!==generation||!active)return;
      active=data.room;
      if(!active.own&&video.readyState>=2&&Number.isFinite(video.duration)){
        const position=Math.max(0,Math.min(video.duration,active.position));
        if(Math.abs(video.currentTime-position)>2)video.currentTime=position;
        if(!active.playing&&!video.paused)video.pause();
        if(active.playing&&video.paused&&!video.ended)void video.play().catch(()=>{});
      }
      show(data);
    }catch(error){
      if(myGeneration!==generation)return;
      notify(error.message,true);await detach();return;
    }
    if(myGeneration===generation&&active)timer=setTimeout(()=>void tick(myGeneration),2500);
  }
  async function join(id){
    await detach(true);
    const data=await api(base+'/'+id);
    active=data.room;const myGeneration=++generation;
    try{
      await startPlayback(active.titleId,null,active.position);
      if(myGeneration!==generation||!active)return;
      panel.hidden=false;
      panel.innerHTML='<h3>Watch together</h3><p data-room-status></p><div class="watch-chat" data-room-chat></div><form class="row-actions" data-room-chat-form><input name="message" maxlength="1000" required aria-label="Chat message"><button class="button button-primary button-small" type="submit">Send</button></form><button class="button button-quiet button-small" data-room-stop>Stop synchronization</button>';
      show(data);void tick(myGeneration);
    }catch(error){await detach();throw error;}
  }
  panel.addEventListener('submit',async event=>{
    if(!event.target.hasAttribute('data-room-chat-form'))return;
    event.preventDefault();if(!active)return;
    const f=event.target,button=f.querySelector('button');if(button.disabled)return;button.disabled=true;
    try{await post('/'+active.id+'/chat',{message:new FormData(f).get('message')});f.reset();}catch(error){notify(error.message,true);}finally{button.disabled=false;}
  });
  panel.addEventListener('click',event=>{if(event.target.closest('[data-room-stop]'))void detach(true);});
  async function submit(event,redraw){
    const f=event.target,action=f.dataset.roomForm;if(!action)return;
    event.preventDefault();if(busy)return;busy=true;const b=f.querySelector('button[type=submit]');b.disabled=true;
    try{
      const x=new FormData(f);
      if(action==='search'){query=String(x.get('query'));results=(await api(base+'/titles?q='+encodeURIComponent(query))).items;}
      if(action==='create')await post('',{titleId:Number(x.get('titleId')),friendId:Number(x.get('friendId'))});
      if(action==='invite')await post('/'+Number(x.get('room'))+'/invite',{friendId:Number(x.get('friendId'))});
      if(state.page==='community')await redraw();
    }catch(error){notify(error.message,true);}finally{busy=false;b.disabled=false;}
  }
  async function click(event,redraw){
    const target=event.target.closest('[data-room-action]');if(!target||busy)return;busy=true;target.disabled=true;
    try{
      const id=Number(target.dataset.id);
      if(target.dataset.roomAction==='join')await join(id);
      else{if(active?.id===id)await detach(true);await post('/'+id,undefined,'DELETE');if(state.page==='community')await redraw();}
    }catch(error){notify(error.message,true);}finally{busy=false;target.disabled=false;}
  }
  return {contents,submit,click,detach,beforePlayback,reset(){query='';results=[];void detach();}};
}
