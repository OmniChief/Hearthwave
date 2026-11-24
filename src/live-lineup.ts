import {db,transaction} from './db.ts';
import {channelKey,channelCountry,channelGenre,displayChannelTitle} from './catalogue.ts';

export type LineupProgress={phase:'running'|'completed'|'error';stage:string;processed:number;total:number;stations:number;matched:number;unmatched:number;ambiguous:number;error:string};
type Station={id:number;country:string;name:string;guideId:string;feed:number};
type GuideRow={feed_id:number;channel_id:string;name:string;icon:string;country:string};
type Stream={id:number;title_id:number;original_title_id:number|null;name:string;country:string;artwork:string;epg_id:string;group_name:string;canonical_key:string;original_key:string|null;title_name:string;title_country:string;live_genre:string;manual_feed:number|null;manual_channel:string|null};
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
function region(id:string,name:string,country:string):string {
  return country||channelCountry(name)||({uk:'GB',gb:'GB',us:'US',usa:'US',ca:'CA'} as Record<string,string>)[id.toLowerCase().match(/[._-](uk|gb|us|usa|ca)$/)?.[1]||'']||'';
}
function nameKey(name:string):string {
  const stripped=name.replace(/^\s*\[(?:UK|GB|US|USA|CA|EN|ENGLISH)\]\s*/i,'').replace(/^\s*(?:UK|GB|US|USA|CA|EN|ENGLISH)\s*[:|–-]\s*/i,'');
  return channelKey(stripped).replace(/\b(bbc)\s+(one|two|three|four)\b/g,(_m,p,n)=>p+' '+({one:'1',two:'2',three:'3',four:'4'} as Record<string,string>)[n]).replace(/\s+/g,'');
}
function exactId(id:string){return id.trim().toLowerCase();}
function add(map:Map<string,Station[]>,key:string,station:Station){
  if(!key)return;
  const list=map.get(key)||[];
  if(!list.some(s=>s.id===station.id)){list.push(station);map.set(key,list);}
}
function compatible(stations:Station[],country:string):Station[]{
  return stations.filter(s=>!country||!s.country||s.country===country);
}
function choose(stations:Station[],country:string):Station|undefined {
  const eligible=compatible(stations,country);
  const preferred=country?eligible.filter(s=>s.country===country):eligible;
  const candidates=preferred.length?preferred:eligible;
  return candidates.length===1?candidates[0]:undefined;
}
export async function rebuildLiveLineup(job:LineupProgress):Promise<void>{
  const count=Number(db.prepare('SELECT COUNT(*) AS n FROM guide_channels c JOIN guide_feeds f ON f.id=c.feed_id AND f.generation=c.generation').get()?.n||0);
  if(count>60000)throw Error('The combined guides exceed 60,000 stations. Remove unused feeds before rebuilding.');
  const guides=db.prepare('SELECT c.feed_id,c.channel_id,c.name,c.icon,f.country FROM guide_channels c JOIN guide_feeds f ON f.id=c.feed_id AND f.generation=c.generation ORDER BY f.id,c.channel_id').all() as GuideRow[];
  const byId=new Map<string,Station[]>(),byName=new Map<string,Station[]>(),byFeed=new Map<string,Station>(),byKey=new Map<string,Station>();
  const insert=db.prepare("INSERT INTO titles(canonical_key,kind,title,channel_key,channel_country,artwork,live_genre) VALUES (?,'channel',?,?,?,?,?) ON CONFLICT(canonical_key) DO UPDATE SET title=excluded.title,channel_key=excluded.channel_key,channel_country=excluded.channel_country,artwork=COALESCE(NULLIF(excluded.artwork,''),titles.artwork),live_genre=CASE WHEN excluded.live_genre='Other' THEN titles.live_genre ELSE excluded.live_genre END RETURNING id");
  const link=db.prepare('INSERT OR IGNORE INTO live_epg_links(title_id,feed_id,channel_id) VALUES(?,?,?)');
  job.stage='Indexing guide stations';job.total=guides.length;job.processed=0;
  for(let start=0;start<guides.length;start+=128){
    transaction(()=>{
      for(const row of guides.slice(start,start+128)){
        const country=region(row.channel_id,row.name,row.country),key='channel:epg-station:'+country+':'+exactId(row.channel_id);
        let station=byKey.get(key);
        if(!station){
          const genre=channelGenre(row.name,/\b(?:BBC\s*(?:One|Two|1|2)|ITV\s*1?|Channel\s*[45])\b/i.test(row.name)?'General':'');
          const id=Number(insert.get(key,row.name,channelKey(row.name),country,row.icon,genre)?.id);
          station={id,country,name:row.name,guideId:row.channel_id,feed:row.feed_id};byKey.set(key,station);
          add(byId,exactId(row.channel_id),station);add(byName,nameKey(row.name),station);
        }
        link.run(station.id,row.feed_id,row.channel_id);
        byFeed.set(row.feed_id+'\0'+row.channel_id,station);
        add(byName,nameKey(row.name),station);
        job.processed++;
      }
    });
    job.stations=byKey.size;await pause();
  }
  // Drop only obsolete guide associations; source streams, titles and user data are retained.
  db.prepare('DELETE FROM live_epg_links WHERE NOT EXISTS(SELECT 1 FROM guide_feeds f JOIN guide_channels c ON c.feed_id=f.id AND c.generation=f.generation WHERE f.id=live_epg_links.feed_id AND c.channel_id=live_epg_links.channel_id)').run();
  const read=db.prepare(`SELECT v.id,v.title_id,v.epg_id,v.group_name,t.canonical_key,t.title AS title_name,t.channel_country AS title_country,t.live_genre,
    r.original_title_id,r.name,r.country,COALESCE(r.artwork,t.artwork,'') AS artwork,ot.canonical_key AS original_key,
    COALESCE(m.feed_id,om.feed_id) AS manual_feed,COALESCE(m.channel_id,om.channel_id) AS manual_channel
    FROM variants v JOIN titles t ON t.id=v.title_id
    LEFT JOIN live_variant_identity r ON r.variant_id=v.id LEFT JOIN titles ot ON ot.id=r.original_title_id
    LEFT JOIN guide_mappings m ON m.title_id=t.id LEFT JOIN guide_mappings om ON om.title_id=r.original_title_id
    WHERE t.kind='channel' AND v.id>? ORDER BY v.id LIMIT 128`);
  const remember=db.prepare('INSERT OR IGNORE INTO live_variant_identity(variant_id,original_title_id,name,country,artwork) VALUES(?,?,?,?,?)');
  const move=db.prepare('UPDATE variants SET title_id=? WHERE id=?');
  const addFav=db.prepare('INSERT OR IGNORE INTO favourites(user_id,title_id) SELECT user_id,? FROM favourites WHERE title_id=?');
  const removeFav=db.prepare("DELETE FROM favourites WHERE title_id=? AND NOT EXISTS(SELECT 1 FROM variants WHERE title_id=?) AND NOT EXISTS(SELECT 1 FROM live_epg_links WHERE title_id=?)");
  const fillGenre=db.prepare("UPDATE titles SET live_genre=? WHERE id=? AND live_genre='Other' AND ?<>'Other'");
  const orphan=db.prepare("INSERT INTO titles(canonical_key,kind,title,channel_key,channel_country,artwork,live_genre) VALUES (?,'channel',?,?,?,?,?) ON CONFLICT(canonical_key) DO UPDATE SET artwork=COALESCE(NULLIF(titles.artwork,''),excluded.artwork) RETURNING id");
  job.stage='Matching provider streams';job.processed=0;job.total=Number(db.prepare("SELECT COUNT(*) AS n FROM variants v JOIN titles t ON t.id=v.title_id WHERE t.kind='channel'").get()?.n||0);
  let cursor=0;
  for(;;){
    const streams=read.all(cursor) as Stream[];if(!streams.length)break;
    transaction(()=>{
      for(const row of streams){
        const name=row.name||row.title_name,country=row.country||channelCountry(name,row.group_name)||row.title_country||'';
        const original=row.original_title_id||row.title_id;
        remember.run(row.id,original,name,country,row.artwork);
        const manual=row.manual_feed&&row.manual_channel?byFeed.get(row.manual_feed+'\0'+row.manual_channel):undefined;
        const exact=byId.get(exactId(row.epg_id||''))||[],names=byName.get(nameKey(name))||[];
        const matches=compatible(exact,country);
        // A conflicting exact ID must never be overridden by a fuzzy name.
        const station=manual||(exact.length?choose(exact,country):choose(names,country));
        let target=row.title_id;
        if(station){
          target=station.id;job.matched++;fillGenre.run(row.live_genre,target,row.live_genre);
        }else{
          job.unmatched++;if((exact.length&&!matches.length)||matches.length>1||(!exact.length&&compatible(names,country).length>1))job.ambiguous++;
          // Old provider identity is retained unless it was an EPG station. Distinct
          // EPG IDs remain distinct for unmatched streams instead of guessing.
          if(row.canonical_key.startsWith('channel:epg-station:')||row.original_key?.startsWith('channel:epg-station:')){
            const key='channel:unmatched:'+country+':'+(row.epg_id?'epg:'+exactId(row.epg_id):nameKey(name));
            target=Number(orphan.get(key,displayChannelTitle(name),channelKey(name),country,row.artwork,channelGenre(name,row.group_name))?.id);
          }else if(row.original_title_id&&row.original_key)target=row.original_title_id;
        }
        if(target!==row.title_id){move.run(target,row.id);addFav.run(target,row.title_id);removeFav.run(row.title_id,row.title_id,row.title_id);}
        job.processed++;
      }
    });
    cursor=streams[streams.length-1].id;await pause();
  }
}
