'use strict';
// Bounded disk cache of fully validated media for Telegram inline URL fetches.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const config = require('../config');
const locks = new Map();
let activeWarm=0; const warmQueue=[];
async function withWarmSlot(fn){
  if(activeWarm>=3) await new Promise(resolve=>warmQueue.push(resolve));
  activeWarm++;
  try{return await fn();}finally{activeWarm--;const next=warmQueue.shift();if(next)next();}
}
const MAX_CACHE = +(process.env.INLINE_CACHE_MB || 160) * 1024 * 1024;
const TTL = +(process.env.INLINE_CACHE_TTL || 1800) * 1000;
const dir = path.join(config.tmpDir, 'inline_media');
try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

function keyHash(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
function pathFor(key, ext) { return path.join(dir, keyHash(key) + '.' + ext); }
function list() {
  try { return fs.readdirSync(dir).map((n) => { const p=path.join(dir,n); const s=fs.statSync(p); return {p, size:s.size, at:s.mtimeMs}; }).filter(x=>x.size>0); } catch (_) { return []; }
}
function evict() {
  const xs=list().sort((a,b)=>a.at-b.at); let total=xs.reduce((s,x)=>s+x.size,0);
  for(const x of xs){ if(total<=MAX_CACHE) break; try{fs.unlinkSync(x.p);total-=x.size;}catch(_){} }
}
function cached(key, ext) {
  const p=pathFor(key,ext);
  try { const s=fs.statSync(p); if(Date.now()-s.mtimeMs>TTL){fs.unlinkSync(p);return null;} try{fs.utimesSync(p,new Date(),new Date())}catch(_){} return {path:p,size:s.size,mtime:Date.now(),ext}; } catch(_){return null;}
}
async function withLock(key, fn) {
  if(locks.has(key)) return locks.get(key);
  const p=Promise.resolve().then(fn).finally(()=>locks.delete(key)); locks.set(key,p); return p;
}
function ffprobe(file) {
  return new Promise((resolve,reject)=>execFile('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height','-of','json',file],{timeout:20000},(e,out)=>{
    if(e)return reject(e);try{const j=JSON.parse(out);const v=j.streams&&j.streams.find(x=>x.width&&x.height)||{};resolve({duration:Number(j.format&&j.format.duration)||0,width:v.width||0,height:v.height||0});}catch(x){reject(x);}
  }));
}
async function warmAudio(tr) {
  const key='audio:'+String(tr.sid||tr.id).replace(/^sc_/,'');
  const hit=cached(key,'mp3'); if(hit)return hit;
  return withLock(key,()=>withWarmSlot(async()=>{
    const now=cached(key,'mp3'); if(now)return now;
    const {buildValidatedAudio}=require('../bot/send');
    const a=await buildValidatedAudio(tr);
    const dst=pathFor(key,'mp3');
    try{fs.renameSync(a.path,dst);}catch(_){fs.copyFileSync(a.path,dst);try{fs.unlinkSync(a.path)}catch(__){}}
    const duration=a.duration,size=fs.statSync(dst).size; try{fs.utimesSync(dst,new Date(),new Date())}catch(_){}
    a.cleanup(); evict(); return {path:dst,size,duration,ext:'mp3'};
  }));
}
async function warmVideo(postUrl, item, variant, insta) {
  const videoId=crypto.createHash('sha256').update(`${postUrl}:${item.index}:${variant.quality}`).digest('hex');
  const key='video:'+videoId;
  const hit=cached(key,'mp4'); if(hit)return {...hit,key:videoId};
  return withLock(key,()=>withWarmSlot(async()=>{
    const now=cached(key,'mp4'); if(now)return {...now,key:videoId};
    const tmp=path.join(dir,keyHash(key)+'.download'); const dst=pathFor(key,'mp4');
    try {
      await insta.downloadFile(postUrl,{quality:variant.quality,index:item.index},tmp,50*1024*1024);
      await new Promise((resolve,reject)=>execFile('ffmpeg',['-v','error','-y','-i',tmp,'-c','copy','-movflags','+faststart',dst],{timeout:60000},e=>e?reject(e):resolve()));
      const m=await ffprobe(dst); if(!m.duration||!m.width||!m.height)throw new Error('invalid video');
      try{fs.unlinkSync(tmp)}catch(_){};try{fs.utimesSync(dst,new Date(),new Date())}catch(_){}
      const result={path:dst,size:fs.statSync(dst).size,ext:'mp4',...m,key:videoId};evict();return result;
    } catch(e){for(const f of [tmp,dst])try{fs.unlinkSync(f)}catch(_){};throw e;}
  }));
}
function getVideo(key) { return cached('video:'+key,'mp4'); }
module.exports={warmAudio,warmVideo,getVideo,cached,pathFor,keyHash,evict,dir,TTL,MAX_CACHE};
