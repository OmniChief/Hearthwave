import { basename, dirname, extname } from 'node:path';
import { providerJson } from './adapters/network.ts';

const systems = [
  ['segaMD','Sega - Mega Drive - Genesis','gen smd md','mega drive|megadrive|genesis'],
  ['snes','Nintendo - Super Nintendo Entertainment System','smc sfc fig swc','snes|super nintendo'],
  ['n64','Nintendo - Nintendo 64','n64 v64 z64','n64|nintendo 64'],
  ['psx','Sony - PlayStation','pbp','ps1|psx|playstation'],
  ['nes','Nintendo - Nintendo Entertainment System','nes unf unif','nes|famicom'],
  ['gba','Nintendo - Game Boy Advance','gba','gba|game boy advance'],
  ['gb','Nintendo - Game Boy Color','gbc','gbc|game boy color'],
  ['gb','Nintendo - Game Boy','gb','gb|game boy'],
  ['nds','Nintendo - Nintendo DS','nds','nds|nintendo ds'],
  ['segaMS','Sega - Master System - Mark III','sms','sms|master system'],
  ['segaGG','Sega - Game Gear','gg','game gear'],
  ['sega32x','Sega - 32X','32x','32x'],
  ['segaCD','Sega - Mega-CD - Sega CD','','sega cd|mega cd'],
  ['segaSaturn','Sega - Saturn','','saturn'],
  ['atari2600','Atari - 2600','a26','atari 2600'],
  ['atari7800','Atari - 7800','a78','atari 7800'],
  ['lynx','Atari - Lynx','lnx','lynx'],
  ['pce','NEC - PC Engine - TurboGrafx 16','pce','pc engine|turbografx'],
  ['ngp','SNK - Neo Geo Pocket','ngp','neo geo pocket'],
  ['ngp','SNK - Neo Geo Pocket Color','ngc','neo geo pocket color'],
  ['ws','Bandai - WonderSwan','ws','wonderswan'],
  ['ws','Bandai - WonderSwan Color','wsc','wonderswan color'],
  ['arcade','FBNeo - Arcade Games','','arcade|mame|fbneo'],
  ['amiga','Commodore - Amiga','adf','amiga'],
  ['vice_x64sc','Commodore - 64','d64','commodore 64|c64']
].map(([core,label,formats,folders])=>({core,label,formats:formats.split(' ').filter(Boolean),folders:new RegExp('^(?:'+folders+')$','i')}));

export function gameSystem(path:string) {
  const ext=extname(path).slice(1).toLowerCase();
  const direct=systems.find(s=>s.formats.includes(ext));
  if(direct) return direct;
  for(const folder of dirname(path).split(/[\\/]/).reverse()) {
    const system=systems.find(s=>s.folders.test(folder.replace(/[_-]+/g,' ').trim()));
    if(system) return system;
  }
}

export function isCartridgeBin(path:string) {
  return extname(path).toLowerCase()==='.bin' && gameSystem(path)?.core==='segaMD';
}

function titleKey(value:string) {
  return value.normalize('NFKD').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g,'')
    .replace(/[^a-z0-9]+/g,'');
}

type Tree = {tree:{path:string;sha:string}[]};
const covers=new Map<string,{until:number; result:Promise<Map<string,string>>}>();
async function coverIndex(label:string) {
  const repo=label.replace(/ /g,'_');
  const base='https://api.github.com/repos/libretro-thumbnails/'+repo+'/git/trees/';
  const root=await providerJson(base+'master') as Tree;
  const folder=root.tree.find(entry=>entry.path==='Named_Boxarts');
  const result=new Map<string,string>();
  if(!folder) return result;
  const files=await providerJson(base+folder.sha) as Tree;
  // Prefer a US cover when a release name omits the region.
  for(const {path} of files.tree) {
    if(!path.endsWith('.png')) continue;
    const name=path.slice(0,-4);
    const url='https://raw.githubusercontent.com/libretro-thumbnails/'+repo+'/master/Named_Boxarts/'+encodeURIComponent(path);
    result.set(name.toLowerCase(),url);
    const key=titleKey(name);
    if(!result.has(key) || /\(USA\)/.test(name)) result.set(key,url);
  }
  return result;
}

export async function gameInfo(path:string) {
  const system=gameSystem(path);
  const filename=basename(path);
  if(!system) return {filename,core:'',system:'',cover:''};
  let cache=covers.get(system.label);
  if(!cache || cache.until<Date.now()) {
    const entry={until:Date.now()+86400000,result:coverIndex(system.label).catch(()=>{
      entry.until=Date.now()+60000;
      return new Map<string,string>();
    })};
    cache=entry; covers.set(system.label,entry);
  }
  const index=await cache.result;
  const name=basename(filename,extname(filename));
  return {filename,core:system.core,system:system.label,cover:index.get(name.toLowerCase()) || index.get(titleKey(name)) || ''};
}
