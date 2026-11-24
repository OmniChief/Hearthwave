export function requestPages({page,state,api,esc,notify}){
  let matches={},busy=false;
  const post=(path,body,method='POST')=>api(path,{method,body});
  const button=(action,id,label)=>'<button class="button button-quiet button-small" data-request-action="'+action+'" data-id="'+id+'">'+label+'</button>';
  async function render(){
    const user=state.session.user;
    const result=await api('/api/requests'+(user.role==='admin'?'?all=1':''));
    if(state.page!=='library'||!state.requestView||state.session?.user.id!==user.id)return;
    const cards=result.items.map(r=>{
      const admin=user.role==='admin';
      const actions=(r.user_id===user.id&&['pending','approved'].includes(r.status)?button('cancelled',r.id,'Cancel'):'')+
        (admin&&r.status==='pending'?button('approved',r.id,'Approve')+button('rejected',r.id,'Reject'):'')+
        (r.status==='fulfilled'&&r.available?'<button class="button button-quiet button-small" data-request-action="open" data-id="'+r.title_id+'">Open in Library</button>':'');
      const found=matches[r.id];
      const fulfill=admin&&r.status==='approved'?'<form class="field-stack" data-request-form="search"><input type="hidden" name="id" value="'+r.id+'"><label>Find matching Library title<input name="query" value="'+esc(found?.query||r.title)+'" maxlength="150" required></label><button class="button button-quiet button-small" type="submit">Search Library</button></form>'+
        (found?.items.length?'<form class="field-stack" data-request-form="fulfill"><input type="hidden" name="id" value="'+r.id+'"><label>Fulfil with<select name="titleId">'+found.items.map(t=>'<option value="'+t.id+'">'+esc(t.title+(t.year?' ('+t.year+')':''))+'</option>').join('')+'</select></label><button class="button button-primary button-small" type="submit">Mark fulfilled</button></form>':found?'<p>No matching titles yet. Add or scan an authorised source and try again.</p>':''):'';
      return '<section class="surface"><div class="list-row"><div><strong>'+esc(r.title+(r.year?' ('+r.year+')':''))+'</strong><small>'+esc(r.kind+' · '+r.username+' · '+r.status)+'</small><small>'+esc(r.notes)+'</small>'+(r.decision?'<p>'+esc(r.decision)+'</p>':'')+(r.status==='fulfilled'&&!r.available?'<p>The linked title is no longer available.</p>':'')+'</div><div class="row-actions">'+actions+'</div></div>'+fulfill+'</section>';
    }).join('');
    page.innerHTML='<div class="section-heading"><div><h2>Media requests</h2><p>Ask for films and series. Administrators approve requests and link them to available Library titles.</p></div><button class="button button-quiet" data-request-action="back">← Library</button></div><section class="surface"><h2>Request a title</h2><form class="field-stack" data-request-form="create"><label>Type<select name="kind"><option value="film">Film</option><option value="series">Series</option></select></label><label>Title<input name="title" required maxlength="150"></label><label>Release year (optional)<input name="year" type="number" min="1880" max="2100"></label><label>Notes<textarea name="notes" maxlength="1000"></textarea></label><button class="button button-primary" type="submit">Submit request</button></form></section>'+ (cards||'<section class="surface"><p>No media requests yet.</p></section>');
  }
  async function submit(event){
    const f=event.target,action=f.dataset.requestForm;if(!action)return;event.preventDefault();if(busy)return;
    busy=true;const b=f.querySelector('button[type=submit]');b.disabled=true;
    try{
      const x=Object.fromEntries(new FormData(f));
      if(action==='create')await post('/api/requests',{kind:x.kind,title:x.title,year:x.year?Number(x.year):null,notes:x.notes});
      if(action==='search')matches[x.id]={query:x.query,items:(await api('/api/requests/'+Number(x.id)+'/matches?q='+encodeURIComponent(x.query))).items};
      if(action==='fulfill'){await post('/api/requests/'+Number(x.id),{status:'fulfilled',titleId:Number(x.titleId)},'PATCH');delete matches[x.id];}
      await render();
    }catch(error){notify(error.message,true);}finally{busy=false;b.disabled=false;}
  }
  async function click(event,redraw){
    const b=event.target.closest('[data-request-action]');if(!b||busy)return;
    const action=b.dataset.requestAction,id=Number(b.dataset.id);
    if(action==='back'||action==='open'){
      state.requestView=false;state.detailId=action==='open'?id:null;await redraw();return;
    }
    busy=true;b.disabled=true;
    try{
      let decision='';
      if(action==='rejected'){const note=prompt('Optional reason for rejecting this request:','');if(note===null)return;decision=note.slice(0,1000);}
      await post('/api/requests/'+id,{status:action,decision},'PATCH');await render();
    }catch(error){notify(error.message,true);}finally{busy=false;b.disabled=false;}
  }
  return {render,submit,click,reset(){matches={};}};
}
