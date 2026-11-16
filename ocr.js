'use strict';

/* Offline OCR wrapper around Tesseract.js (bundled in vendor/).
 *
 * Everything is local: no CDN, no network. The Urdu + English traineddata
 * lives in vendor/lang, the wasm core in vendor/.
 *
 * Scanned pages (e.g. a 300 DPI A4 with a CNIC front + back) are handled with
 * three tricks that matter a lot for accuracy:
 *   1. grayscale + contrast boost  (the ID card background is light green)
 *   2. split the page into "ink bands" and OCR each band separately, so huge
 *      white areas and scanner shadows do not ruin the layout analysis
 *   3. if a band's result looks weak, OCR it again rotated 180° (the back side
 *      of an ID card is usually upside down on the same sheet) and keep the
 *      better result
 */

const OCR = (() => {
  const baseUrl = (p) => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(p);
    }
    // dev/test mode (served over http instead of chrome-extension://)
    return new URL(p, location.href).href;
  };

  const LANG_SETS = {
    urd: { langs: 'urd', label: 'Urdu' },
    eng: { langs: 'eng', label: 'English' },
    both: { langs: 'urd+eng', label: 'Urdu + English' }
  };

  let worker = null;
  let workerLangs = null;
  let busy = false;

  /* ---------------------------------------------------------- engine ---- */

  function makeWorker(langs, onProgress) {
    return Tesseract.createWorker(langs, 1, {
      workerPath: baseUrl('vendor/worker.min.js'),
      corePath: baseUrl('vendor'),
      langPath: baseUrl('vendor/lang'),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: (m) => {
        if (onProgress) onProgress(m);
      }
    });
  }

  async function getWorker(langs, onProgress) {
    if (worker && workerLangs === langs) return worker;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
      workerLangs = null;
    }
    worker = await makeWorker(langs, onProgress);
    workerLangs = langs;
    return worker;
  }

  /* ------------------------------------------------------ image utils ---- */

  function decodeBlob(blob) {
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

  function prepareCanvas(img, { maxSide = 3200, gray = true, contrast = 1.8 } = {}) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);

    if (!gray && contrast === 1) return c;

    const data = g.getImageData(0, 0, w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (contrast !== 1) v = (v - 128) * contrast + 128;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(data, 0, 0);
    return c;
  }

  function cropCanvas(src, { x, y, w, h }, padding = 0) {
    const x0 = Math.max(0, x - padding);
    const y0 = Math.max(0, y - padding);
    const x1 = Math.min(src.width, x + w + padding);
    const y1 = Math.min(src.height, y + h + padding);

    const c = document.createElement('canvas');
    c.width = Math.max(1, x1 - x0);
    c.height = Math.max(1, y1 - y0);
    const g = c.getContext('2d');
    g.drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  function rotate180(src) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext('2d');
    g.translate(c.width, c.height);
    g.rotate(Math.PI);
    g.drawImage(src, 0, 0);
    return c;
  }

  /**
   * Find horizontal "ink bands" – groups of rows that actually contain marks.
   * A scanned sheet with a card at the top, another at the bottom and a huge
   * shadow in between produces 3 bands instead of one page Tesseract cannot
   * make sense of.
   */
  function findBands(canvas, { maxBands = 6 } = {}) {
    const probeW = Math.min(canvas.width, 420);
    const probeH = Math.max(1, Math.round((canvas.height / canvas.width) * probeW));

    const p = document.createElement('canvas');
    p.width = probeW;
    p.height = probeH;
    const pg = p.getContext('2d');
    pg.drawImage(canvas, 0, 0, probeW, probeH);
    const data = pg.getImageData(0, 0, probeW, probeH).data;

    const rows = new Array(probeH).fill(0);
    for (let y = 0; y < probeH; y++) {
      let ink = 0;
      const off = y * probeW * 4;
      for (let x = 0; x < probeW; x++) {
        if (data[off + x * 4] < 200) ink++; // dark pixel
      }
      rows[y] = ink / probeW;
    }

    const bands = [];
    let start = -1;
    const MIN_INK = 0.008; // 0.8% of the row must be dark
    for (let y = 0; y < probeH; y++) {
      const hasInk = rows[y] > MIN_INK;
      if (hasInk && start === -1) start = y;
      if (!hasInk && start !== -1) {
        bands.push([start, y]);
        start = -1;
      }
    }
    if (start !== -1) bands.push([start, probeH]);

    // merge bands separated by small gaps (e.g. between text lines)
    const merged = [];
    const GAP = Math.max(6, Math.round(probeH * 0.012));
    for (const [a, b] of bands) {
      const last = merged[merged.length - 1];
      if (last && a - last[1] <= GAP) last[1] = b;
      else merged.push([a, b]);
    }

    // drop noise slivers, convert back to full resolution
    const scaleY = canvas.height / probeH;
    const scaleX = canvas.width / probeW;
    const MIN_H = 24; // px in probe space

    const tight = [];
    for (const [a, b] of merged) {
      if (b - a < MIN_H) continue;

      // horizontal extent of the ink inside this band
      let left = probeW;
      let right = -1;
      const minInk = Math.max(2, (b - a) * 0.02);
      for (let x = 0; x < probeW; x++) {
        let ink = 0;
        for (let y = a; y < b; y++) {
          if (data[(y * probeW + x) * 4] < 200) ink++;
        }
        if (ink >= minInk) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
      if (right < 0 || right - left < probeW * 0.08) {
        left = 0;
        right = probeW - 1;
      }

      const x = Math.max(0, Math.floor(left * scaleX) - 14);
      const x2 = Math.min(canvas.width, Math.ceil((right + 1) * scaleX) + 14);
      const y = Math.max(0, Math.floor(a * scaleY) - 12);
      const y2 = Math.min(canvas.height, Math.ceil(b * scaleY) + 12);

      tight.push({ x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) });
    }

    if (!tight.length || tight.length > maxBands) {
      return [{ x: 0, y: 0, w: canvas.width, h: canvas.height }];
    }
    return tight;
  }

  /* ------------------------------------------------------------- OCR ---- */

  function cleanText(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function recognizeCanvas(w, canvas, psm) {
    await w.setParameters({
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1'
    });
    return w.recognize(canvas);
  }

  function bandScore(data) {
    const words = Array.isArray(data.words) ? data.words.length : 0;
    const conf = typeof data.confidence === 'number' ? data.confidence : 0;
    const text = (data.text || '').trim();
    const goodChars = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (!text || goodChars < 3) return -1;
    return conf + Math.min(words, 30) * 0.8;
  }

  /**
   * @param {Blob} imageBlob
   * @param {'urd'|'eng'|'both'} langKey
   * @param {(msg: {status: string, progress: number}) => void} onProgress
   * @param {{auto?: boolean, psm?: number}} [opts]
   */
  async function recognize(imageBlob, langKey, onProgress, opts = {}) {
    if (busy) throw new Error('OCR already running');
    const set = LANG_SETS[langKey] || LANG_SETS.both;
    const auto = opts.auto !== false;
    busy = true;

    try {
      const notify = (status, progress) => {
        if (onProgress) onProgress({ status, progress });
      };

      notify('preparing', 0.02);
      const img = await decodeBlob(imageBlob);
      // keep 300–400 DPI scans at full resolution; only very large images are capped
      const base = prepareCanvas(img, { maxSide: 4600, gray: true, contrast: 1.8 });
      notify('preparing', 0.06);

      const w = await getWorker(set.langs, (m) => {
        // engine/model loading phases (0 – 8% of the whole job)
        notify(m.status, (m.progress || 0) * 0.08);
      });

      const bands = auto ? findBands(base) : [{ x: 0, y: 0, w: base.width, h: base.height }];
      const total = bands.length;
      const psm = opts.psm || 3;

      const pieces = [];
      let best = { score: -1, text: '' };
      let confSum = 0;
      let confN = 0;
      let wordCount = 0;
      let lineCount = 0;
      const perBand = [];

      for (let i = 0; i < total; i++) {
        const band = bands[i];
        const canvas = cropCanvas(base, band, 8);
        const bandBase = 0.08 + (i / total) * 0.9;

        notify('recognizing text', bandBase);
        const res = await recognizeCanvas(w, canvas, psm);
        let data = res.data;
        let score = bandScore(data);

        // upside-down side of a scanned sheet? try the flipped version once
        if (score < 72 && canvas.height > 40) {
          notify('recognizing text', bandBase + 0.4 / total);
          const flipped = rotate180(canvas);
          const res2 = await recognizeCanvas(w, flipped, psm);
          const score2 = bandScore(res2.data);
          if (score2 > score) {
            data = res2.data;
            score = score2;
          }
        }

        const text = cleanText(data.text);
        if (data.confidence > (best.score > -1 ? 0 : -1) && score > best.score) {
          best = { score, text };
        }
        perBand.push({
          box: `${band.w}x${band.h}+${band.x}+${band.y}`,
          conf: data.confidence,
          words: Array.isArray(data.words) ? data.words.length : 0,
          score: Math.round(score),
          kept: score >= 0 && (data.confidence >= 45 || text.length > 12) && text.length > 2
        });

        // ignore bands that look like noise (scanner shadow, staples, photos)
        if (score >= 0 && (data.confidence >= 45 || text.length > 12) && text.length > 2) {
          pieces.push(text);
          confSum += typeof data.confidence === 'number' ? data.confidence : 0;
          confN += 1;
          wordCount += Array.isArray(data.words) ? data.words.length : 0;
          lineCount += Array.isArray(data.lines) ? data.lines.length : 0;
        }

        notify('recognizing text', bandBase + 0.9 / total);
      }

      let text = pieces.join('\n\n').trim();
      let confidence = confN ? Math.round(confSum / confN) : 0;

      if (!text) {
        // nothing passed the filters – fall back to the best raw result
        text = best.text;
        confidence = best.score > 0 ? Math.round(Math.max(0, best.score)) : 0;
      }

      return {
        text,
        confidence,
        words: wordCount,
        lines: lineCount,
        bands: total,
        perBand,
        langKey
      };
    } finally {
      busy = false;
    }
  }

  async function dispose() {
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
    worker = null;
    workerLangs = null;
  }

  return { recognize, dispose, findBands, LANG_SETS };
})();