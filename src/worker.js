'use strict';
const enc = new TextEncoder();
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class TG {
  constructor(token) { this.token = token; this.base = `https://api.telegram.org/bot${token}`; }
  async call(method, payload) {
    const r = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return r.json();
  }
  sendMessage(chat, text, extra={}) { return this.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  editMessageText(chat, mid, text, extra={}) { return this.call('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  answerCallbackQuery(id, extra={}) { return this.call('answerCallbackQuery', { callback_query_id: id, ...extra }); }
  sendAudio(chat, audio, extra={}) { return this.call('sendAudio', { chat_id: chat, ...extra }); }
  sendVideo(chat, video, extra={}) { return this.call('sendVideo', { chat_id: chat, supports_streaming: true, ...extra }); }
  sendPhoto(chat, photo, extra={}) { return this.call('sendPhoto', { chat_id: chat, ...extra }); }
  getFile(file_id) { return this.call('getFile', { file_id }); }
  sendChatAction(chat, action='typing') { return this.call('sendChatAction', { chat_id: chat, action }); }
}

async function scCall(env, path, params) {
  const base = (env.SOUNDCLOUD_API_URL || 'https://soundcloud-worker.alighost5920.workers.dev').replace(/\/$/, '');
  const url = base + path + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 0 } }); return await r.json(); } catch(e) { return { ok: false }; }
}

async function shCall(env, path, body) {
  const base = (env.SHAZAM_API_URL || 'https://shazam-worker.alighost5920.workers.dev').replace(/\/$/, '');
  try { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body||{}) }); return await r.json(); } catch(e) { return { ok: false }; }
}

async function igCall(env, path, params) {
  const base = (env.INSTA_API_URL || 'https://insta-worker.alighost5920.workers.dev').replace(/\/$/, '');
  const url = base + path + (params ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); } catch(e) { return { ok: false }; }
}

const sid = (t) => String(t && (t.sid || t.id) || '').replace(/^sc_/, '');
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function kb(rows){ return { inline_keyboard: (rows||[]).filter(r=>r&&r.length) }; }
const B=(t,c,s='primary')=>({text:t,callback_data:c,style:s}); const G=(t,c)=>B(t,c,'success'); const URLB=(t,u,s='primary')=>({text:t,url:u,style:s});

function menu(owner){ return kb([
  [URLB('➕ افزودن به گروه','https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages','success')],
  [URLB('📢 کانال اصلی','https://t.me/MusicMsvD'), B('🌐 زبان','m:lang')],
  [B('👥 دعوت دوستان','m:invite'), B('ℹ️ راهنما','m:help'), B('📞 پشتیبانی','m:support')]
]); }

async function sendTrack(env,tg,cid,tr){
  const sidv=sid(tr); const scBase=(env.SOUNDCLOUD_API_URL||'https://soundcloud-worker.alighost5920.workers.dev').replace(/\/$/,'');
  const title=tr.title||'', perf=tr.artist||'', dur=Math.round((tr.duration_ms||0)/1000)||undefined;
  const cap=`🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`;
  const u1=`${scBase}/api/v1/stream?id=${encodeURIComponent(sidv)}`;
  try{ await tg.sendAudio(cid,u1,{title,performer:perf,duration:dur,caption:cap}); return true;}catch(e){}
  try{ await tg.sendAudio(cid,`${scBase}/api/v1/download?id=${encodeURIComponent(sidv)}`,{title,performer:perf,duration:dur,caption:cap}); return true;}catch(e){}
  return false;
}

async function handle(env,ctx,u){
  try{
    const tg=new TG(env.BOT_TOKEN);
    const owner=Number(env.OWNER_ID);
    if(u.callback_query){
      const cq=u.callback_query, cid=cq.message.chat.id, mid=cq.message.message_id, from=cq.from, data=cq.data||'';
      const ans=(t,a)=>tg.answerCallbackQuery(cq.id,{text:t,show_alert:!!a});
      if(data.startsWith('dl:')){
        await ans('⏳ در حال ارسال...');
        const tr=await scCall(env,'/api/v1/track',{id:data.slice(3)}).then(d=>d.ok&&d.track);
        if(!tr){await ans('خطا',true);return;}
        await sendTrack(env,tg,cid,tr); return;
      }
      if(data.startsWith('igf:')){
        await ans('⏳ در حال دریافت...');
        try{
          const url=Buffer.from(data.slice(4),'base64url').toString();
          const r=await igCall(env,'/resolve',{url});
          const items=(r.ok&&r.data&&r.data.items)||r.items||[];
          if(!items.length){await ans('چیزی پیدا نشد',true);return;}
          for(const it of items){
            const v=(it.variants||[]).find(x=>x&&x.url); if(!v)return;
            if(it.type==='video'||(v.mime||'').includes('video')){ try{await tg.sendVideo(cid,v.url,{caption:'🎬 Instagram'});continue;}catch(e){} }
            try{await tg.sendPhoto(cid,v.url,{caption:'🖼 Instagram'});}catch(e){}
          }
        }catch(e){await ans('خطا',true);}
        return;
      }
      if(data.startsWith('igr:')){
        await ans('🎤 در حال شناسایی...');
        try{
          const url=Buffer.from(data.slice(4),'base64url').toString();
          const r=await igCall(env,'/resolve',{url});
          const items=(r.ok&&r.data&&r.data.items)||r.items||[];
          const it=items.find(x=>x.type==='video'||(x.variants||[]).some(v=>(v.mime||'').includes('video')));
          if(!it){await tg.sendMessage(cid,'❌ ویدیو پیدا نشد');return;}
          const v=(it.variants||[]).find(x=>x.url)||it.variants[0];
          const ab=await fetch(v.url).then(x=>x.arrayBuffer());
          const b64=btoa(String.fromCharCode.apply(null,new Uint8Array(ab)));
          let rec=await shCall(env,'/api/v1/recognize',{audio:b64,format:'mp4'});
          if(!(rec&&rec.data&&rec.data.found)) rec=await shCall(env,'/api/v1/recognize',{audio:b64});
          const d2=rec.data||rec;
          if(d2.found||d2.artist){
            const q2=`${d2.artist||''} ${d2.title||''}`.trim();
            const sres=await scCall(env,'/api/v1/search',{q:q2});
            const tr2=(sres.ok&&sres.results||[])[0];
            if(tr2){ await tg.sendMessage(cid,`🎤 شناسایی شد\n🎵 <b>${esc(tr2.title)}</b>\n👤 ${esc(tr2.artist)}`); await sendTrack(env,tg,cid,tr2); return; }
            await tg.sendMessage(cid,`🎤 شناسایی شد\n🎵 <b>${esc(d2.title)}</b>\n👤 ${esc(d2.artist)}`);
            return;
          }
          await tg.sendMessage(cid,'❌ آهنگی شناسایی نشد');
        }catch(e){await ans('خطا',true);}
        return;
      }
      if(data==='m:home'){ return tg.editMessageText(cid,mid,`🎧 <b>Music</b> | دستیار موزیک و دانلود\n\nسلام ${esc(from.first_name||'')} 👋 فقط کافیه چیزی بفرستی؛ بقیه‌اش با من 👇`,{reply_markup:menu(from.id===owner)}); }
      if(data==='m:lang'){ return tg.editMessageText(cid,mid,'🌐 زبان را انتخاب کن:',{reply_markup:kb([[B('فارسی','lang:fa','success')],[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:invite'){ return tg.editMessageText(cid,mid,`👥 <b>دعوت دوستان</b>\n\n<code>https://t.me/SEARCHERMUSIIC_BOT?start=ref_${from.id}</code>`,{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:support'){ return tg.editMessageText(cid,mid,'💬 <b>پشتیبانی</b>\n\n@AliMsvD',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      if(data==='m:help'){ return tg.editMessageText(cid,mid,'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ بفرست\n🎤 ویس/ویدیو بفرست تا مستقیم شناسایی و ارسال شه\n📸 لینک اینستاگرام بفرست',{reply_markup:kb([[B('🔙 بازگشت','m:home')]])}); }
      return;
    }
    const m=u.message||{}; const cid=m.chat.id; const from=m.from||{}; const text=(m.text||m.caption||'').trim();
    if(text && text.indexOf('/start')===0){ return tg.sendMessage(cid,`🎧 <b>Music</b> | دستیار موزیک و دانلود\n\nسلام ${esc(from.first_name||'')} 👋 فقط کافیه چیزی بفرستی؛ بقیه‌اش با من 👇`,{reply_markup:menu(from.id===owner)}); }
    if(/instagram\.com|instagr\.am/i.test(text)){
      const q64=Buffer.from(text).toString('base64url');
      return tg.sendMessage(cid,'📸 لینک اینستاگرام\n\nانتخاب کن:',{reply_markup:kb([[G('🎬 دریافت فایل(ها)',`igf:${q64}`)],[G('🎤 شناسایی موزیک ویدیو',`igr:${q64}`)]])});
    }
    if(m.voice||m.audio||m.video||m.video_note){
      await tg.sendChatAction(cid,'typing');
      const f=m.voice||m.audio||m.video||m.video_note;
      const gf=await tg.getFile(f.file_id);
      if(!gf.ok)return tg.sendMessage(cid,'خطا');
      const fu=`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
      const ab=await fetch(fu).then(r=>r.arrayBuffer());
      const b64=Buffer.from(ab).toString('base64');
      let rec=await shCall(env,'/api/v1/recognize',{audio:b64});
      if(!(rec&&rec.data&&rec.data.found)) rec=await shCall(env,'/api/v1/recognize',{url:fu});
      const d2=rec.data||rec;
      if(d2.found||d2.artist){
        const q2=`${d2.artist||''} ${d2.title||''}`.trim();
        const sr=await scCall(env,'/api/v1/search',{q:q2});
        const tr3=(sr.ok&&sr.results||[])[0];
        if(tr3){ await tg.sendMessage(cid,`🎤 <b>شناسایی شد</b>\n🎵 ${esc(tr3.title)}\n👤 ${esc(tr3.artist)}`); await sendTrack(env,tg,cid,tr3); return; }
      }
      return tg.sendMessage(cid,'❌ نتوانستم شناسایی کنم');
    }
    if(text){
      await tg.sendChatAction(cid,'typing');
      const sr=await scCall(env,'/api/v1/search',{q:text});
      const res=(sr.ok&&sr.results||[]);
      if(!res.length)return tg.sendMessage(cid,'❌ چیزی پیدا نشد');
      const rows=res.slice(0,10).map(tr=>[G(`${(tr.artist||'')} — ${(tr.title||'')}`.slice(0,48),`dl:${sid(tr)}`)]);
      return tg.sendMessage(cid,`🔎 نتایج «${esc(text)}»\nروی موزیک کلیک کن تا مستقیم ارسال شه:`,{reply_markup:kb(rows)});
    }
  }catch(e){}
}

module.exports={
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    const secret=env.WEBHOOK_SECRET||'x';
    const wh='/wh/'+(await sha256Hex(secret)).slice(0,24);
    if(url.pathname==='/health') return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});
    if(request.method==='POST' && url.pathname===wh){
      const tok=request.headers.get('x-telegram-bot-api-secret-token')||'';
      if(tok!==secret) return new Response('forbidden',{status:403});
      try{
        const u=await request.json();
        ctx.waitUntil(handle(env,ctx,u));
        return new Response('ok',{status:200});
      }catch(e){ return new Response('bad',{status:400}); }
    }
    return new Response('not found',{status:404});
  },
  async scheduled(){}
};
