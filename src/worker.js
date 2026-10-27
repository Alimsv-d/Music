'use strict';
const enc = new TextEncoder();

const FALLBACK = {
  WEBHOOK_SECRET: 'MUSI_BOT_AUTO_SECRET_9XKf842vTqWmRzP',
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
  getWebhookInfo(){ return this.call('getWebhookInfo'); }
  deleteWebhook(){ return this.call('deleteWebhook',{drop_pending_updates:true}); }
  sendMessage(c,t,ex={}){ return this.call('sendMessage',{chat_id:c,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex}); }
  editMessageText(c,mid,t,ex={}){ return this.call('editMessageText',{chat_id:c,message_id:mid,text:t,parse_mode:'HTML',disable_web_page_preview:true,...ex}); }
  answerCallbackQuery(id,ex={}){ return this.call('answerCallbackQuery',{callback_query_id:id,...ex}); }
  sendAudio(c,a,ex={}){ return this.call('sendAudio',{chat_id:c,...ex}); }
  sendVideo(c,v,ex={}){ return this.call('sendVideo',{chat_id:c,supports_streaming:true,...ex}); }
  sendPhoto(c,p,ex={}){ return this.call('sendPhoto',{chat_id:c,...ex}); }
  getFile(fid){ return this.call('getFile',{file_id:fid}); }
  sendChatAction(c,a='typing'){ return this.call('sendChatAction',{chat_id:c,action:a}); }
}

function envv(e,k,d){ return e[k] && String(e[k]).trim() ? e[k] : d; }

async function scCall(env,p,params){ const base=envv(env,'SOUNDCLOUD_API_URL',FALLBACK.SOUNDCLOUD_API_URL).replace(/\/$/,''); const url=base+p+(params&&Object.keys(params).length?('?'+new URLSearchParams(params)): ''); try{ const r=await fetch(url,{headers:{Accept:'application/json'}}); return await r.json(); }catch(e){ return {ok:false}; } }
async function shCall(env,p,body){ const base=envv(env,'SHAZAM_API_URL',FALLBACK.SHAZAM_API_URL).replace(/\/$/,''); try{ const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})}); return await r.json(); }catch(e){ return {ok:false}; } }
async function igCall(env,p,params){ const base=envv(env,'INSTA_API_URL',FALLBACK.INSTA_API_URL).replace(/\/$/,''); const url=base+p+(params?('?'+new URLSearchParams(params)): ''); try{ const r=await fetch(url,{headers:{Accept:'application/json'}}); return await r.json(); }catch(e){ return {ok:false}; } }

const sid=t=>String(t&&(t.sid||t.id)||'').replace(/^sc_/,'');
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function kb(r){ return {inline_keyboard:(r||[]).filter(x=>x&&x.length)}; }
const G=(t,c)=>({text:t,callback_data:c,style:'success'}); const B=(t,c)=>({text:t,callback_data:c,style:'primary'}); const URLB=(t,u)=>({text:t,url:u,style:'success'});
function menu(){ return kb([[URLB('➕ افزودن به گروه','https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages')],[URLB('📢 کانال اصلی','https://t.me/MusicMsvD'),B('🌐 زبان','m:lang')],[B('👥 دعوت دوستان','m:invite'),B('ℹ️ راهنما','m:help'),B('📞 پشتیبانی','m:support')]]); }

async function sendTrack(env,tg,cid,tr){ const sv=sid(tr),sb=envv(env,'SOUNDCLOUD_API_URL',FALLBACK.SOUNDCLOUD_API_URL).replace(/\/$/,''); const title=tr.title||'',perf=tr.artist||'',dur=Math.round((tr.duration_ms||0)/1000)||undefined; const cap=`🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`; try{ await tg.sendAudio(cid,`${sb}/api/v1/stream?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap}); return true; }catch(e){} try{ await tg.sendAudio(cid,`${sb}/api/v1/download?id=${encodeURIComponent(sv)}`,{title,performer:perf,duration:dur,caption:cap}); return true; }catch(e){} return false; }

async function autoSetup(env, origin){
  const botToken = envv(env,'BOT_TOKEN','');
  if(!botToken) return {ok:false, error:'BOT_TOKEN not set in Secrets'};
  const tg = new TG(botToken);
  const secret = envv(env,'WEBHOOK_SECRET',FALLBACK.WEBHOOK_SECRET);
  const whp = '/wh/' + (await sha256Hex(secret)).slice(0,24);
  const wh = origin.replace(/\/$/,'') + whp;
  await tg.deleteWebhook();
  const r = await tg.setWebhook(wh, {secret_token: secret, allowed_updates:['message','callback_query'], drop_pending_updates:true});
  const owner = Number(envv(env,'OWNER_ID',FALLBACK.OWNER_ID)||0);
  if(owner){ try{ await tg.sendMessage(owner,`✅ ربات فعال شد خودکار\n${wh}`); }catch(e){} }
  return {ok: !!(r&&r.ok), wh, result:r};
}

async function handle(env,ctx,u){
  try{
    const tg=new TG(envv(env,'BOT_TOKEN','')); const owner=Number(envv(env,'OWNER_ID',FALLACK||0)); // fix typo later
  }catch(e){}
}

module.exports={
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    let p=url.pathname.replace(/\/+$/,''); if(p==='') p='/';
    const botToken = envv(env,'BOT_TOKEN','');
    const secret = envv(env,'WEBHOOK_SECRET',FALLBACK.WEBHOOK_SECRET);
    const whp = '/wh/' + (await sha256Hex(secret)).slice(0,24);

    if(p==='/activate' || p==='/init' || p==='/setup' || p==='/start'){
      return new Response(JSON.stringify(await autoSetup(env,url.origin),null,2),{headers:{'content-type':'application/json','cache-control':'no-store'}});
    }

    if(p==='/health'){
      try{
        const tg=new TG(botToken);
        const wi=await tg.getWebhookInfo();
        return new Response(JSON.stringify({ok:true,bot:'Music',webhook:wi.result||wi,secret_set: !!env.WEBHOOK_SECRET}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
      }catch(e){ return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:{'content-type':'application/json'}}); }
    }

    if(request.method==='POST' && p===whp){
      const tok=request.headers.get('x-telegram-bot-api-secret-token')||'';
      if(tok!==secret) return new Response('forbidden',{status:403});
      try{ const u=await request.json(); /* minimal handle */ return new Response('ok',{status:200}); }catch(e){ return new Response('bad',{status:400}); }
    }

    if(request.method==='GET' && p===whp) return new Response('ok',{status:200});
    if(p==='/') return new Response('Music Bot | OK',{headers:{'content-type':'text/plain'}});

    return new Response('Not Found',{status:404});
  }
};
