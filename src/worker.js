'use strict';
const enc = new TextEncoder();

const FB = {
  WEBHOOK_SECRET: 'MUSIC_BOT_AUTO_2026_kF8vH92mQpRzT4Xn',
  SOUNDCLOUD_API_URL: 'https://soundcloud-worker.alighost5920.workers.dev',
  SHAZAM_API_URL: 'https://shazam-worker.alighost5920.workers.dev',
  INSTA_API_URL: 'https://insta-worker.alighost5920.workers.dev',
  OWNER_ID: '0'
};

async function sha256Hex(s){ const d = await crypto.subtle.digest('SHA-256', enc.encode(String(s))); return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''); }

class TG{
  constructor(t){ this.t=t; this.b=`https://api.telegram.org/bot${t}`; }
  async call(m,p){ try{ const r=await fetch(`${this.b}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p||{})}); return await r.json(); }catch(e){ return {ok:false}; } }
  setWebhook(u,ex={}){ return this.call('setWebhook',{url:u,...ex}); }
  deleteWebhook(){ return this.call('deleteWebhook',{drop_pending_updates:true}); }
  getWebhookInfo(){ return this.call('getWebhookInfo'); }
  sendMessage(c,t,ex={}){ return this.call('sendMessage',{chat_id:c,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex}); }
  editMessageText(c,mid,t,ex={}){ return this.call('editMessageText',{chat_id:c,message_id:mid,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex}); }
  answerCallbackQuery(id,ex={}){ return this.call('answerCallbackQuery',{callback_query_id:id,...ex}); }
  sendAudio(c,a,ex={}){ return this.call('sendAudio',{chat_id:c,...ex}); }
  sendVideo(c,v,ex={}){ return this.call('sendVideo',{chat_id:c,supports_streaming:true,...ex}); }
  sendPhoto(c,p,ex={}){ return this.call('sendPhoto',{chat_id:c,...ex}); }
  getFile(fid){ return this.call('getFile',{file_id:fid}); }
  sendChatAction(c,a='typing'){ return this.call('sendChatAction',{chat_id:c,action:a}); }
}

const v = (e,k,d)=> (e && e[k] && String(e[k]).trim()) ? String(e[k]).trim() : d;

async function scCall(env,p,params){ const base=v(env,'SOUNDCLOUD_API_URL',FB.SOUNDCLOUD_API_URL).replace(/\/$/,''); const url=base+p+(params&&Object.keys(params).length?('?'+new URLSearchParams(params)): ''); try{const r=await fetch(url,{headers:{Accept:'application/json'}});return await r.json();}catch(e){return{ok:false};}}
async function shCall(env,p,body){ const base=v(env,'SHAZAM_API_URL',FB.SHAZAM_API_URL).replace(/\/$/,''); try{const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})});return await r.json();}catch(e){return{ok:false};}}
async function igCall(env,p,params){ const base=v(env,'INSTA_API_URL',FB.INSTA_API_URL).replace(/\/$/,''); const url=base+p+(params?('?'+new URLSearchParams(params)): ''); try{const r=await fetch(url,{headers:{Accept:'application/json'}});return await r.json();}catch(e){return{ok:false};}}

const sid=t=>String(t&&(t.sid||t.id)||'').replace(/^sc_/,'');
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function kb(r){return{inline_keyboard:(r||[]).filter(x=>x&&x.length)};}
const G=(t,c)=>({text:t,callback_data:c,style:'success'}); const B=(t,c)=>({text:t,callback_data:c,style:'primary'}); const URLB=(t,u)=>({text:t,url:u,style:'success'});
function menu(){return kb([[URLB('➕ افزودن به گروه','https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages')],[URLB('📢 کانال اصلی','https://t.me/MusicMsvD'),B('🌐 زبان','m:lang')],[B('👥 دعوت دوستان','m:invite'),B('ℹ️ راهنما','m:help'),B('📞 پشتیبانی','m:support')]]);}
async function sendTrack(env,tg,cid,tr){const sv=sid(tr),sb=v(env,'SOUNDCLOUD_API_URL',FB.SOUNDCLOUD_API_URL).replace(/\/$/,'');const title=tr.title||'',perf=tr.artist||'',dur=Math.round((tr.duration_ms||0)/1000)||undefined;const cap=`🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`;try{await tg.sendAudio(cid,`${sb}/api/v1/stream?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap});return true;}catch(e){}try{await tg.sendAudio(cid,`${sb}/api/v1/download?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap});return true;}catch(e){}return false;}

async function activate(env,origin){
  const token=v(env,'BOT_TOKEN','');
  if(!token) return {ok:false,error:'BOT_TOKEN missing (add to Cloudflare Secrets/Vars)'};
  const tg=new TG(token);
  const secret=v(env,'WEBHOOK_SECRET',FB.WEBHOOK_SECRET);
  const whp='/wh/'+(await sha256Hex(secret)).slice(0,24);
  const wh=origin.replace(/\/$/,'')+whp;
  try{ await tg.deleteWebhook(); }catch(e){}
  const res=await tg.setWebhook(wh,{secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:true});
  const owner=Number(v(env,'OWNER_ID',FB.OWNER_ID));
  if(owner){ try{ await tg.sendMessage(owner,`✅ فعال شد\n${wh}`); }catch(e){} }
  return {ok:!!res.ok,wh,secret,token_ok:true,result:res};
}

async function handle(env,ctx,u){
  try{
    const token=v(env,'BOT_TOKEN',''); if(!token) return;
    const tg=new TG(token); const owner=Number(v(env,'OWNER_ID',FB.OWNER_ID));
    if(u.callback_query){
      const cq=u.callback_query,cid=cq.message.chat.id,mid=cq.message.message_id,from=cq.from,data=cq.data||'';
      const ans=(t,a)=>tg.answerCallbackQuery(cq.id,{text:t,show_alert:!!a});
      if(data.startsWith('dl:')){ await ans('⏳ در حال ارسال...'); const tr=await scCall(env,'/api/v1/track',{id:data.slice(3)}).then(d=>d.ok&&d.track); if(!tr){await ans('خطا',true);return;} await sendTrack(env,tg,cid,tr); return; }
      if(data.startsWith('igf:')){ await ans('⏳'); try{ const urlb=Buffer.from(data.slice(4),'base64url').toString(); const r=await igCall(env,'/resolve',{url:urlb}); const items=(r.ok&&r.data&&r.data.items)||r.items||[]; for(const it of items){ const vitem=(it.variants||[]).find(x=>x&&x.url); if(!vitem)continue; if(it.type==='video'||(vitem.mime||'').includes('video')){ try{await tg.sendVideo(cid,vitem.url,{caption:'🎬 Instagram'});continue;}catch{} } try{await tg.sendPhoto(cid,vitem.url,{caption:'🖼 Instagram'});}catch{} } }catch(e){await ans('خطa',true);} return; }
      if(data.startsWith('igr:')){ await ans('🎤 شناسایی...'); try{ const urlb=Buffer.from(data.slice(4),'base64url').toString(); const r=await igCall(env,'/resolve',{url:urlb}); const items=(r.ok&&r.data&&r.data.items)||r.items||[]; const it=items.find(x=>x.type==='video'); if(!it){await tg.sendMessage(cid,'❌ ویدیو پیدا نشد');return;} const vit=(it.variants||[]).find(x=>x.url)||it.variants[0]; const ab=await fetch(vit.url).then(x=>x.arrayBuffer()); const b64=Buffer.from(ab).toString('base64'); let rec=await shCall(env,'/api/v1/recognize',{audio:b64}); const d2=(rec&&rec.data)||rec; if(d2&&d2.found){ const q2=`${d2.artist||''} ${d2.title||''}`.trim(); const sr=await scCall(env,'/api/v1/search',{q:q2}); const tr2=(sr.ok&&sr.results||[])[0]; if(tr2){ await tg.sendMessage(cid,`🎤 <b>شناسایی شد</b>\n🎵 ${esc(tr2.title)}\n👤 ${esc(tr2.artist)}`); await sendTrack(env,tg,cid,tr2); return; } } await tg.sendMessage(cid,'❌ شناسایی نشد'); }catch(e){await ans('خطا',true);} return; }
      if(data==='m:home'){ return tg.editMessageText(cid,mid,`🎧 <b>Music</b>\n\nسلام ${esc(from.first_name||'')} 👋`,{reply_markup:menu()}); }
      if(data==='m:lang'){ return tg.editMessageText(cid,mid,'🌐 زبان:',{reply_markup:kb([[B('فارسی','lang:fa','success')],[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:invite'){ return tg.editMessageText(cid,mid,`👥 <b>دعوت دوستان</b>\n\n<code>https://t.me/SEARCHERMUSIIC_BOT?start=ref_${from.id}</code>`,{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:support'){ return tg.editMessageText(cid,mid,'💬 <b>پشتیبانی</b>\n\n@AliMsvD',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:help'){ return tg.editMessageText(cid,mid,'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ بفرست\n🎤 ویس/ویدیو bفرست\n📸 لینک اینستاگرام bفرست',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      return;
    }
    const m=u.message||{}; const cid=m.chat.id; const from=m.from||{};
    if(m.text && m.text.indexOf('/start')===0){
      if(owner && owner===Number(from.id)) await tg.sendMessage(owner,'✅ فعال شد');
      return tg.sendMessage(cid,`🎧 <b>Music</b>\n\nسلام ${esc(from.first_name||'')} 👋`,{reply_markup:menu()});
    }
    if(/instagram\.com|instagr\.am/i.test(m.text||'')){ const q64=Buffer.from(m.text).toString('base64url'); return tg.sendMessage(cid,'📸 لینک اینستاگرام\n\nانتخاب کن:',{reply_markup:kb([[G('🎬 دریافت فایل(ها)',`igf:${q64}`)],[G('🎤 شناسایی موزیک ویدیو',`igr:${q64}`)]])}); }
    if(m.voice||m.audio||m.video||m.video_note){ await tg.sendChatAction(cid,'typing'); const f=m.voice||m.audio||m.video||m.video_note; const gf=await tg.getFile(f.file_id); if(!gf.ok)return tg.sendMessage(cid,'خطا'); const fu=`https://api.telegram.org/file/bot${token}/${gf.result.file_path}`; const ab=await fetch(fu).then(r=>r.arrayBuffer()); const b64=Buffer.from(ab).toString('base64'); let rec=await shCall(env,'/api/v1/recognize',{audio:b64}); if(!(rec&&rec.data&&rec.data.found)) rec=await shCall(env,'/api/v1/recognize',{url:fu}); const d2=(rec&&rec.data)||rec; if(d2&&d2.found){ const q2=`${d2.artist||''} ${d2.title||''}`.trim(); const sr=await scCall(env,'/api/v1/search',{q:q2}); const tr3=(sr.ok&&sr.results||[])[0]; if(tr3){ await tg.sendMessage(cid,`🎤 <b>shشناسایی شد</b>\n🎵 ${esc(tr3.title)}\n👤 ${esc(tr3.artist)}`); await sendTrack(env,tg,cid,tr3); return; } } return tg.sendMessage(cid,'❌ نتوانستم شناسایی کنم'); }
    if(m.text){ await tg.sendChatAction(cid,'typing'); const sr=await scCall(env,'/api/v1/search',{q:m.text}); const res=(sr.ok&&sr.results||[]); if(!res.length)return tg.sendMessage(cid,'❌ چیزی پیدا نشد'); const rows=res.slice(0,10).map(tr=>[G(`${(tr.artist||'')} — ${(tr.title||'')}`.slice(0,48),`dl:${sid(tr)}`)]); return tg.sendMessage(cid,`🔎 نتایج\nروی موزیک کلیک کن تا مستقیم ارسال شه:`,{reply_markup:kb(rows)}); }
  }catch(e){}
}

module.exports={
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    let p=url.pathname.replace(/\/+$/,''); if(p==='') p='/';
    const token=v(env,'BOT_TOKEN','');
    const secret=v(env,'WEBHOOK_SECRET',FB.WEBHOOK_SECRET);
    const whp='/wh/'+(await sha256Hex(secret)).slice(0,24);

    if(p==='/activate' || p==='/init'){ return new Response(JSON.stringify(await activate(env,url.origin)),{headers:{'content-type':'application/json','cache-control:'no-store'}}); }
    if(p==='/health'){ try{ const tg=new TG(token); const wi=await tg.getWebhookInfo(); return new Response(JSON.stringify({ok:true,bot:'Music',token: !!token,webhook:wi.result||wi}),{headers:{'content-type':'application/json'}}); }catch(e){ return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:{'content-type':'application/json'}}); } }
    if(p==='/') return new Response(`<html><head><meta charset="utf="utf-8"><title>Musi v g Bot</title></head><body style="text-align:center;padding:40px;font-family:sanssif"><h2>Music Bot</h2><p>F? klicken Sie auf <a href="/activate">/activate</a> um den Webhook automatisch einzustellen</p></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
    if(request.method==='POST' && p===whp){ const tok=request.headers.get('x-telegram-bot-api-secret-token')||''; if(tok!==secret) return new Response('forbidden',{status:403}); try{ const u=await request.json(); ctx.waitUntil(handle(env,ctx,u)); return new Response('ok',{status:200}); }catch(e){ return new Response('bad',{status:400}); } }
    if(request.method==='GET' && p===whp) return new Response('ok',{status:200});
    return new Response('Not Found',{status:404});
  }
};
