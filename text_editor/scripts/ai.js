/* ============================================================
   ai.js — AI assistant panel + provider-agnostic adapter.

   SECURITY MODEL
   --------------
   The API key is stored in localStorage (plain text) and sent ONLY
   from this page directly to the chosen provider's API via fetch.
   It never touches any other server. A one-time visible disclaimer
   tells the user this.

   PROVIDERS
   ---------
   - Gemini         : Google REST  (generateContent / streamGenerateContent)
   - OpenAI         : /v1/chat/completions
   - DeepSeek       : OpenAI-compatible  https://api.deepseek.com/v1
   - Kimi (Moonshot): OpenAI-compatible  https://api.moonshot.cn/v1
   - Custom         : any OpenAI-compatible base URL
   All non-Gemini providers share the streaming SSE format, so we
   parse it once. Gemini has its own SSE shape.
   ============================================================ */

import { storage } from './persistence.js';
import { i18n } from './i18n.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash',
    style: 'gemini',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    style: 'openai',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    style: 'openai',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    style: 'openai',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    style: 'openai',
  },
};

export function aiConfig() {
  const cfg = storage.lsGet('ai', null) || {
    provider: 'openai',
    apiKey: '',
    model: '',
    baseUrl: '',
    gKeyConfirmed: false,
  };
  return cfg;
}

export function saveAiConfig(cfg) {
  storage.lsSet('ai', {
    provider: cfg.provider || 'openai',
    apiKey: cfg.apiKey || '',
    model: cfg.model || '',
    baseUrl: cfg.baseUrl || '',
    gKeyConfirmed: true,
  });
}

export function clearAiConfig() { storage.lsDel('ai'); }

/** Translate a fetch error / status into an i18n key. */
function statusToErrKey(status) {
  if (status === 401 || status === 403) return 'aiErrInvalidKey';
  if (status === 429) return 'aiErrQuota';
  if (status === 404) return 'aiErrModel';
  if (status >= 500) return 'aiErrServer';
  return 'aiErrUnknown';
}

export function parseError(status, msg) {
  return {
    key: statusToErrKey(status),
    detail: msg && typeof msg === 'string' ? msg.slice(0, 300) : '',
  };
}

/**
 * Send a chat request. Normalizes {role, content} messages across
 * providers. Supports streaming via the `onToken` callback.
 * Returns the full response text (even when streaming).
 */
export async function sendMessage(cfg, messages, { onToken, signal } = {}) {
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.openai;
  if (!cfg.apiKey) throw Object.assign(new Error('NO_KEY'), { status: -1 });

  if (provider.style === 'gemini') {
    return sendGemini(cfg, messages, { onToken }, provider, signal);
  }
  return sendOpenAICompat(cfg, messages, { onToken }, provider, signal);
}

async function sendGemini(cfg, messages, { onToken }, provider, signal) {
  const model = cfg.model || provider.model;
  const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(model)}:${onToken ? 'streamGenerateContent' : 'generateContent'}?alt=${onToken ? 'sse' : 'json'}&key=${encodeURIComponent(cfg.apiKey)}`;
  const contents = messages
    .filter(m => (m.content || '').trim())
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.7 } }),
    signal,
  });
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j.error && (j.error.message || '') || j.error || ''; } catch {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  if (!onToken) {
    const j = await res.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    return text || '';
  }
  // SSE streaming
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const cand = (j.candidates?.[0]?.content?.parts || [])[0];
        const t = cand ? cand.text || '' : '';
        if (t) { out += t; onToken(t); }
      } catch {}
    }
  }
  return out;
}

async function sendOpenAICompat(cfg, messages, { onToken }, provider, signal) {
  const base = (cfg.baseUrl || provider.baseUrl).replace(/\/+$/, '');
  const model = cfg.model || provider.model;
  const url = `${base}/chat/completions`;
  const body = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: !!onToken,
    temperature: 0.7,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j.error?.message || JSON.stringify(j.error || '').slice(0, 200); } catch {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  if (!onToken) {
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content || '';
        if (d) { out += d; onToken(d); }
      } catch {}
    }
  }
  return out;
}

/* ============================================================
   AiAssistant — the side panel UI + chat wiring.
   ============================================================ */

const SYS = `You are a helpful writing assistant embedded in a bilingual (English+Arabic) offline text editor. Respond in the language the user uses. Be concise. When rewriting/translating, output ONLY the resulting text (no explanations), so it can be inserted directly into the document.`;

const QA_PROMPTS = {
  qaGrammar: 'Fix the grammar and spelling of the following text. Output only the corrected text:',
  qaRewrite: 'Rewrite the following paragraph to improve clarity and flow. Output only the rewritten text:',
  qaContinue: 'Continue the following text naturally from where it stops. Output only the continuation:',
  qaSummarize: 'Summarize the following text in 3-4 sentences:',
  qaTranslateAr: 'Translate the following text into Arabic. Output only the Arabic translation:',
  qaTranslateEn: 'Translate the following text into English. Output only the English translation:',
  qaFormal: 'Rewrite the following text in a formal register. Output only the rewritten text:',
  qaCasual: 'Rewrite the following text in a casual, friendly register. Output only the rewritten text:',
  qaExplain: 'Explain what the following text means, in simple language:',
};

export class AiAssistant {
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('ai-panel');
    this.chatEl = document.getElementById('ai-chat');
    this.inputEl = document.getElementById('ai-input');
    this.quickEl = document.getElementById('ai-quick');
    this.titleEl = document.getElementById('ai-panel-title');
    this.panelOpen = false;
    this._busy = false;
    this._abort = null;
    this._inSettings = false;
    this._bind();
  }

  _bind() {
    const resize = () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(160, this.inputEl.scrollHeight) + 'px';
    };
    this.inputEl.addEventListener('input', resize);
  }

  get cfg() { return aiConfig(); }

  /* ---------------- open/close ---------------- */

  togglePanel() {
    if (this.panelOpen) this.closePanel();
    else this.openPanel();
  }

  openPanel() {
    this.panelOpen = true;
    this.app.setAIPanelOpen(true);
    this._render();
    this.inputEl.focus({ preventScroll: true });
  }

  closePanel() {
    this.panelOpen = false;
    this.app.setAIPanelOpen(false);
  }

  _render() {
    this.quickEl.textContent = '';
    if (this.app.online !== false && !this.cfg.apiKey) {
      this._renderEmpty();
      return;
    }
    if (!navigator.onLine && !this.cfg.apiKey) {
      this._renderOffline();
      return;
    }
    if (this._inSettings) { this._renderSettings(); return; }
    this._renderChat();
  }

  toggleSettings() {
    this._inSettings = !this._inSettings;
    this._render();
  }

  _renderEmpty() {
    const t = i18n;
    this.chatEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty-state ai-empty';
    div.innerHTML = `
      <svg class="ic es-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z"/></svg>
      <strong>${t.t('aiEmptyTitle')}</strong>
      <p>${t.t('aiEmptyBody')}</p>
      <button class="text-btn primary">${t.t('aiOpenSettings')}</button>`;
    div.querySelector('button').addEventListener('click', () => { this._inSettings = true; this._render(); });
    this.chatEl.appendChild(div);
    this._buildQuick([]);
  }

  _renderOffline() {
    const t = i18n;
    this.chatEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty-state ai-empty';
    div.innerHTML = `
      <svg class="ic es-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6a12 12 0 0 1 20 0M5 10a8 8 0 0 1 14 0M9 14a4 4 0 0 1 6 0M12 18h.01M2 2l20 20"/></svg>
      <strong>${t.t('aiOfflineTitle')}</strong>
      <p>${t.t('aiOfflineBody')}<br>${t.t('aiOfflineBody2')}</p>`;
    this.chatEl.appendChild(div);
    this._buildQuick([]);
  }

  /* ---------------- Chat view ---------------- */

  _renderChat() {
    this.chatEl.innerHTML = '';
    const doc = this.app.getActiveDoc();
    const msgs = (doc && doc.chat) || [];
    for (const m of msgs) this._appendMsgBubble(m.role, m.content, false);
    if (!msgs.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-state ai-empty';
      hint.textContent = i18n.t('aiPlaceholder');
      hint.style.opacity = '0.7';
      this.chatEl.appendChild(hint);
    }
    this._buildQuick(['qaGrammar', 'qaRewrite', 'qaContinue', 'qaSummarize', 'qaTranslateAr', 'qaTranslateEn', 'qaFormal', 'qaCasual', 'qaExplain']);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  _appendMsgBubble(role, content, animated = false) {
    const wrap = document.createElement('div');
    wrap.className = `ai-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble ai-prose';
    const el = document.createElement('span');
    el.textContent = content;
    el.className = 'ai-text';
    bubble.appendChild(el);
    wrap.appendChild(bubble);
    if (role === 'assistant' && content) {
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      const ins = document.createElement('button');
      ins.textContent = i18n.t(role === 'assistant' && content ? 'aiInsert' : 'aiCopy');
      ins.addEventListener('click', () => this.app.insertAIText(content));
      const copy = document.createElement('button');
      copy.textContent = i18n.t('aiCopy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(content); this.app.toast('aiCopied'); } catch {}
      });
      actions.appendChild(ins);
      actions.appendChild(copy);
      wrap.appendChild(actions);
    }
    if (animated) {
      bubble.style.whiteSpace = 'pre-wrap';
    }
    this.chatEl.appendChild(wrap);
    void el;
    return { wrap, bubble };
  }

  /** Show a temporary inline error message in the chat. */
  _appendError(err) {
    const key = typeof err === 'string' ? err : (err.key || 'aiErrUnknown');
    const wrap = document.createElement('div');
    wrap.className = `ai-msg assistant error`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble';
    bubble.textContent = i18n.t(key) + (err && err.detail ? ` — ${err.detail}` : '');
    wrap.appendChild(bubble);
    this.chatEl.appendChild(wrap);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
    return wrap;
  }

  _buildQuick(keys) {
    this.quickEl.textContent = '';
    for (const k of keys) {
      const b = document.createElement('button');
      b.className = 'ai-chip';
      b.textContent = i18n.t(k);
      b.addEventListener('click', () => this._quickAction(k));
      this.quickEl.appendChild(b);
    }
  }

  /* ---------------- Messaging ---------------- */

  async send(text) {
    const t = text.trim();
    if (!t || this._busy) return;
    const cfg = this.cfg;
    if (!cfg.apiKey) {
      this._appendError('aiNoKey');
      return;
    }
    if (!navigator.onLine) {
      this._appendError('aiErrNetwork');
      return;
    }
    const doc = this.app.getActiveDoc();
    if (!doc) return;
    doc.chat = doc.chat || [];
    doc.chat.push({ role: 'user', content: t });
    this._appendMsgBubble('user', t);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this._busy = true;
    this._disableInput(true);
    this.app.saveNow();

    // Build document context excerpt (around cursor, bounded).
    const ctx = this._buildContext(doc);

    const messages = [
      { role: 'system', content: SYS },
      { role: 'user', content: ctx + '\n\n--- user request ---\n' + t },
    ];

    const loading = document.createElement('div');
    loading.className = 'ai-msg assistant';
    loading.innerHTML = `<div class="ai-typing"><span></span><span></span><span></span></div>`;
    this.chatEl.appendChild(loading);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;

    this._abort = new AbortController();
    let out = '';
    let target = null;
    try {
      const finalText = await sendMessage(cfg, messages, {
        signal: this._abort.signal,
        onToken: (tok) => {
          out += tok;
          if (!target) {
            loading.remove();
            const { bubble } = this._appendMsgBubble('assistant', out, true);
            target = bubble.querySelector('.ai-text');
          } else {
            target.textContent = out;
          }
          this.chatEl.scrollTop = this.chatEl.scrollHeight;
        },
      });
      if (!target) loading.remove();
      if (!target && finalText) {
        this._appendMsgBubble('assistant', finalText);
        out = finalText;
      }
      if (!out && finalText) out = finalText;
      this._saveAssistant(out);
    } catch (err) {
      loading.remove();
      if (err.name === 'AbortError') return;
      const status = err.status || 0;
      const info = parseError(status, err.message);
      this._saveAssistant(null);
      this._appendError(info);
      this._saveAssistantError(info);
    } finally {
      this._busy = false;
      this._disableInput(false);
      this.inputEl.focus({ preventScroll: true });
      this.app.saveNow();
    }
  }

  _saveAssistant(out) {
    const doc = this.app.getActiveDoc();
    if (doc && out) { doc.chat.push({ role: 'assistant', content: out }); }
  }
  _saveAssistantError() {}

  _disableInput(dis) {
    this.inputEl.disabled = dis;
    document.getElementById('btn-ai-send').disabled = dis;
  }

  _buildContext(doc) {
    const text = doc.buffer.getText();
    const total = text.length;
    if (total <= 12000) {
      const cursor = doc.buffer.lineColumnToOffset(doc.cursor.line, doc.cursor.column);
      return `CURRENT DOCUMENT (full, ${total} chars):\n\n<document>\n${text}\n</document>\nCurrent cursor at offset ${cursor}.`;
    }
    // excerpt around cursor
    const buf = doc.buffer;
    const curOff = buf.lineColumnToOffset(doc.cursor.line, doc.cursor.column);
    const start = Math.max(0, curOff - 4000);
    const end = Math.min(total, curOff + 4000);
    return `CURRENT DOCUMENT (excerpt around cursor; full doc is ${total} chars):\n\n<document>\n${text.slice(start, end)}\n</document>\nCursor near offset ${curOff} within this excerpt.`;
  }

  /* ---------------- Quick actions ---------------- */

  _selectionOrExcerpt() {
    const doc = this.app.getActiveDoc();
    const sel = doc.getSelectionOffsets();
    if (sel.end > sel.start) return doc.buffer.getText(sel.start, sel.end - sel.start);
    // entire current paragraph ~ logical line
    const lc = doc.buffer.offsetToLineColumn(doc.buffer.lineColumnToOffset(doc.cursor.line, doc.cursor.column));
    return doc.buffer.getLine(lc.line);
  }

  _quickAction(key) {
    const doc = this.app.getActiveDoc();
    if (!doc) return;
    const selection = this._selectionOrExcerpt();
    const prompt = QA_PROMPTS[key];
    if (!prompt) return;
    // Treat as a freeform message with the selection target noted.
    const target = doc.getSelectionOffsets();
    this._quickTarget = { hasSel: target.end > target.start, text: selection };
    this.inputEl.value = `${prompt}\n\n${selection}`;
    this.send(this.inputEl.value);
  }

  /* ---------------- Settings ---------------- */

  _renderSettings() {
    this.chatEl.innerHTML = '';
    this.chatEl.className = 'ai-chat';
    const cfg = this.cfg;
    const t = i18n;
    const div = document.createElement('div');
    div.className = 'ai-settings';
    div.innerHTML = `
      <div class="field"><label>${t.t('aiProvider')}</label>
        <select id="ai-provider">
          ${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}" ${cfg.provider === k ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>${t.t('aiApiKey')}</label>
        <div class="key-row">
          <input type="password" id="ai-key" placeholder="sk-… / AIza…" value="${cfg.apiKey || ''}" autocomplete="off">
          <button class="text-btn" id="ai-key-toggle">${cfg.apiKey ? t.t('aiShow') : t.t('aiShow')}</button>
        </div>
      </div>
      <div class="field" id="ai-model-field"><label>${t.t('aiModel')}</label>
        <input type="text" id="ai-model" value="${cfg.model || ''}" placeholder="${(PROVIDERS[cfg.provider] || PROVIDERS.openai).model}">
      </div>
      <div class="field" id="ai-base-field" style="${cfg.provider === 'custom' ? '' : 'display:none'}"><label>${t.t('aiBaseUrl')}</label>
        <input type="text" id="ai-base" value="${cfg.baseUrl || ''}" placeholder="https://…">
      </div>
      <div class="ai-disclaimer">${t.t('aiKeyDisclaimer')}</div>
      <button class="text-btn primary" id="ai-save-key">${t.t('settings')}</button>
      <button class="text-btn" id="ai-test" style="margin-top:8px; width:100%">${t.t('aiTest')}</button>
      <div id="ai-test-result" style="margin-top:8px; font-size:12px"></div>
      <button class="text-btn" id="ai-back" style="margin-top:auto; margin-top:14px">${t.t('back')}</button>`;

    this.chatEl.appendChild(div);

    const prov = div.querySelector('#ai-provider');
    const key = div.querySelector('#ai-key');
    const model = div.querySelector('#ai-model');
    const base = div.querySelector('#ai-base');
    const modelField = div.querySelector('#ai-model-field');
    const baseField = div.querySelector('#ai-base-field');

    prov.addEventListener('change', () => {
      const p = prov.value;
      modelField.style.display = '';
      baseField.style.display = p === 'custom' ? '' : 'none';
      if (!model.value) model.placeholder = (PROVIDERS[p] || PROVIDERS.openai).model;
    });

    div.querySelector('#ai-key-toggle').addEventListener('click', () => {
      key.type = key.type === 'password' ? 'text' : 'password';
    });

    div.querySelector('#ai-save-key').addEventListener('click', () => {
      const nk = key.value.trim();
      saveAiConfig({ provider: prov.value, apiKey: nk, model: model.value.trim(), baseUrl: base.value.trim() });
      const note = document.createElement('div');
      note.className = 'save-note';
      note.textContent = t.t('aiKeyStored');
      div.querySelector('#ai-test-result').appendChild(note);
    });

    div.querySelector('#ai-test').addEventListener('click', async () => {
      const res = div.querySelector('#ai-test-result');
      res.innerHTML = `<span style="color:var(--color-text-dim)">${t.t('aiTesting')}</span>`;
      saveAiConfig({ provider: prov.value, apiKey: key.value.trim(), model: model.value.trim(), baseUrl: base.value.trim() });
      const testCfg = { provider: prov.value, apiKey: key.value.trim(), model: model.value.trim(), baseUrl: base.value.trim() };
      try {
        const out = await sendMessage(testCfg, [{ role: 'user', content: 'Say OK' }], {});
        res.innerHTML = `<span style="color:var(--color-success)">${t.t('aiTestOk')}</span>`;
        void out;
      } catch (err) {
        const info = parseError(err.status || 0, err.message);
        res.innerHTML = `<span style="color:var(--color-error)">${t.t('aiTestFail', { err: t.t(info.key) })}</span>`;
      }
    });

    div.querySelector('#ai-back').addEventListener('click', () => {
      this._inSettings = false;
      this._render();
    });
  }

  /* ---------------- online/offline ---------------- */

  setOnline(online) {
    if (!online && this._busy && this._abort) { try { this._abort.abort(); } catch {} }
    if (this.panelOpen) this._render();
  }
}

export default AiAssistant;