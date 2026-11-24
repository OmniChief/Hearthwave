export function spacePages({page,state,api,esc,notify,rooms}) {
  const button=(label,action,id,extra='')=>'<button type="button" class="button button-quiet button-small" data-space-action="'+action+'" data-id="'+Number(id)+'" '+extra+'>'+esc(label)+'</button>';
  const form=(action,contents,label)=>'<form class="field-stack" data-space-form="'+action+'">'+contents+'<button class="button button-primary" type="submit">'+label+'</button></form>';
  const surface=(title,content)=>'<section class="surface"><h2>'+title+'</h2>'+content+'</section>';
  const row=(title,details,actions='')=>'<div class="list-row"><div><strong>'+esc(title)+'</strong><small>'+esc(details)+'</small></div><div class="row-actions">'+actions+'</div></div>';
  const date=value=>new Date(value).toLocaleString();
  let searchResults=[],query='',busy=false;
  const post=(url,body,method='POST')=>api(url,{method,body});
  async function render(section){
    const uid=state.session?.user.id;
    if(section==='my-space'){
      const [events,files]=await Promise.all([api('/api/space/events'),api('/api/space/files')]);
      if(state.page!==section||state.session?.user.id!==uid)return;
      const calendar=surface('Personal calendar',form('event','<label>Event<input name="title" maxlength="120" required></label><label>Date and time<input name="starts" type="datetime-local" required></label><label>Notes<textarea name="notes" maxlength="2000"></textarea></label>','Add event')+'<div class="list">'+(events.items.map(e=>row(e.title,date(e.starts)+(e.notes?' · '+e.notes:''),button('Delete','event-delete',e.id))).join('')||'<p>No events yet.</p>')+'</div>');
      const fileList=files.items.map(f=>{
        const actions=(f.received===f.size?'<a class="button button-quiet button-small" href="/api/space/files/'+f.id+'/download" download>Download</a>':'')+(f.own?button('Delete','file-delete',f.id):'');
        const shared=files.shares.filter(s=>s.file_id===f.id);
        return row(f.name,(f.received/1048576).toFixed(2)+' / '+(f.size/1048576).toFixed(2)+' MiB · '+(f.own?'Your file':'Shared by '+f.owner),actions)+(f.own&&f.received===f.size?form('share','<input type="hidden" name="id" value="'+f.id+'"><label>Share with an accepted friend<input name="username" required maxlength="50"></label>','Share file')+shared.map(s=>row('Shared with '+s.username,'',button('Revoke','revoke',f.id,'data-recipient="'+s.id+'"'))).join(''):'');
      }).join('');
      page.innerHTML='<div class="feature-grid">'+calendar+surface('Private file exchange','<p>64 MiB per file, 256 MiB per account. Interrupted uploads can resume by selecting the same file.</p>'+form('upload','<label>Choose a file<input type="file" name="file" required></label><progress id="space-upload-progress" max="1" value="0" hidden></progress>','Upload file')+(fileList||'<p>No files yet.</p>'))+'</div>';
    } else if(section==='community'){
      const [friends,reviews]=await Promise.all([api('/api/community/friends'),api('/api/community/reviews')]);
      if(state.page!==section||state.session?.user.id!==uid)return;
      const roomContents=await rooms.contents(friends.items);
      if(state.page!==section||state.session?.user.id!==uid)return;
      const friendships=friends.items.map(f=>row(f.username,f.accepted?'Friend':f.outgoing?'Request sent':'Incoming request',(!f.accepted&&!f.outgoing?button('Accept','friend-accept',f.id):'')+button(f.accepted?'Remove':f.outgoing?'Cancel':'Decline','friend-delete',f.id))).join('');
      const reviewList=reviews.items.map(r=>row(r.title,r.username+' · '+r.rating+'/5 · '+r.review,r.own?button('Delete','review-delete',r.title_id):'')).join('');
      const options=searchResults.map(t=>'<option value="'+t.id+'">'+esc(t.title+(t.year?' ('+t.year+')':'')+' · '+t.kind)+'</option>').join('');
      page.innerHTML='<div class="feature-grid">'+surface('Friends',form('friend','<label>Username<input name="username" required maxlength="50"></label>','Send friend request')+(friendships||'<p>No friends yet.</p>'))+surface('Media reviews','<p>Reviews are visible only to you and your accepted friends.</p>'+form('search','<label>Find a title<input name="query" required maxlength="80" value="'+esc(query)+'"></label>','Search')+(options?form('review','<label>Title<select name="titleId">'+options+'</select></label><label>Rating<select name="rating">'+[5,4,3,2,1].map(n=>'<option value="'+n+'">'+n+'/5</option>').join('')+'</select></label><label>Review<textarea name="review" maxlength="2000"></textarea></label>','Save review'):(query?'<p>No matching titles.</p>':''))+(reviewList||'<p>No reviews yet.</p>'))+roomContents+'</div>';
    }
  }
  async function submit(event){
    const f=event.target,action=f.dataset.spaceForm;if(!action)return;
    event.preventDefault();if(busy)return;busy=true;
    const section=state.page,uid=state.session?.user.id,submit=f.querySelector('button[type=submit]');submit.disabled=true;
    const x=new FormData(f);
    try{
      if(action==='event')await post('/api/space/events',{title:x.get('title'),starts:new Date(x.get('starts')).toISOString(),notes:x.get('notes')});
      if(action==='friend')await post('/api/community/friends',{username:x.get('username')});
      if(action==='search'){query=String(x.get('query'));searchResults=(await api('/api/community/titles?q='+encodeURIComponent(query))).items;}
      if(action==='review')await post('/api/community/reviews',{titleId:Number(x.get('titleId')),rating:Number(x.get('rating')),review:x.get('review')});
      if(action==='share')await post('/api/space/files/'+Number(x.get('id'))+'/share',{username:x.get('username')});
      if(action==='upload'){
        const file=x.get('file');if(!(file instanceof File)||file.size>64*1024*1024)throw new Error('Choose a file no larger than 64 MiB.');
        const upload=await post('/api/space/files',{name:file.name,size:file.size,modified:file.lastModified});
        let offset=upload.received;const progress=f.querySelector('progress');progress.hidden=false;progress.max=Math.max(1,file.size);progress.value=offset;
        while(offset<file.size){
          if(state.session?.user.id!==uid)throw new Error('Upload interrupted.');
          const bytes=new Uint8Array(await file.slice(offset,offset+256*1024).arrayBuffer());
          let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          offset=(await post('/api/space/files/'+upload.id+'/chunk',{offset,data:btoa(binary)})).received;progress.value=offset;
        }
        notify('File uploaded.');
      }
      if(state.page===section&&state.session?.user.id===uid)await render(section);
    }catch(error){notify(error.message,true);}finally{busy=false;submit.disabled=false;}
  }
  async function click(event){
    const target=event.target.closest('[data-space-action]');if(!target||busy)return;
    const action=target.dataset.spaceAction,id=Number(target.dataset.id),section=state.page;
    const routes={'event-delete':['/api/space/events/','DELETE'],'file-delete':['/api/space/files/','DELETE'],'friend-delete':['/api/community/friends/','DELETE'],'friend-accept':['/api/community/friends/','PATCH'],'review-delete':['/api/community/reviews/','DELETE']};
    if(action==='file-delete'&&!confirm('Delete this file and all its shares?'))return;
    busy=true;target.disabled=true;
    try{
      if(action==='revoke')await post('/api/space/files/'+id+'/share/'+Number(target.dataset.recipient),undefined,'DELETE');
      else if(routes[action])await post(routes[action][0]+id,undefined,routes[action][1]);
      if(state.page===section)await render(section);
    }catch(error){notify(error.message,true);}finally{busy=false;target.disabled=false;}
  }
  return {render,submit,click,reset(){searchResults=[];query='';}};
}
