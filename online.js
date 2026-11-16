'use strict';

/* Online mode – optional cloud OCR / translation for hard images (Urdu Nastaliq
 * cards, blurry photos). Offline mode keeps working exactly as before.
 *
 * Providers (both work with a free key, no credit card):
 *   gemini    – Google AI Studio free key, reads Urdu Nastaliq properly and
 *               returns both the raw text and the card fields in one call.
 *   ocrspace  – OCR.space free key, good for English / mixed cards.
 *
 * Translation uses Google Translate's public endpoint, which needs no key at
 * all and is instant. If it fails we fall back to the bundled offline model.
 */

const Online = (() => {
  const DEFAULTS = {
    provider: 'gemini',
    geminiKey: '',
    geminiModel: 'gemini-flash-latest',
    ocrSpaceKey: ''
  };

  const GEMINI_FALLBACKS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

  const FIELD_KEYS = ['name', 'fatherName', 'cnic', 'dob', 'issue', 'expiry', 'gender', 'country', 'address'];

  let cfg = { ...DEFAULTS };

  /* ------------------------------------------------------------- storage */

  async function load() {
    try {
      const s = await chrome.storage.local.get('online');
      cfg = { ...DEFAULTS, ...(s && s.online ? s.online : {}) };
    } catch {
      try {
        cfg = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('online') || '{}') || {}) };
      } catch {
        cfg = { ...DEFAULTS };
      }
    }
    return cfg;
  }

  async function save(patch) {
    cfg = { ...cfg, ...patch };
    try {
      await chrome.storage.local.set({ online: cfg });
    } catch {
      try {
        localStorage.setItem('online', JSON.stringify(cfg));
      } catch {
        /* ignore */
      }
    }
    return cfg;
  }

  function get() {
    return cfg;
  }

  function configured() {
    if (cfg.provider === 'gemini') return !!cfg.geminiKey.trim();
    return true; // ocr.space has a shared demo key, still useful
  }

  /* --------------------------------------------------------- image utils */

  function decode(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('image decode fail'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /** downscale + compress so uploads stay small and fast */
  async function prepareImage(blob, maxSide, quality) {
    const limit = maxSide || 1800;
    const img = await decode(blob);
    const scale = Math.min(1, limit / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);

    let q = quality || 0.85;
    let out = await canvasToBlob(c, 'image/jpeg', q);
    while (out && out.size > 950 * 1024 && q > 0.4) {
      q -= 0.1;
      out = await canvasToBlob(c, 'image/jpeg', q);
    }
    return out || blob;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /* -------------------------------------------------------------- errors */

  function httpError(status, body) {
    let msg = '';
    try {
      const j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || j.message || '';
    } catch {
      msg = String(body || '').slice(0, 180);
    }
    const e = new Error(msg || `HTTP ${status}`);
    e.status = status;
    return e;
  }

  function friendly(err, provider) {
    const s = err && err.status;
    const raw = String((err && err.message) || err);
    if (s === 400) return `${provider}: API key ghalat lagti hai (${raw.slice(0, 80)})`;
    if (s === 401 || s === 403) return `${provider}: key reject hui ya API enabled nahi hai`;
    if (s === 404) return `${provider}: model nahi mila — Settings me model badlo`;
    if (s === 429) return `${provider}: free quota khatam / bohat requests — thori der baad try karo`;
    if (s >= 500) return `${provider}: server masla (${s}) — dobara try karo`;
    return `${provider}: ${raw.slice(0, 160)}`;
  }

  /* -------------------------------------------------------------- gemini */

  const GEMINI_PROMPT = [
    'You are an OCR + document field extraction engine.',
    'Read every visible line of text in the image exactly as printed. Keep Urdu in Urdu script and English in English. Do not translate.',
    'Then extract these identity-card fields (empty string "" when not visible):',
    'name, fatherName, cnic (like 12345-1234567-1), dob, issue, expiry (dates as DD.MM.YYYY), gender, country, address.',
    'If the card is shown twice (front and back) merge the information.',
    'Return ONLY a JSON object with exactly these keys:',
    '{"text":"...all lines...","name":"","fatherName":"","cnic":"","dob":"","issue":"","expiry":"","gender":"","country":"","address":""}'
  ].join(' ');

  function parseJsonLoose(s) {
    let t = String(s || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a === -1 || b === -1) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }

  async function geminiRun(blob) {
    const key = cfg.geminiKey.trim();
    if (!key) throw new Error('Gemini API key nahi hai — ⚙ Settings me daalo');

    const jpg = await prepareImage(blob, 1800, 0.85);
    const b64 = await blobToBase64(jpg);

    const body = {
      systemInstruction: { parts: [{ text: 'Output valid JSON only. No markdown.' }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }]
        }
      ],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    };

    const models = [cfg.geminiModel || GEMINI_FALLBACKS[0], ...GEMINI_FALLBACKS].filter(
      (m, i, arr) => m && arr.indexOf(m) === i
    );

    let lastErr = null;
    for (const model of models) {
      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );
      } catch (e) {
        throw new Error('Gemini tak nahi pohncha (internet check karo): ' + String(e.message || e));
      }

      const text = await res.text();
      if (!res.ok) {
        const err = httpError(res.status, text);
        if (res.status === 404) {
          lastErr = err;
          continue;
        }
        throw new Error(friendly(err, 'Gemini'));
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('Gemini ka jawab samajh nahi aaya');
      }

      const cand = (json.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const raw = parts.map((p) => p.text || '').join('').trim();
      const obj = parseJsonLoose(raw) || {};
      const fields = {};
      for (const k of FIELD_KEYS) fields[k] = String(obj[k] || '').trim();

      let outText = String(obj.text || '').trim();
      if (!outText) {
        // model returned a plain string instead of the JSON envelope
        outText = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      }

      return { text: outText, fields, source: 'gemini', model };
    }

    throw new Error(friendly(lastErr || new Error('model nahi mila'), 'Gemini'));
  }

  /* ------------------------------------------------------------ ocr.space */

  async function ocrSpaceRun(blob) {
    const key = (cfg.ocrSpaceKey || '').trim() || 'helloworld';
    const jpg = await prepareImage(blob, 2000, 0.85);

    const fd = new FormData();
    fd.append('apikey', key);
    fd.append('language', 'eng');
    fd.append('isOverlayRequired', 'false');
    fd.append('scale', 'true');
    fd.append('file', jpg, 'card.jpg');

    let res;
    try {
      res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
    } catch (e) {
      throw new Error('OCR.space tak nahi pohncha (internet check karo)');
    }

    const text = await res.text();
    if (!res.ok) throw new Error(friendly(httpError(res.status, text), 'OCR.space'));

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('OCR.space ka jawab samajh nahi aaya');
    }

    if (json.IsErroredOnProcessing) {
      const m = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join(' ') : json.ErrorMessage;
      throw new Error('OCR.space: ' + String(m || 'unknown error').slice(0, 160));
    }

    const out = (json.ParsedResults || [])
      .map((p) => p.ParsedText || '')
      .join('\n')
      // the shared demo key prepends a "[Note: ...]" line
      .replace(/^\s*\[Note:[^\]]*\]\s*$/gim, '')
      .trim();
    return { text: out, fields: {}, source: 'ocrspace' };
  }

  /* ------------------------------------------------------------ dispatch */

  async function ocr(blob) {
    if (cfg.provider === 'gemini') return geminiRun(blob);
    return ocrSpaceRun(blob);
  }

  /* ---------------------------------------------------------- translation */

  function chunkText(text, max) {
    const limit = max || 1200;
    const lines = String(text).split('\n');
    const chunks = [];
    let cur = '';
    for (const line of lines) {
      if (line.length > limit) {
        if (cur) {
          chunks.push(cur);
          cur = '';
        }
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        continue;
      }
      if ((cur + '\n' + line).length > limit) {
        if (cur) chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
    }
    if (cur) chunks.push(cur);
    return chunks.length ? chunks : [''];
  }

  async function googleTranslate(text, onProgress) {
    const src = String(text || '').trim();
    if (!src) return { text: '', chunks: 0 };

    const chunks = chunkText(src, 1200);
    const out = [];

    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress('translate', Math.round((i / chunks.length) * 100));

      const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: 'q=' + encodeURIComponent(chunks[i])
      });

      if (!res.ok) throw httpError(res.status, await res.text());

      const json = await res.json();
      const part = (json && json[0]) || [];
      out.push(part.map((seg) => (seg && seg[0]) || '').join(''));
    }

    if (onProgress) onProgress('translate', 100);
    return { text: out.join(''), chunks: chunks.length };
  }

  /** Google Translate first; if it is blocked, use the bundled offline model */
  async function translate(text, onProgress) {
    try {
      return { ...(await googleTranslate(text, onProgress)), engine: 'google' };
    } catch (e) {
      if (typeof MT === 'undefined') throw e;
      if (onProgress) onProgress('model', 0);
      const r = await MT.translate(text, (status, pct) => onProgress && onProgress(status, pct));
      return { text: r.text, chunks: r.chunks, engine: 'offline', note: 'Google Translate fail — offline model use hua' };
    }
  }

  return {
    load,
    save,
    get,
    configured,
    ocr,
    translate,
    prepareImage,
    FIELD_KEYS,
    DEFAULTS
  };
})();
