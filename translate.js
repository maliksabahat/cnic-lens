'use strict';

/* Offline Urdu → English translation.
 *
 * Uses a bundled Marian (opus-mt-ur-en, int8) model through transformers.js.
 * Nothing leaves the machine: no API key, no account, no network.
 */

const MT = (() => {
  let pipe = null;
  let loadingPromise = null;

  const base = (p) =>
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL(p)
      : new URL(p, location.href).href;

  let libPromise = null;

  // transformers.min.js is an ES module – pull it in with a dynamic import so
  // this file can stay a plain script.
  async function ensureLib() {
    if (!libPromise) {
      libPromise = import(base('vendor/transformers.min.js')).catch((err) => {
        libPromise = null;
        throw new Error('transformers.min.js load nahi hua: ' + (err && err.message ? err.message : err));
      });
    }
    return libPromise;
  }

  async function getPipeline(onProgress) {
    if (pipe) return pipe;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      const T = await ensureLib();
      const env = T.env;

      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = false;
      env.localModelPath = base('vendor/mt/');
      env.backends.onnx.wasm.wasmPaths = base('vendor/ort/');
      env.backends.onnx.wasm.numThreads = 1;

      pipe = await T.pipeline('translation', 'opus-mt-ur-en', {
        quantized: true,
        progress_callback: (p) => {
          if (!onProgress || !p) return;
          const raw = typeof p.progress === 'number' ? p.progress : null;
          const pct = raw == null ? null : Math.round(raw <= 1 ? raw * 100 : raw);
          onProgress(p.status || 'load', pct);
        }
      });
      return pipe;
    })();

    try {
      return await loadingPromise;
    } catch (err) {
      loadingPromise = null;
      pipe = null;
      throw err;
    }
  }

  /** crude script check: is the text mostly Arabic-script (Urdu) characters? */
  function scriptOf(text) {
    const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (!arabic && !latin) return 'unknown';
    return arabic >= latin ? 'urdu' : 'latin';
  }

  function chunk(text, maxLen = 400) {
    const parts = [];
    const paragraphs = String(text).split(/\n+/);

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      if (trimmed.length <= maxLen) {
        parts.push(trimmed);
        continue;
      }

      // split long paragraphs into sentence-sized pieces
      const sentences = trimmed.split(/(?<=[۔۔!؟?!.۔])\s+/);
      let buf = '';
      for (const s of sentences) {
        if ((buf + ' ' + s).trim().length > maxLen && buf) {
          parts.push(buf.trim());
          buf = s;
        } else {
          buf = (buf + ' ' + s).trim();
        }
      }
      if (buf.trim()) parts.push(buf.trim());
    }

    return parts.length ? parts : [String(text).trim()];
  }

  /**
   * @param {string} text
   * @param {(info: {status: string, progress: number|null}) => void} onProgress
   */
  async function translate(text, onProgress) {
    const clean = String(text || '').trim();
    if (!clean) return { text: '', chunks: 0 };

    const translator = await getPipeline(onProgress);
    const pieces = chunk(clean);
    const out = [];

    for (let i = 0; i < pieces.length; i++) {
      if (onProgress) onProgress('translate', Math.round(((i + 1) / pieces.length) * 100));
      const result = await translator(pieces[i], { max_length: 400 });
      const first = Array.isArray(result) ? result[0] : result;
      const piece = (first && (first.translation_text || first.generated_text)) || '';
      out.push(piece.trim());
    }

    return { text: out.filter(Boolean).join('\n'), chunks: pieces.length };
  }

  async function isReady() {
    return !!pipe;
  }

  async function warmUp(onProgress) {
    await getPipeline(onProgress);
    return true;
  }

  return { translate, scriptOf, isReady, warmUp };
})();