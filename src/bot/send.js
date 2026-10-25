'use strict';
// Validated audio download and Telegram delivery.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const config = require('../config');
const sc = require('../services/soundcloud');
const { getStore } = require('../core/store');
const log = require('../core/log');

const MAX_BYTES = 48 * 1024 * 1024;
const CACHE_VERSION = 'v4';
const META_VERSION = 'cleanTrackMeta-v2';
let ffmpegChecked = null;
function hasFfmpeg() {
  if (ffmpegChecked !== null) return Promise.resolve(ffmpegChecked);
  return new Promise((res) => execFile('ffmpeg', ['-version'], (e) => { ffmpegChecked = !e; res(ffmpegChecked); }));
}
function runFfmpeg(args, timeout = 90000) { return new Promise((res, rej) => execFile('ffmpeg', args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (e) => e ? rej(e) : res())); }
function ffprobeDuration(file) {
  return new Promise((res) => execFile('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0',file], { timeout:20000 }, (e,out) => { const n=e?NaN:Number(String(out).trim()); res(Number.isFinite(n)?n:NaN); }));
}
async function toMp3(src,dst,meta={}) {
  await runFfmpeg(['-v','error','-y','-i',src,'-map_metadata','-1','-vn','-acodec','libmp3lame','-b:a','128k','-ar','44100','-ac','2','-metadata',`title=${meta.title || ''}`,'-metadata',`artist=${meta.artist || ''}`,dst],150000);
  if (!fs.existsSync(dst) || fs.statSync(dst).size < 40*1024) throw new Error('transcode produced unusable audio');
}
async function rmsAt(file, duration, fraction) {
  const pcmPath = file + `.rms_${Math.random().toString(36).slice(2,7)}`;
  const sec = Math.min(Math.max(1, duration*fraction), Math.max(1,duration-2));
  try {
    await runFfmpeg(['-v','error','-ss',String(sec),'-t','1.5','-i',file,'-vn','-ac','1','-ar','8000','-f','s16le',pcmPath],30000);
    const b=fs.readFileSync(pcmPath); if(b.length<8000)return 0;
    let sum=0,n=Math.floor(b.length/2); for(let i=0;i<n;i++){const x=b.readInt16LE(i*2);sum+=x*x;} return Math.sqrt(sum/n);
  } catch (_) { return 0; } finally { try{fs.unlinkSync(pcmPath)}catch(_){} }
}
async function validateAudio(file, expectedDuration) {
  const duration=await ffprobeDuration(file);
  if(!Number.isFinite(duration)||duration<1) throw new Error('audio duration unavailable');
  if(expectedDuration && Math.abs(duration-expectedDuration)>3){const e=new Error(`duration mismatch ${duration.toFixed(2)} != ${expectedDuration}`);e.code='DURATION_MISMATCH';throw e;}
  const rms=[]; for(const p of [.25,.5,.75]) rms.push(await rmsAt(file,duration,p));
  if(rms.some(x=>x<120)){const e=new Error('audio silent/undecodable in sampled windows');e.code='SILENT_AUDIO';e.rms=rms;throw e;}
  return {duration:Math.round(duration), decodedDuration:duration, rms};
}
async function isEncrypted(file) {
  return new Promise((resolve)=>execFile('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{timeout:20000},(e,out,err)=>resolve(/encryption info|Incorrect number of samples|Invalid data found|moov atom not found/i.test(String(err||''))||!!e&&!String(out||'').trim())));
}
function audioCaption(tr, lang) {
  const {i18n}=require('../core/context'); const {cleanTrackMeta}=require('../services/trackMeta'); const {esc,num}=i18n;
  const m=cleanTrackMeta(tr); const lines=[`🎵 <b>${esc(m.title)}</b>`,`👤 ${esc(m.artist)}`];
  const meta=[]; if(tr.duration)meta.push(`⏱ ${esc(tr.duration)}`); if(tr.genre)meta.push(`🏷 ${esc(tr.genre)}`); if(tr.plays)meta.push(`🎧 ${num(lang,tr.plays)}`); if(meta.length)lines.push(meta.join('  •  '));
  return lines.join('\n');
}

async function buildValidatedAudio(tr, sid=sc.sidOf(tr)) {
  const raw=path.join(config.tmpDir,`dl_${sid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.raw`), mp3=raw+'.mp3';
  try {
    await sc.downloadFile(sid,raw,MAX_BYTES);
    const st=fs.statSync(raw); if(st.size<1024||st.size>MAX_BYTES)throw new Error('invalid audio size');
    const h=fs.readFileSync(raw,{encoding:'utf8',flag:'r'}).slice(0,256); if(h.trimStart().startsWith('{')||/^#EXTM3U/i.test(h))throw new Error('manifest/json is not audio');
    if(!await hasFfmpeg())throw new Error('ffmpeg unavailable; safe audio validation impossible');
    if(await isEncrypted(raw)){const e=new Error('encrypted source');e.code='ENCRYPTED';throw e;}
    const expected=Math.round((tr.duration_ms||0)/1000); const source=await validateAudio(raw,expected);
    const meta = require('../services/trackMeta').cleanTrackMeta(tr);
    await toMp3(raw,mp3,meta); const out=await validateAudio(mp3,source.duration);
    fs.unlinkSync(raw);
    return {path:mp3,duration:out.duration,size:fs.statSync(mp3).size,rms:out.rms,cleanup(){try{fs.unlinkSync(mp3)}catch(_){}}};
  } catch(e){for(const f of [raw,mp3])try{fs.unlinkSync(f)}catch(_){};throw e;}
}

async function downloadAndSend(ctx,tr,lang) {
  const store=getStore(),sid=sc.sidOf(tr),meta=require('../services/trackMeta').cleanTrackMeta(tr),cacheKey=`${sid}|${meta.artist}|${meta.title}|${META_VERSION}`,chatId=ctx.chat.id,key=store.get('file_id_cache',cacheKey);
  const title=meta.title||'track', performer=meta.artist||'';
  if(key && key.file_id && key.v===CACHE_VERSION){
    try{await ctx.api.sendAudio(chatId,key.file_id,{title,performer,duration:key.duration,caption:audioCaption(tr,lang),parse_mode:'HTML'});return;}
    catch(_){store.del('file_id_cache',sid);}
  } else if(key) store.del('file_id_cache',sid);

  const audio=await buildValidatedAudio(tr,sid);
  try{
    const {InputFile}=require('grammy');
    const msg=await ctx.api.sendAudio(chatId,new InputFile(audio.path,`${performer} - ${title}`.replace(/[\\/:*?"<>|]/g,'_').slice(0,64)+'.mp3'),{
      title,performer,duration:audio.duration,caption:audioCaption(tr,lang),parse_mode:'HTML'
    });
    const result=msg.audio;
    if(!result || !result.file_id) throw new Error('Telegram returned no audio object');
    if(Math.abs((result.duration||0)-audio.duration)>3 || (result.file_size && Math.abs(result.file_size-audio.size)>Math.max(1024,audio.size*.03))){
      try{await ctx.api.deleteMessage(chatId,msg.message_id)}catch(_){}
      throw new Error('Telegram media metadata differs from validated upload');
    }
    store.set('file_id_cache',cacheKey,{file_id:result.file_id,v:CACHE_VERSION,metaVersion:META_VERSION,artist:performer,title,duration:audio.duration,validated:true,size:result.file_size||audio.size});
  } finally {audio.cleanup();}
}
module.exports={downloadAndSend,buildValidatedAudio,validateAudio,ffprobeDuration,CACHE_VERSION};
