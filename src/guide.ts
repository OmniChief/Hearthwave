import { providerXmlStream, ProviderError } from './adapters/network.ts';
import { finishGuideImport, writeGuideChannels, writeGuideProgrammes, type GuideChannelInput, type GuideFeed, type GuideProgrammeInput } from './db.ts';

type GuideRecord = { type:'channel'; value:GuideChannelInput } | { type:'programme'; value:GuideProgrammeInput };

function unescapeXml(value:string):string {
  const raw=value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/,'$1').replace(/<[^>]*>/g,'');
  return raw.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_whole,entity:string)=> {
    switch(entity.toLowerCase()) { case 'amp':return '&';case 'lt':return '<';case 'gt':return '>';case 'quot':return '"';case 'apos':return "'"; }
    const code=entity.toLowerCase().startsWith('#x') ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
    return Number.isInteger(code) && code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : '';
  }).replace(/\s+/g,' ').trim();
}

function attr(text:string,key:string):string {
  const pattern=new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i');
  const match=pattern.exec(text);
  return unescapeXml(match?.[1] ?? match?.[2] ?? '');
}
function value(text:string,tag:string):string {
  const match=new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,'i').exec(text);
  return match ? unescapeXml(match[1]) : '';
}

export function xmltvTime(text:string):number|null {
  const match=/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
  if (year<2020 || year>2100 || month<1 || month>12 || day<1 || day>31 || hour>23 || minute>59 || second>59) return null;
  const offset=match[7] ? (match[7]==='+'?1:-1)*(Number(match[8])*60+Number(match[9])) : 0;
  if (Math.abs(offset)>14*60) return null;
  const stamp=(Date.UTC(year,month-1,day,hour,minute,second)-offset*60_000)/1000;
  return Number.isFinite(stamp) ? stamp : null;
}

/** Bounded incremental reader for the channel/programme subset of XMLTV. */
export class XmltvParser {
  private decoder=new TextDecoder('utf-8',{fatal:true});
  private pending='';
  private closed=false;
  private entries=0;
  private onRecord:(record:GuideRecord)=>void;
  constructor(onRecord:(record:GuideRecord)=>void) { this.onRecord=onRecord; }

  feed(chunk:Buffer):void { this.process(this.decoder.decode(chunk,{stream:true})); }
  finish():void {
    this.process(this.decoder.decode());
    if (!this.closed || this.entries===0) throw new ProviderError('Guide XMLTV document was incomplete or empty.');
  }
  private process(text:string):void {
    this.pending+=text;
    if (/<\/tv\s*>/i.test(this.pending)) this.closed=true;
    while (true) {
      const start=this.pending.search(/<(?:channel|programme)\b/i);
      if (start<0) { this.pending=this.pending.slice(-128); break; }
      if (start>0) this.pending=this.pending.slice(start);
      const opening=/^<(channel|programme)\b[^>]*>/i.exec(this.pending);
      if (!opening) {
        if (this.pending.length>16_384) throw new ProviderError('Guide XMLTV opening tag is too long.');
        break;
      }
      const tag=opening[1].toLowerCase();
      const closing=new RegExp(`<\\/${tag}\\s*>`,'i');
      const tail=closing.exec(this.pending.slice(opening[0].length));
      if (!tail) {
        if (this.pending.length>256*1024) throw new ProviderError('A guide programme exceeded the element size limit.');
        break;
      }
      const end=opening[0].length+tail.index+tail[0].length;
      const body=this.pending.slice(opening[0].length,end-tail[0].length);
      this.pending=this.pending.slice(end);
      if (tag==='channel') {
        const id=attr(opening[0],'id').slice(0,200);
        const name=value(body,'display-name').slice(0,200);
        const iconTag=/<icon\b[^>]*>/i.exec(body)?.[0] || '';
        const icon=attr(iconTag,'src').slice(0,500);
        if (id && name) {
          this.onRecord({type:'channel',value:{id,name,icon:/^https?:\/\//i.test(icon) ? icon : ''}});
          this.entries++;
        }
      } else {
        const channelId=attr(opening[0],'channel').slice(0,200);
        const start=xmltvTime(attr(opening[0],'start'));
        const endTime=xmltvTime(attr(opening[0],'stop'));
        const title=value(body,'title').slice(0,250);
        const description=value(body,'desc').slice(0,1500);
        const now=Math.floor(Date.now()/1000);
        if (channelId && start!==null && endTime!==null && start<endTime && endTime>=now-7200 && start<=now+10*86400 && title) {
          this.onRecord({type:'programme',value:{channelId,start,end:endTime,title,description}});
          this.entries++;
        }
      }
    }
  }
}

export async function importXmltv(feed:GuideFeed,generation:string,onProgress:(channels:number,programmes:number)=>void=()=>{}):Promise<{channels:number;programmes:number}> {
  let channels:GuideChannelInput[]=[];
  let programmes:GuideProgrammeInput[]=[];
  let channelCount=0;
  let programmeCount=0;
  const flush=()=> {
    if (channels.length) { writeGuideChannels(feed.id,generation,channels); channels=[]; }
    if (programmes.length) { writeGuideProgrammes(feed.id,generation,programmes); programmes=[]; }
    onProgress(channelCount,programmeCount);
  };
  const parser=new XmltvParser(record=> {
    if (record.type==='channel') {
      if (++channelCount>20_000) throw new ProviderError('Guide has more than 20,000 channels.');
      channels.push(record.value);
    } else {
      if (++programmeCount>250_000) throw new ProviderError('Guide has more than 250,000 programme entries.');
      programmes.push(record.value);
    }
    if (channels.length>=128 || programmes.length>=128) flush();
  });
  await providerXmlStream(feed.location,chunk=>parser.feed(chunk));
  parser.finish();
  flush();
  finishGuideImport(feed.id,generation,channelCount,programmeCount);
  return {channels:channelCount,programmes:programmeCount};
}
