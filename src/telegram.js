// Thin Telegram Bot API client. Centralises the API base (overridable for
// e2e tests via TELEGRAM_API_BASE), 429/retry_after handling, and 403
// user-blocked detection. Never logs the token.

import { http } from "./utils/http.js";

export class TelegramError extends Error {
  constructor(description, { code = 0, retryAfter = 0, method = "" } = {}) {
    super(description || "telegram error");
    this.code = code;
    this.retryAfter = retryAfter;
    this.method = method;
    this.blocked = code === 403;
    this.notFound = code === 404 || /message to edit not found|message can't be edited/i.test(description || "");
  }
}

export class Tg {
  /**
   * @param {object} env  Worker env (BOT_TOKEN, TELEGRAM_API_BASE, KV…)
   * @param {object} [store] Store instance, used to mark blocked users inactive.
   */
  constructor(env, store = null) {
    this.token = env.BOT_TOKEN;
    this.base = (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
    this.fileBase = `${this.base}/file/bot${this.token}`;
    this.apiBase = `${this.base}/bot${this.token}`;
    this.store = store;
  }

  /** File download URL for a getFile file_path. */
  fileUrl(filePath) {
    return `${this.fileBase}/${filePath}`;
  }

  /**
   * Call a Bot API method. Throws TelegramError on !ok.
   * Automatically marks the chat inactive on 403 "bot was blocked".
   */
  async call(method, params = {}, opts = {}) {
    const url = `${this.apiBase}/${method}`;
    let res;
    try {
      res = await http(url, {
        method: "POST",
        timeout: opts.timeout ?? 15000,
        retries: opts.retries ?? 1,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (e) {
      throw new TelegramError(e.message, { method, code: -1 });
    }

    let data;
    try { data = await res.json(); } catch { data = { ok: false, description: "bad json" }; }

    if (!data.ok) {
      const desc = data.description || `HTTP ${res.status}`;
      const retryAfter = data.parameters?.retry_after || 0;
      const err = new TelegramError(desc, { code: data.error_code || res.status, retryAfter, method });
      // Mark user/chat inactive on 403.
      if (err.blocked && this.store && params.chat_id) {
        try { await this.store.setUserInactive(params.chat_id); } catch {}
      }
      throw err;
    }
    return data.result;
  }

  // ── convenience wrappers ─────────────────────────────────────────────────
  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }
  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }
  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }
  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
  answerCallbackQuery(id, extra = {}) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...extra }).catch(() => {});
  }
  sendChatAction(chatId, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }
  sendAudio(chatId, params) {
    return this.call("sendAudio", { chat_id: chatId, parse_mode: "HTML", ...params }, { timeout: 60000 });
  }
  sendVoice(chatId, params) {
    return this.call("sendVoice", { chat_id: chatId, parse_mode: "HTML", ...params }, { timeout: 60000 });
  }
  sendPhoto(chatId, params) {
    return this.call("sendPhoto", { chat_id: chatId, parse_mode: "HTML", ...params }, { timeout: 30000 });
  }
  sendVideo(chatId, params) {
    return this.call("sendVideo", { chat_id: chatId, parse_mode: "HTML", ...params }, { timeout: 60000 });
  }
  sendMediaGroup(chatId, media) {
    return this.call("sendMediaGroup", { chat_id: chatId, media }, { timeout: 60000 });
  }
  sendDocument(chatId, params) {
    return this.call("sendDocument", { chat_id: chatId, parse_mode: "HTML", ...params }, { timeout: 60000 });
  }
  answerInlineQuery(inlineQueryId, results, extra = {}) {
    return this.call("answerInlineQuery", {
      inline_query_id: inlineQueryId,
      results,
      ...extra,
    });
  }
  getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }
  getMe() {
    return this.call("getMe");
  }
  setWebhook(url, extra = {}) {
    return this.call("setWebhook", { url, ...extra }, { timeout: 20000 });
  }
  getWebhookInfo() {
    return this.call("getWebhookInfo");
  }
  deleteWebhook(extra = {}) {
    return this.call("deleteWebhook", extra);
  }
  setMyCommands(commands, scope = { type: "default" }, language_code = undefined) {
    return this.call("setMyCommands", { commands, scope, ...(language_code ? { language_code } : {}) });
  }
  setMyDescription(params) { return this.call("setMyDescription", params); }
  setMyShortDescription(params) { return this.call("setMyShortDescription", params); }
  getChatMember(chatId, userId) {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
  }
  getChat(chatId) { return this.call("getChat", { chat_id: chatId }); }
  copyMessage(chatId, fromChatId, messageId, extra = {}) {
    return this.call("copyMessage", {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      ...extra,
    });
  }
  forwardMessage(chatId, fromChatId, messageId) {
    return this.call("forwardMessage", {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    });
  }

  /**
   * Multipart upload (sendAudio/sendDocument/sendPhoto with a File).
   * `field` = "audio" | "document" | "photo" | "video". `file` = {data,name,type}.
   * Returns API result. Centralises retry_after & blocked handling.
   */
  async upload(method, params, field, file, opts = {}) {
    const url = `${this.apiBase}/${method}`;
    const fd = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const blob = file instanceof Blob ? file : new Blob([file.data], { type: file.type || "application/octet-stream" });
    fd.append(field, blob, file.name || "file");
    if (file.thumb) {
      const tb = file.thumb instanceof Blob ? file.thumb : new Blob([file.thumb.data], { type: file.thumb.type || "image/jpeg" });
      fd.append("thumbnail", tb, file.thumb.name || "thumb.jpg");
    }
    let res;
    try {
      res = await http(url, { method: "POST", body: fd, timeout: opts.timeout ?? 90000, retries: 1 });
    } catch (e) {
      throw new TelegramError(e.message, { method, code: -1 });
    }
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      const err = new TelegramError(data.description || `HTTP ${res.status}`, {
        code: data.error_code || res.status,
        retryAfter: data.parameters?.retry_after || 0,
        method,
      });
      if (err.blocked && this.store && params.chat_id) {
        try { await this.store.setUserInactive(params.chat_id); } catch {}
      }
      throw err;
    }
    return data.result;
  }
}
