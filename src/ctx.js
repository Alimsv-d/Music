// Per-request context: env, Telegram client, KV store, service adapters, and
// helpers for role resolution, language, settings (KV cfg overrides env), and
// public URL for signed links. Built once per update in index.js and passed to
// every handler.

import { Tg } from "./telegram.js";
import { Store } from "./utils/kv.js";
import { SoundCloud } from "./services/soundcloud.js";
import { Shazam } from "./services/shazam.js";
import { Insta } from "./services/insta.js";
import { Lyrics } from "./services/lyrics.js";
import { t } from "./i18n/index.js";

export class Ctx {
  constructor(env, executionCtx) {
    this.env = env;
    this.exec = executionCtx;
    this.store = new Store(env.KV);
    this.tg = new Tg(env, this.store);
    this.sc = new SoundCloud(env);
    this.shz = new Shazam(env);
    this.insta = new Insta(env);
    this.lyr = new Lyrics(env);
    this.ownerId = String(env.OWNER_ID || "");
  }

  async botUsername() {
    if (this.env.BOT_USERNAME) return String(this.env.BOT_USERNAME).replace(/^@/, "");
    const cached = await this.store.getCfg("bot_username").catch(() => null);
    if (cached) return String(cached).replace(/^@/, "");
    try {
      const me = await this.tg.getMe();
      const name = String(me?.username || "").replace(/^@/, "");
      if (name) { await this.store.setCfg("bot_username", name); return name; }
    } catch {}
    return "SearcherMusiic_Bot";
  }


  publicUrl(request) {
    if (this.env.PUBLIC_URL) return this.env.PUBLIC_URL.replace(/\/$/, "");
    if (request) return new URL(request.url).origin;
    return "";
  }

  /**
   * Point service adapters at THIS worker's bundled /svc/* routes when their
   * dedicated *_API_URL env vars are empty. Call after ctx.request is set so
   * the worker can self-route without any external service URL.
   */
  bindOrigin(request) {
    const origin = this.publicUrl(request);
    if (!origin) return;
    if (!this.env.SOUNDCLOUD_API_URL) this.sc.base = `${origin}/svc/sc`;
    if (!this.env.SHAZAM_API_URL) this.shz.base = `${origin}/svc/shz`;
    if (!this.env.INSTA_API_URL) this.insta.base = `${origin}/svc/ig`;
    if (!this.env.LEGACY_INSTA_API_URL) this.insta.legacy = `${origin}/svc/ig`;
  }

  /** Resolve a user's language: stored pref > chat cfg > env default. */
  async langFor(userId, chatId) {
    let lang = null;
    if (userId) {
      const u = await this.store.getUser(userId);
      lang = u?.lang;
    }
    if (!lang && chatId && chatId !== userId) {
      const c = await this.store.getChat(chatId);
      lang = c?.lang;
    }
    if (!lang) lang = await this.cfg("default_lang", this.env.DEFAULT_LANG || "fa");
    return lang === "en" ? "en" : "fa";
  }

  /** Live config: KV override > env default. */
  async cfg(name, fallback = null) {
    const v = await this.store.getCfg(name);
    if (v === null || v === undefined) {
      const envMap = {
        page_size: "PAGE_SIZE", default_lang: "DEFAULT_LANG",
        rate: "RATE_LIMIT_PER_MIN", auto_lyrics: "AUTO_LYRICS",
        inline: "INLINE", maintenance: "MAINTENANCE", welcome: "WELCOME_MSG",
        support_url: "DEFAULT_SUPPORT_URL", maintenance_msg: "MAINTENANCE_MSG",
      };
      const ek = envMap[name];
      if (ek && this.env[ek] !== undefined) return this.env[ek];
      return fallback;
    }
    return v;
  }

  /** t() bound to a lang. */
  tr(lang, key, vars) { return t(lang, key, vars); }

  /** Role of a user id: "owner" | "admin" | "user". */
  async roleOf(userId) {
    if (String(userId) === this.ownerId) return "owner";
    if (await this.store.isAdmin(userId)) return "admin";
    return "user";
  }

  isGroupChat(type) { return type === "group" || type === "supergroup"; }
}
