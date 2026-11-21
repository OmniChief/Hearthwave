import test from 'node:test';
import assert from 'node:assert/strict';
import { isHlsUrl, prepareMedia } from '../web/hls-playback.js';

function video(native = '') {
  return { src: '', loads: 0, canPlayType: () => native, load() { this.loads++; } };
}

class MockHls {
  static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', ERROR: 'error' };
  static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
  static isSupported() { return true; }
  constructor(config) { this.config=config;this.handlers=new Map();this.destroyed=false;this.recovered=0;this.restarted=0; }
  on(event, handler) {this.handlers.set(event, handler);}
  emit(event, data) {this.handlers.get(event)?.(event,data);}
  attachMedia(media) {this.media=media;this.emit(MockHls.Events.MEDIA_ATTACHED);}
  loadSource(address) {this.source=address;}
  recoverMediaError() {this.recovered++;}
  startLoad() {this.restarted++;}
  destroy() {this.destroyed=true;}
}

test('recognises HLS paths and explicit format hints', () => {
  assert.equal(isHlsUrl('https://provider.test/live.m3u8?token=abc'),true);
  assert.equal(isHlsUrl('https://provider.test/live?output=m3u8'),true);
  assert.equal(isHlsUrl('https://provider.test/live?type=M3U8'),true);
  assert.equal(isHlsUrl('https://provider.test/film.mp4'),false);
  assert.equal(isHlsUrl('https://provider.test/live?format=ts'),false);
});

test('ordinary video uses native video without loading the HLS library', async () => {
  const media=video();let ready=0,engine='';
  const dispose=await prepareMedia(media,'https://provider.test/movie.mp4',{alive:()=>true,ready:()=>ready++,onEngine:name=>engine=name,fatal:()=>assert.fail('Unexpected error')});
  assert.equal(media.src,'https://provider.test/movie.mp4');
  assert.equal(media.loads,1);
  assert.equal(ready,1);
  assert.equal(engine,'Native video');
  dispose();
});

test('HLS library loads lazily, starts after manifest, and cleans up', async () => {
  delete globalThis.Hls;
  let appended=0,instance;
  globalThis.document={
    createElement:()=>({}),
    head:{appendChild(script) {
      appended++;
      assert.equal(script.src,'/vendor/hls.light.min.js');
      queueMicrotask(()=>{globalThis.Hls=class extends MockHls {constructor(config){super(config);instance=this;}};script.onload();});
    }}
  };
  const media=video();let ready=0,selected='';
  const dispose=await prepareMedia(media,'https://provider.test/master.m3u8',{alive:()=>true,ready:()=>ready++,onEngine:name=>selected=name,fatal:()=>assert.fail('Unexpected fatal error')});
  assert.equal(appended,1);
  assert.equal(selected,'HLS.js');
  assert.equal(instance.source,'https://provider.test/master.m3u8');
  assert.equal(ready,0);
  instance.emit(MockHls.Events.MANIFEST_PARSED);
  assert.equal(ready,1);
  dispose();
  assert.equal(instance.destroyed,true);
  delete globalThis.document;
});

test('fatal media and network errors retry once, then fall back', async () => {
  let instance;
  globalThis.Hls=class extends MockHls {constructor(config){super(config);instance=this;}};
  const messages=[];
  const dispose=await prepareMedia(video(),'https://provider.test/live.m3u8',{alive:()=>true,ready:()=>{},fatal:(message,code)=>messages.push({message,code})});
  const fatal=(type)=>instance.emit(MockHls.Events.ERROR,{fatal:true,type});
  instance.emit(MockHls.Events.ERROR,{fatal:false,type:MockHls.ErrorTypes.NETWORK_ERROR});
  assert.equal(instance.restarted,0);
  fatal(MockHls.ErrorTypes.MEDIA_ERROR);
  assert.equal(instance.recovered,1);
  fatal(MockHls.ErrorTypes.NETWORK_ERROR);
  assert.equal(instance.restarted,1);
  fatal(MockHls.ErrorTypes.NETWORK_ERROR);
  assert.match(messages[0].message,/CORS/);
  assert.equal(messages[0].code,'hls-network');
  dispose();
});

test('native HLS is tried after an MSE error on a dual-capability TV', async () => {
  let instance,engine='',started=0,failed=0;
  globalThis.Hls=class extends MockHls {constructor(config){super(config);instance=this;}};
  const media=video('probably');
  const dispose=await prepareMedia(media,'https://provider.test/live.m3u8',{alive:()=>true,ready:()=>started++,onEngine:name=>engine=name,fatal:()=>failed++});
  assert.equal(engine,'HLS.js');
  instance.emit(MockHls.Events.ERROR,{fatal:true,type:MockHls.ErrorTypes.NETWORK_ERROR});
  assert.equal(instance.restarted,1);
  instance.emit(MockHls.Events.ERROR,{fatal:true,type:MockHls.ErrorTypes.NETWORK_ERROR});
  assert.equal(engine,'Native HLS');
  assert.equal(instance.destroyed,true);
  assert.equal(media.src,'https://provider.test/live.m3u8');
  assert.equal(started,1);
  instance.emit(MockHls.Events.ERROR,{fatal:true,type:MockHls.ErrorTypes.MEDIA_ERROR});
  assert.equal(failed,0);
  dispose();
});

test('stale HLS player does not load source or start playback', async () => {
  let instance,active=true,started=0;
  globalThis.Hls=class extends MockHls {constructor(config){super(config);instance=this;}};
  const dispose=await prepareMedia(video(),'https://provider.test/live.m3u8',{alive:()=>active,ready:()=>started++,fatal:()=>{}});
  active=false;
  instance.emit(MockHls.Events.MANIFEST_PARSED);
  assert.equal(started,0);
  dispose();
  const second=await prepareMedia(video(),'https://provider.test/other.m3u8',{alive:()=>active,ready:()=>started++,fatal:()=>{}});
  assert.equal(started,0);
  assert.equal(instance.destroyed,true);
  second();
});

test('native HLS fallback and no-compatible-engine error', async () => {
  globalThis.Hls=class extends MockHls {static isSupported(){return false;}};
  const media=video('probably');let started=0,selected='';
  const dispose=await prepareMedia(media,'https://provider.test/live.m3u8',{alive:()=>true,ready:()=>started++,onEngine:name=>selected=name,fatal:()=>{}});
  assert.equal(media.src,'https://provider.test/live.m3u8');
  assert.equal(started,1);
  assert.equal(selected,'Native HLS');
  dispose();
  await assert.rejects(prepareMedia(video(),'https://provider.test/live.m3u8',{alive:()=>true,ready:()=>{},fatal:()=>{}}),/neither native HLS/);
  delete globalThis.Hls;
});
