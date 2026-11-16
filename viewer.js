'use strict';

/* Image Clip Viewer – viewer page logic
 *
 * Sources of the image:
 *   1. Clipboard bitmap  -> navigator.clipboard.read()
 *   2. Ctrl+V / drag&drop inside this page
 *   3. A blob: URL (e.g. blob:https://web.whatsapp.com/...) handed to the
 *      WhatsApp Web tab, which fetches the bytes for us (see background.js).
 */

const $ = (id) => document.getElementById(id);

const els = {
  stage: $('stage'),
  empty: $('empty'),
  preview: $('preview'),
  blobCard: $('blob-card'),
  blobUrl: $('blob-url'),
  btnRead: $('btn-read'),
  btnCopy: $('btn-copy'),
  btnDownload: $('btn-download'),
  btnRelay: $('btn-relay'),
  metaType: $('meta-type'),
  metaSize: $('meta-size'),
  metaDims: $('meta-dims'),
  status: $('status'),
  toast: $('toast')
};

/** @type {{blob: Blob, url: string, type: string} | null} */
let current = null;
/** @type {string | null} */
let pendingBlobUrl = null;
let autoReadTried = false;

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
};

/* ---------------------------------------------------------------- helpers */

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function setStatus(message, kind) {
  els.status.textContent = message || '';
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
}

function showEmptyState(message) {
  els.preview.classList.add('hidden');
  els.preview.removeAttribute('src');
  els.empty.classList.remove('hidden');
  if (message) {
    const hint = els.empty.querySelector('.hint');
    if (hint) hint.textContent = message;
  }
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'application/octet-stream'])[1];
  const isBase64 = /;base64/i.test(head);
  const bytes = isBase64
    ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  return new Blob([bytes], { type: mime });
}

/* -------------------------------------------------------------- rendering */

function showImage(blob, source) {
  if (!blob || !blob.size) {
    setStatus('Image khali hai', 'err');
    return;
  }

  if (current && current.url) URL.revokeObjectURL(current.url);

  const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
  const url = URL.createObjectURL(blob);
  current = { blob, url, type };

  els.preview.src = url;
  els.preview.classList.remove('hidden');
  els.empty.classList.add('hidden');
  els.blobCard.classList.add('hidden');

  els.btnDownload.href = url;
  els.btnDownload.download = `clip-${timestamp()}.${EXT_BY_TYPE[type] || 'png'}`;
  els.btnDownload.classList.remove('is-disabled');
  els.btnCopy.disabled = false;

  els.metaType.textContent = type;
  els.metaSize.textContent = formatBytes(blob.size);
  els.metaDims.textContent = '';

  setStatus(source ? `Image mil gayi (${source})` : 'Image mil gayi', 'ok');
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------- clipboard (read) */

async function readClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    setStatus('Ye Chrome version clipboard.read support nahi karta', 'err');
    return;
  }

  setStatus('Clipboard padha ja raha hai…');

  try {
    const items = await navigator.clipboard.read();

    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        showImage(await item.getType(imageType), 'clipboard');
        return;
      }
    }

    for (const item of items) {
      if (item.types.includes('text/plain')) {
        const text = (await (await item.getType('text/plain')).text()).trim();
        if (text) {
          handleText(text);
          return;
        }
      }
    }

    if (!current) {
      setStatus('Clipboard me image nahi mili', 'warn');
      showEmptyState('Clipboard khali hai. WhatsApp me image par right-click → "Copy image" karo, phir yahan Ctrl+V dabao.');
    }
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') {
      setStatus('Chrome ne clipboard block kiya — page par click karke dobara try karo', 'warn');
      showEmptyState('Clipboard access block ho gaya. Page par ek click karo aur "Clipboard dobara padho" dabao (ya seedha Ctrl+V karo).');
    } else {
      setStatus('Clipboard error: ' + (err && err.message ? err.message : err), 'err');
    }
  }
}

/* ------------------------------------------------- blob: URL / text input */

function handleText(text) {
  const value = text.trim();

  if (/^blob:/i.test(value)) {
    pendingBlobUrl = value;
    els.blobUrl.textContent = value;
    els.blobCard.classList.remove('hidden');
    els.preview.classList.add('hidden');
    els.empty.classList.remove('hidden');
    setStatus('blob: URL mila — "WhatsApp tab se image laao" dabao', 'warn');
    return;
  }

  if (/^data:image\//i.test(value)) {
    try {
      showImage(dataUrlToBlob(value), 'data URL');
    } catch {
      setStatus('Data URL parse nahi hua', 'err');
    }
    return;
  }

  if (/^https?:\/\//i.test(value)) {
    loadRemoteImage(value);
    return;
  }

  setStatus('Clipboard me text hai, image nahi', 'warn');
  showEmptyState(`Clipboard me ye text mila: "${value.slice(0, 140)}"`);
}

async function loadRemoteImage(url) {
  setStatus('Image download ho rahi hai…');
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Ye image nahi hai');
    showImage(blob, 'URL');
  } catch (err) {
    setStatus('URL se image nahi aa saki (CORS / permission)', 'err');
    showEmptyState(`Direct load nahi hua: ${url}\nAap is link ko naye tab me khol sakte hain.`);
  }
}

async function relayBlob() {
  if (!pendingBlobUrl) return;

  els.btnRelay.disabled = true;
  setStatus('WhatsApp Web tab se image laayi ja rahi hai…');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'fetch-blob', url: pendingBlobUrl });

    if (res && res.ok) {
      showImage(dataUrlToBlob(res.dataUrl), 'WhatsApp Web');
      return;
    }

    if (res && res.reason === 'no-tab') {
      setStatus('WhatsApp Web ka koi tab khula nahi hai', 'warn');
      showEmptyState('Pehle web.whatsapp.com wala tab kholo, phir dobara try karo.');
      return;
    }

    if (res && res.detail === 'too-large') {
      setStatus('Image 40 MB se bari hai', 'warn');
      return;
    }

    setStatus('Blob URL load nahi hua — expire ho gaya hoga', 'err');
    showEmptyState('Ye blob URL purani ho chuki hai. WhatsApp me image dobara copy karo (right-click → Copy image) aur seedha Ctrl+V karo.');
  } catch (err) {
    setStatus('Extension error: ' + (err && err.message ? err.message : err), 'err');
  } finally {
    els.btnRelay.disabled = false;
  }
}





/* ------------------------------------------------------------------ paste */

function handlePaste(event) {
  const cd = event.clipboardData;
  if (!cd) return;

  const files = Array.from(cd.files || []);
  const imageFile = files.find((f) => f.type.startsWith('image/'));
  if (imageFile) {
    event.preventDefault();
    showImage(imageFile, 'paste');
    return;
  }

  const items = Array.from(cd.items || []);
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        showImage(file, 'paste');
        return;
      }
    }
  }

  const text = cd.getData('text/plain');
  if (text && text.trim()) {
    event.preventDefault();
    handleText(text);
  }
}

/* ------------------------------------------------------------- drag & drop */

function handleDrop(event) {
  event.preventDefault();
  document.body.classList.remove('dragging');

  const dt = event.dataTransfer;
  if (!dt) return;

  const file = Array.from(dt.files || []).find((f) => f.type.startsWith('image/'));
  if (file) {
    showImage(file, 'drop');
    return;
  }

  const text = dt.getData('text/plain');
  if (text && text.trim()) handleText(text);
}

/* --------------------------------------------------------------- wiring up */

els.btnRead.addEventListener('click', () => readClipboard());
els.btnRelay.addEventListener('click', relayBlob);

els.btnCopy.addEventListener('click', async () => {
  if (!current) return;
  try {
    // chrome only accepts image/png inside ClipboardItem, so normalise first
    const blob = current.type === 'image/png' ? current.blob : await toPng(current.blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image clipboard me copy ho gayi');
  } catch (err) {
    setStatus('Copy fail: ' + (err && err.message ? err.message : err), 'err');
  }
});

async function toPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

document.addEventListener('paste', handlePaste);

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', handleDrop);

els.preview.addEventListener('load', () => {
  els.metaDims.textContent = `${els.preview.naturalWidth} × ${els.preview.naturalHeight} px`;
});

els.preview.addEventListener('error', () => {
  els.metaDims.textContent = '';
  setStatus('Image render nahi hui', 'err');
});

// Auto-read once when the tab opens…
function autoRead() {
  if (autoReadTried || current) return;
  autoReadTried = true;
  readClipboard();
}

// …and re-read whenever the tab becomes visible again (Alt+Shift+V reuse).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // the hotkey re-uses this tab, so re-read the clipboard whenever it returns
  setTimeout(() => {
    if (document.hasFocus()) readClipboard();
  }, 120);
});

// Image handed over from the side panel ("open in tab") takes priority,
// otherwise read the clipboard once.
(async () => {
  try {
    const { pendingImage } = await chrome.storage.session.get('pendingImage');
    if (pendingImage && pendingImage.dataUrl) {
      await chrome.storage.session.remove('pendingImage');
      autoReadTried = true;
      showImage(dataUrlToBlob(pendingImage.dataUrl), 'side panel');
      return;
    }
  } catch {
    /* storage not available – fall back to clipboard */
  }

  requestAnimationFrame(() => setTimeout(autoRead, 120));
})();