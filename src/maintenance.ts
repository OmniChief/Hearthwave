import { db, enrichTitleMetadata } from './db.ts';
import { lookupLocalFilm } from './local-films.ts';
import { fetchGameArtwork, clearGameArtworkCache } from './games.ts';
import { ProviderError } from './adapters/network.ts';

export type MetadataKind='film'|'game';
export interface MetadataJob {
  kind:MetadataKind; phase:'running'|'cancelling'|'completed'|'cancelled'|'error';
  total:number; processed:number; matched:number; missed:number; failed:number; current:string;
  started:number; finished:number; error:string; cancelRequested:boolean;
}
let job:MetadataJob|null=null;
export const metadataStatus=()=>job;
export const metadataBusy=()=>job?.phase==='running'||job?.phase==='cancelling';
export function cancelMetadata(){if(metadataBusy()&&job){job.cancelRequested=true;job.phase='cancelling';}}
let metadataSchemaReady=false;
function ensureMetadataSchema(){if(metadataSchemaReady)return;db.exec("CREATE TABLE IF NOT EXISTS manual_metadata_attempts(title_id INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,attempted INTEGER NOT NULL)");metadataSchemaReady=true;}
type Candidate={id:number;title:string;year:number|null;artwork:string;description:string;path:string};
const candidateSql=(kind:MetadataKind,retry:boolean)=>" FROM titles t WHERE t.kind=? AND "+
  (kind==='film'?"(COALESCE(t.artwork,'')='' OR COALESCE(t.description,'')='')":"COALESCE(t.artwork,'')=''")+
  " AND EXISTS(SELECT 1 FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.title_id=t.id AND s.type='folder')"+
  (retry?'':" AND NOT EXISTS(SELECT 1 FROM manual_metadata_attempts a WHERE a.title_id=t.id AND a.attempted>?)");
export function startMetadata(kind:MetadataKind,retry=false,limit=500):MetadataJob{
  if(metadataBusy())throw new Error('A metadata job is already running.');
  ensureMetadataSchema();
  const since=Date.now()-86400000,params=retry?[kind]:[kind,since];
  const where=candidateSql(kind,retry);
  const total=Math.min(limit,Number(db.prepare('SELECT COUNT(*) AS n'+where).get(...params)?.n||0));
  const j:MetadataJob={kind,phase:'running',total,processed:0,matched:0,missed:0,failed:0,current:'',started:Date.now(),finished:0,error:'',cancelRequested:false};
  job=j;
  void (async()=>{
    // Keep only one candidate and one external request chain in flight.
    const next=db.prepare("SELECT t.id,t.title,t.year,t.artwork,t.description,(SELECT v.source_ref FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.title_id=t.id AND s.type='folder' ORDER BY v.id LIMIT 1) AS path"+where+" AND t.id>? ORDER BY t.id LIMIT 1");
    const attempted=db.prepare('INSERT INTO manual_metadata_attempts(title_id,attempted) VALUES(?,?) ON CONFLICT(title_id) DO UPDATE SET attempted=excluded.attempted');
    const updateGame=db.prepare("UPDATE titles SET artwork=? WHERE id=? AND kind='game' AND COALESCE(artwork,'')=''");
    let cursor=0;
    try{
      while(j.processed<j.total&&!j.cancelRequested){
        const row=next.get(...params,cursor) as Candidate|undefined;
        if(!row)break;
        cursor=row.id;j.current=row.title;
        try{
          let matched=false;
          if(kind==='game'){
            const cover=await fetchGameArtwork(row.path);
            if(cover)matched=!!updateGame.run(cover,row.id).changes;
          }else{
            const info=await lookupLocalFilm(row.title,row.year);
            if(info){
              if(row.artwork)delete info.artwork;
              if(row.description)delete info.description;
              matched=enrichTitleMetadata(row.id,info);
            }
          }
          attempted.run(row.id,Date.now());
          if(matched)j.matched++;else j.missed++;
        }catch(e){
          j.failed++;
          j.error=e instanceof Error?e.message.slice(0,250):'Metadata lookup failed.';
          if(e instanceof ProviderError&&e.status===429){j.processed++;j.phase='error';break;}
          // Stop rather than hammer a failed external service.
          if(j.failed>=3){j.processed++;j.phase='error';break;}
        }
        j.processed++;
        if(!j.cancelRequested&&j.processed<j.total)await new Promise<void>(r=>setTimeout(r,kind==='film'?1000:100));
      }
      if(j.phase!=='error')j.phase=j.cancelRequested?'cancelled':'completed';
    }catch(e){j.phase='error';j.error=e instanceof Error?e.message.slice(0,250):'Metadata job failed.';}
    finally{j.current='';j.finished=Date.now();clearGameArtworkCache();}
  })();
  return j;
}
