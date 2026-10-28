'use strict';
const enc = new TextEncoder();
const FB={WEBHOOK_SECRET:'MUSIC_AUTO_FALLBACK_2026_X9fK82vTq',SOUNDCLOUD_API_URL:'https://soundcloud-worker.alighost5920.workers.dev',SHAZAM_API_URL:'https://shazam-worker.alighost5920.workers.dev',INSTA_API_URL:'https://insta-worker.alighost5920.workers.dev',OWNER_ID:'0'};
async function sha256Hex(s){const d=await crypto.subtle.digest('SHA-256',enc.encode(String(s)));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');}
class TG{constructor(t){this.t=t;this.b=`https://api.telegram.org/bot${t}`;}async call(m,p){try{const r=await fetch(`${this.b}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p||{})});return await r.json();}catch(e){return{ok:false};}}setWebhook(u,ex={}){return this.call('setWebhook',{url:u,...ex});}deleteWebhook(){return this.call('deleteWebhook',{drop_pending_updates:true});}getWebhookInfo(){return this.call('getWebhookInfo');}sendMessage(c,t,ex={}){return this.call('sendMessage',{chat_id:c,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex});}editMessageText(c,mid,t,ex={}){return this.call('editMessageText',{chat_id:c,message_id:mid,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex});}answerCallbackQuery(id,ex={}){return this.call('answerCallbackQuery',{callback_query_id:id,...ex});}sendAudio(c,a,ex={}){return this.call('sendAudio',{chat_id:c,...ex});}sendVideo(c,v,ex={}){return this.call('sendVideo',{chat_id:c,supports_streaming:true,...ex});}sendPhoto(c,p,ex={}){return this.call('sendPhoto',{chat_id:c,...ex});}getFile(fid){return this.call('getFile',{file_id:fid});}sendChatAction(c,a='typing'){return this.call('sendChatAction',{chat_id:c,action:a});}}
const v=(e,k,d)=>(e&&e[k]&&String(e[k]).trim())?String(e[k]).trim():d;

// Small per-isolate cache and request coalescer. Cloudflare Workers isolates are
// short-lived, so this is intentionally bounded; KV/D1 remain available for
// durable state, while hot duplicate requests avoid spending upstream quota.
const CACHE_TTL={search:30*60*1000,track:24*60*60*1000,recognize:60*60*1000,negative:15*60*1000};
const cache=new Map(), inflight=new Map(), quota=new Map();
const DAILY_BUDGET=8000;
function cacheGet(k){const x=cache.get(k);if(!x)return; if(Date.now()>x.exp){cache.delete(k);return;} cache.delete(k);cache.set(k,x);return x.value;}
function cacheSet(k,value,ttl){cache.delete(k);cache.set(k,{value,exp:Date.now()+ttl});if(cache.size>500)cache.delete(cache.keys().next().value);}
function once(k,fn){if(inflight.has(k))return inflight.get(k);const p=Promise.resolve().then(fn).finally(()=>inflight.delete(k));inflight.set(k,p);return p;}
async function digestKey(value){const bytes=typeof value==='string'?enc.encode(value):value;const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);}
function quotaAllowed(host){const day=new Date().toISOString().slice(0,10),key=host+':'+day;const n=quota.get(key)||0;if(n>=DAILY_BUDGET)return false;quota.set(key,n+1);return true;}
function quotaError(){return {ok:false,error:{code:'DAILY_QUOTA',message:'daily upstream budget reached'}};}
async function scCall(env,p,params){const base=v(env,'SOUNDCLOUD_API_URL',FB.SOUNDCLOUD_API_URL).replace(/\/$/,'');const url=base+p+(params&&Object.keys(params).length?('?'+new URLSearchParams(params)): '');const key='sc:'+url;const cached=cacheGet(key);if(cached)return cached;return once(key,async()=>{const again=cacheGet(key);if(again)return again;if(!quotaAllowed(new URL(base).host))return quotaError();try{const r=await fetch(url,{headers:{Accept:'application/json'}});const j=await r.json();if(j&&j.ok)cacheSet(key,j,p==='/api/v1/search'?CACHE_TTL.search:CACHE_TTL.track);return j;}catch(e){return{ok:false};}});}
async function shCall(env,p,body){const base=v(env,'SHAZAM_API_URL',FB.SHAZAM_API_URL).replace(/\/$/,'');if(!quotaAllowed(new URL(base).host))return quotaError();try{const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})});return await r.json();}catch(e){return{ok:false};}}
async function igCall(env,p,params){const base=v(env,'INSTA_API_URL',FB.INSTA_API_URL).replace(/\/$/,'');const url=base+p+(params?('?'+new URLSearchParams(params)): '');const key='ig:'+url;const cached=cacheGet(key);if(cached)return cached;return once(key,async()=>{if(!quotaAllowed(new URL(base).host))return quotaError();try{const r=await fetch(url,{headers:{Accept:'application/json'}});const j=await r.json();if(j&&j.ok)cacheSet(key,j,CACHE_TTL.search);return j;}catch(e){return{ok:false};}});}
async function recognizeMedia(env,token,f) {
  let fileUrl=f.url;
  if(!fileUrl){const gf=await new TG(token).getFile(f.file_id);if(!gf||!gf.ok||!gf.result||!gf.result.file_path)return null;fileUrl=`https://api.telegram.org/file/bot${token}/${gf.result.file_path}`;}
  const r=await fetch(fileUrl);if(!r.ok)return null;const bytes=new Uint8Array(await r.arrayBuffer());
  const key='media:'+await digestKey(bytes);const cached=cacheGet(key);if(cached)return cached;
  return once(key,async()=>{const again=cacheGet(key);if(again)return again;const rec=await shCall(env,'/api/v1/recognize',{audio:btoa(String.fromCharCode(...bytes))});if(rec&&rec.ok)cacheSet(key,rec,CACHE_TTL.recognize);return rec;});
}
function recognitionFailure(result){if(result&&result.error&&result.error.code==='DAILY_QUOTA')return'⏳ سهمیه روزانه سرویس تمام شده؛ فردا دوباره امتحان کن.';return'❌ آهنگی در این فایل شناسایی نشد.';}
async function findAndSend(env,tg,cid,rec){
  const d=rec&&rec.data?rec.data:rec;if(!d||!d.found)return false;
  const q=`${d.artist||''} ${d.title||''}`.trim();const sr=await scCall(env,'/api/v1/search',{q});
  const tr=(sr&&sr.ok&&sr.results||[])[0];if(!tr)return false;
  const sent=await sendTrack(env,tg,cid,tr);
  if(sent)await tg.sendMessage(cid,`🎤 <b>شناسایی شد و ارسال شد</b>\n🎵 ${esc(tr.title)}\n👤 ${esc(tr.artist)}`);
  return sent;
}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function kb(r){return{inline_keyboard:(r||[]).filter(x=>x&&x.length)};}
const G=(t,c)=>({text:t,callback_data:c,style:'success'});const B=(t,c)=>({text:t,callback_data:c,style:'primary'});const URLB=(t,u)=>({text:t,url:u,style:'success'});
const sid=t=>String(t&&(t.sid||t.id)||'').replace(/^sc_/,'');
function menu(){return kb([[URLB('➕ افزودن به گروه','https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages')],[URLB('📢 کانال اصلی','https://t.me/MusicMsvD'),B('🌐 زبان','m:lang')],[B('👥 دعوت دوستان','m:invite'),B('ℹ️ راهنما','m:help'),B('📞 پشتیبانی','m:support')]]);}
async function sendTrack(env,tg,cid,tr){const sv=sid(tr),sb=v(env,'SOUNDCLOUD_API_URL',FB.SOUNDCLOUD_API_URL).replace(/\/$/,'');const title=tr.title||'',perf=tr.artist||'',dur=Math.round((tr.duration_ms||0)/1000)||undefined;const cap=`🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`;try{await tg.sendAudio(cid,`${sb}/api/v1/stream?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap});return true;}catch(e){}try{await tg.sendAudio(cid,`${sb}/api/v1/download?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap});return true;}catch(e){}return false;}
async function handle(env,ctx,u){
  try{
    const token=v(env,'BOT_TOKEN','');if(!token)return;
    const tg=new TG(token);const owner=Number(v(env,'OWNER_ID',FB.OWNER_ID));
    if(u.callback_query){
      const cq=u.callback_query,cid=cq.message.chat.id,mid=cq.message.message_id,from=cq.from,data=cq.data||'';
      const ans=(t,a)=>tg.answerCallbackQuery(cq.id,{text:t,show_alert:!!a});
      if(data.startsWith('dl:')){await ans('⏳ در حال ارسال...');const tr=await scCall(env,'/api/v1/track',{id:data.slice(3)}).then(d=>d.ok&&d.track);if(!tr){await ans('خطا',true);return;}await sendTrack(env,tg,cid,tr);return;}
      if(data.startsWith('igf:')){await ans('⏳');try{const urlb=Buffer.from(data.slice(4),'base64url').toString();const r=await igCall(env,'/api/v1/resolve',{url:urlb});const items=(r.ok&&r.data&&r.data.items)||r.items||[];for(const it of items){const vit=(it.variants||[]).find(x=>x&&x.url);if(!vit)continue;if(it.type==='video'||(vit.mime||'').includes('video')){try{await tg.sendVideo(cid,vit.url,{caption:'🎬 Instagram'});continue;}catch{}}try{await tg.sendPhoto(cid,vit.url,{caption:'🖼 Instagram'});}catch{}}}catch(e){await ans('خطا',true);}return;}
      if(data.startsWith('igr:')){await ans('🎤 شناسایی...');try{const urlb=Buffer.from(data.slice(4),'base64url').toString();const r=await igCall(env,'/api/v1/resolve',{url:urlb});const items=(r.ok&&r.data&&r.data.items)||r.items||[];const it=items.find(x=>x.type==='video'||(x.variants||[]).some(vv=>/video/i.test(vv.mime||'')));if(!it){await tg.sendMessage(cid,'❌ ویدیو پیدا نشد');return;}const vs=it.variants||[];const vit=vs.find(x=>x.url&&/video/i.test(x.mime||'')&&x.has_audio!==false)||vs.find(x=>x.url&&/video/i.test(x.mime||''))||vs.find(x=>x.url);if(!vit){await tg.sendMessage(cid,'❌ فایل ویدیو پیدا نشد');return;}const rec=await recognizeMedia(env,token,{url:vit.url});const d2=(rec&&rec.data)||rec;if(d2&&d2.found){const sent=await findAndSend(env,tg,cid,rec);if(sent)return;await tg.sendMessage(cid,`🎤 شناسایی شد؛ در SoundCloud پیدا نشد.\n🎵 <b>${esc(d2.title)}</b>\n👤 ${esc(d2.artist)}`);return;}await tg.sendMessage(cid,recognitionFailure(rec));}catch(e){await ans('خطا',true);}return;}
      if(data==='m:home'){return tg.editMessageText(cid,mid,`🎧 <b>Music</b>\n\nسلام ${esc(from.first_name||'')} 👋`,{reply_markup:menu()});}
      if(data==='m:lang'){return tg.editMessageText(cid,mid,'🌐 زبان:',{reply_markup:kb([[B('فارسی','lang:fa','success')],[B('🔙 بازگشت','m:home')]])});}
      if(data==='m:invite'){return tg.editMessageText(cid,mid,`👥 <b>دعوت دوستان</b>\n\n<code>https://t.me/SEARCHERMUSIIC_BOT?start=ref_${from.id}</code>`,{reply_markup:kb([[B('🔙 بازگشت','m:home')]])});}
      if(data==='m:support'){return tg.editMessageText(cid,mid,'💬 <b>پشتیبانی</b>\n\n@AliMsvD',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])});}
      if(data==='m:help'){return tg.editMessageText(cid,mid,'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ بفرست\n🎤 ویس/ویدیو بفرست\n📸 لینک اینستاگرام بفرست',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])});}
      return;
    }
    const m=u.message||{};const cid=m.chat.id;const from=m.from||{};
    if(m.text && m.text.indexOf('/start')===0){
      if(owner && owner===Number(from.id)) await tg.sendMessage(owner,'✅ فعال شد');
      return tg.sendMessage(cid,`🎧 <b>Music</b>\n\nسلام ${esc(from.first_name||'')} 👋`,{reply_markup:menu()});
    }
    if(/instagram\.com|instagr\.am/i.test(m.text||'')){const q64=Buffer.from(m.text).toString('base64url');return tg.sendMessage(cid,'📸 لینک اینستاگرام\n\nانتخاب کن:',{reply_markup:kb([[G('🎬 دریافت فایل(ها)',`igf:${q64}`)],[G('🎤 شناسایی موزیک ویدیو',`igr:${q64}`)]])});}
    if(m.voice||m.audio||m.video||m.video_note){await tg.sendChatAction(cid,'typing');const f=m.voice||m.audio||m.video||m.video_note;const rec=await recognizeMedia(env,token,{file_id:f.file_id});if(await findAndSend(env,tg,cid,rec))return;return tg.sendMessage(cid,'❌ نتوانستم شناسایی کنم');}
    if(m.text){await tg.sendChatAction(cid,'typing');const sr=await scCall(env,'/api/v1/search',{q:m.text});const res=(sr.ok&&sr.results||[]);if(!res.length)return tg.sendMessage(cid,'❌ چیزی پیدا نشد');const rows=res.slice(0,10).map(tr=>[G(`${(tr.artist||'')} — ${(tr.title||'')}`.slice(0,48),`dl:${sid(tr)}`)]);return tg.sendMessage(cid,`🔎 نتایج\nروی موزیک کلیک کن تا مستقیم ارسال شه:`,{reply_markup:kb(rows)});}
  }catch(e){}
}
async function activate(env,origin){
  const token=v(env,'BOT_TOKEN','');
  if(!token) return {ok:false,error:'BOT_TOKEN missing'};
  const tg=new TG(token);
  const secret=v(env,'WEBHOOK_SECRET',FB.WEBHOOK_SECRET);
  const whp='/wh/'+(await sha256Hex(secret)).slice(0,24);
  const wh=origin.replace(/\/$/,'')+whp;
  try{await tg.deleteWebhook();}catch(e){}
  const res=await tg.setWebhook(wh,{secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:true});
  const owner=Number(v(env,'OWNER_ID',FB.OWNER_ID));
  if(owner)try{await tg.sendMessage(owner,`✅ فعال شد\n${wh}`);}catch(e){}
  return {ok:!!res.ok,wh,result:res};
}
module.exports={
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    let p=url.pathname.replace(/\/+$/,'');if(p==='')p='/';
    const token=v(env,'BOT_TOKEN','');
    const secret=v(env,'WEBHOOK_SECRET',FB.WEBHOOK_SECRET);
    const whp='/wh/'+(await sha256Hex(secret)).slice(0,24);
    if(p==='/activate'||p==='/init'){return new Response(JSON.stringify(await activate(env,url.origin),null,2),{headers:{'content-type':'application/json','cache-control':'no-store'}});}
    if(p==='/health'){try{const tg=new TG(token);const wi=await tg.getWebhookInfo();return new Response(JSON.stringify({ok:true,token:!!token,webhook:wi.result||wi}),{headers:{'content-type':'application/json'}});}catch(e){return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:{'content-type':'application/json'}});}}
    if(p==='/'){return new Response('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>Music Bot</title><body style="font-family:sans-serif;text-align:center;margin-top:15%"><h2>Music Bot</h2><p>برای فعال‌سازی روی <a href="/activate">/activate</a> کلیک کن</p></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});}
    if(request.method==='POST'&&p===whp){const tok=request.headers.get('x-telegram-bot-api-secret-token')||'';if(tok!==secret)return new Response('forbidden',{status:403});try{const u=await request.json();ctx.waitUntil(handle(env,ctx,u));return new Response('ok',{status:200});}catch(e){return new Response('bad',{status:400});}}
    if(request.method==='GET'&&p===whp)return new Response('ok',{status:200});
    return new Response('Not Found',{status:404});
  }
};
