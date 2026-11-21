import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPlaybackCapabilities, connectionAdvice, nativeMediaFailure, playbackReport, streamFormat } from '../web/playback-diagnostics.js';

test('format detection does not expose stream URLs, accounts or query tokens', () => {
  assert.equal(streamFormat('https://user:password@example.invalid/live/a.m3u8?token=secret'),'HLS');
  assert.equal(streamFormat('http://example.invalid/stream?output=m3u8&password=secret'),'HLS');
  assert.equal(streamFormat('/api/media/123/file'),'Unknown');
  assert.equal(streamFormat('https://example.invalid/Movie.MP4?token=secret'),'MP4');
  assert.equal(streamFormat('https://example.invalid/video.ts'),'MPEG-TS');
  assert.equal(streamFormat('https://example.invalid/live'),'Unknown');
});

test('reported browser support avoids a false guarantee', () => {
  const media={canPlayType:mime=>mime.includes('video/mp4; codecs="avc1')?'probably':''};
  const rows=browserPlaybackCapabilities(media,{MediaSource:{isTypeSupported:()=>true}});
  assert.deepEqual(rows[0],['Native HLS','Not reported']);
  assert.deepEqual(rows[1],['Media Source Extensions','H.264/AAC reported']);
  assert.deepEqual(rows[2],['H.264/AAC in MP4','Reported']);
  assert.deepEqual(rows[3],['HEVC/H.265 in MP4','Not reported']);
  assert.equal(browserPlaybackCapabilities({canPlayType:()=>''},{})[1][1],'Not available');
});

test('native video errors are assigned bounded failure categories', () => {
  assert.equal(nativeMediaFailure(2).code,'network');
  assert.equal(nativeMediaFailure(3).code,'decode');
  assert.equal(nativeMediaFailure(4).code,'unsupported');
  assert.equal(nativeMediaFailure(undefined).code,'unknown');
});

test('device and HLS network problems have specific next-step advice', () => {
  assert.match(connectionAdvice('decode','MP4'),/H.264/);
  assert.match(connectionAdvice('hls-network','HLS'),/CORS/);
  assert.match(connectionAdvice('startup','HLS'),/lower quality/);
  assert.match(connectionAdvice('unknown','HLS',true),/mixed content/);
  assert.match(connectionAdvice('autoplay','MP4'),/Play/);
});

test('a copied diagnostic report excludes provider secrets and arbitrary strings', () => {
  const report=playbackReport([
    {index:0,quality:'FHD',format:'HLS',engine:'HLS.js',status:'Failed',failure:'hls-network',url:'https://host/path?password=secret',name:'Private Provider'},
    {index:1,quality:'https://secret.example',format:'token=secret',engine:'https://secret.example',status:'secret',failure:'access-token=secret'}
  ],[['Native HLS','Not reported']]);
  assert.match(report,/Connection 1 · FHD · HLS · HLS.js · Failed \(hls-network\)/);
  assert.match(report,/Connection 2 · Unknown · Unknown · Unresolved · Unknown/);
  assert.doesNotMatch(report,/secret|Private Provider|https:\/\//);
  assert.match(report,/Native HLS: Not reported/);
});
