import { constants } from 'node:fs';
import { opendir, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { VariantRow } from './db.ts';

export interface SubtitleFile { path:string;language:string;label:string;extension:'.srt'|'.vtt' }
const maxSubtitleBytes=2*1024*1024;
const languageNames:Record<string,string>={en:'English',eng:'English',es:'Spanish',spa:'Spanish',fr:'French',fre:'French',de:'German',ger:'German',it:'Italian',pt:'Portuguese',nl:'Dutch',ja:'Japanese',ko:'Korean'};

function inside(root:string,path:string):boolean {
  const rel=relative(root,path);
  return rel!=='' && rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Detect only adjacent, regular, small sidecar subtitles for an authorised folder variant. */
export async function localSubtitles(variant:VariantRow):Promise<SubtitleFile[]> {
  if (variant.source_type!=='folder') return [];
  if (!['.mp4','.m4v','.mkv','.avi','.mov','.webm'].includes(extname(variant.url).toLowerCase())) return [];
  const root=await realpath(variant.source_location);
  const media=await realpath(variant.url);
  if (!inside(root,media)) return [];
  const directory=dirname(media);
  const stem=basename(media,extname(media));
  const candidates:SubtitleFile[]=[];
  const handle=await opendir(directory);
  let examined=0;
  for await (const entry of handle) {
    if (++examined>4096 || candidates.length>=32) break;
    if (!entry.isFile()) continue;
    const extension=extname(entry.name).toLowerCase();
    if (extension!=='.srt' && extension!=='.vtt') continue;
    const prefix=entry.name.slice(0,-extension.length);
    if (prefix!==stem && !prefix.startsWith(stem+'.')) continue;
    const suffix=prefix===stem?'':prefix.slice(stem.length+1).toLowerCase();
    if (suffix && !/^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(suffix)) continue;
    try {
      const path=await realpath(join(directory,entry.name));
      if (!inside(root,path)) continue;
      const file=await stat(path);
      if (!file.isFile() || file.size<1 || file.size>maxSubtitleBytes) continue;
      const language=suffix.slice(0,3) || 'und';
      candidates.push({path,language:language==='eng'?'en':language,label:suffix ? (languageNames[suffix] || languageNames[language] || suffix.toUpperCase()) : 'Subtitles',extension:extension as '.srt'|'.vtt'});
    } catch { /* A sidecar that disappears or is unreadable must not prevent video playback. */ }
  }
  return candidates.sort((a,b)=>(a.language==='en'?0:1)-(b.language==='en'?0:1) || a.label.localeCompare(b.label)).slice(0,8);
}

/** Convert subtitles only, never the media stream. Input is capped at 2 MiB. */
export async function subtitleVtt(file:SubtitleFile):Promise<string> {
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let contents:string;
  try {
    const buffer=Buffer.allocUnsafe(maxSubtitleBytes+1);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if (bytesRead>maxSubtitleBytes) throw new Error('Subtitle file exceeds the 2 MiB limit.');
    contents=buffer.toString('utf8',0,bytesRead).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  } finally { await handle.close(); }
  if (file.extension==='.vtt') return contents;
  return `WEBVTT\n\n${contents.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2')}`;
}
