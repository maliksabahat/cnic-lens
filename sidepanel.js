'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $('dropzone'),
  preview: $('preview'),
  dzEmpty: $('dropzone-empty'),
  btnClip: $('btn-clip'),
  btnFile: $('btn-file'),
  btnOpenTab: $('btn-open-tab'),
  fileInput: $('file-input'),
  lang: $('lang'),
  btnOcr: $('btn-ocr'),
  btnClear: $('btn-clear'),
  progressWrap: $('progress-wrap'),
  progressBar: $('progress-bar'),
  progressText: $('progress-text'),
  outUr: $('out-ur'),
  outEn: $('out-en'),
  btnCopyUr: $('btn-copy-ur'),
  btnCopyEn: $('btn-copy-en'),
  ocrMeta: $('ocr-meta'),
  mtMeta: $('mt-meta'),
  fieldsList: $('fields-list'),
  btnCopyFields: $('btn-copy-fields'),
  btnFill: $('btn-fill'),
  fieldsMeta: $('fields-meta'),
  btnTranslate: $('btn-translate'),
  btnDownload: $('btn-download'),
  status: $('status'),
  toast: $('toast'),
  offlineChip: $('offline-chip'),
  btnSettings: $('btn-settings'),
  settingsCard: $('settings-card'),
  provider: $('provider'),
  geminiKey: $('gemini-key'),
  ocrSpaceKey: $('ocrspace-key'),
  rowGemini: $('row-gemini'),
  rowOcrSpace: $('row-ocrspace'),
  btnSaveOnline: $('btn-save-online'),
  btnTestOnline: $('btn-test-online'),
  onlineHint: $('online-hint')
};

const state = {
  blob: null,
  blobUrl: null,
  mode: 'offline',
  ocrRunning: false,
  ocrRerun: false,
  mtRunning: false,
  lastOcrText: '',
  fields: null
};

/* ------------------------------------------------------------- utilities */

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function setStatus(msg, kind) {
  el.status.textContent = msg || '';
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2200);
}

function showProgress(label, pct) {
  el.progressWrap.classList.remove('hidden');
  el.progressBar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  el.progressText.textContent = label + (typeof pct === 'number' ? ` ${Math.round(pct)}%` : '');
}

function hideProgress() {
  el.progressWrap.classList.add('hidden');
  el.progressBar.style.width = '0%';
}

const store = {
  async get(key) {
    try {
      const s = await chrome.storage.local.get(key);
      return s ? s[key] : undefined;
    } catch {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    }
  },
  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }
  }
};

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/png'])[1];
  const bytes = /;base64/i.test(head)
    ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* ----------------------------------------------------------- image input */

function setImage(blob, sourceLabel) {
  if (!blob || !blob.size) {
    setStatus('Image khali hai', 'err');
    return;
  }

  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blob = blob;
  state.blobUrl = URL.createObjectURL(blob);

  el.preview.src = state.blobUrl;
  el.preview.classList.remove('hidden');
  el.dzEmpty.classList.add('hidden');
  el.btnOpenTab.classList.remove('hidden');
  el.btnOcr.disabled = false;

  setStatus(`Image mili (${sourceLabel || 'clipboard'}) · ${formatBytes(blob.size)}`);
  return runOcr();
}

async function pickClipboardImage() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      setStatus('Ye Chrome clipboard.read support nahi karta', 'err');
      return;
    }

    const items = await navigator.clipboard.read();

    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return setImage(await item.getType(type), 'clipboard');
    }

    for (const item of items) {
      if (!item.types.includes('text/plain')) continue;
      const text = (await (await item.getType('text/plain')).text()).trim();
      if (/^blob:/i.test(text)) {
        setStatus('Clipboard me blob: URL hai — WhatsApp Web se image laa raha hoon…', 'warn');
        const res = await chrome.runtime.sendMessage({ type: 'fetch-blob', url: text });
        if (res && res.ok) return setImage(dataUrlToBlob(res.dataUrl), 'WhatsApp Web');
        setStatus('Blob URL load nahi hua (expire ho gayi ya WhatsApp tab band hai)', 'warn');
        return;
      }
      if (text) {
        setStatus('Clipboard me image nahi, text hai', 'warn');
        return;
      }
    }

    setStatus('Clipboard me image nahi mili — file chuno ya drag karo', 'warn');
  } catch (err) {
    setStatus(
      'Clipboard read block hui: ' +
        (err && err.name === 'NotAllowedError' ? 'panel par click karke dobara try karo' : String(err)),
      'warn'
    );
  }
}

/* ------------------------------------------------------------------- OCR */

const OCR_LABELS = {
  preparing: 'Image tayyar ho rahi hai',
  'loading tesseract core': 'OCR engine load',
  'initializing tesseract': 'OCR engine init',
  'loading language traineddata': 'Language model load',
  'initializing api': 'Tayyar ho raha hai',
  'recognizing text': 'Text padha ja raha hai'
};

function ocrWeight(status, progress) {
  const p = typeof progress === 'number' ? progress : 0;
  switch (status) {
    case 'loading tesseract core':
      return 0 + p * 15;
    case 'initializing tesseract':
      return 15 + p * 5;
    case 'loading language traineddata':
      return 20 + p * 25;
    case 'initializing api':
      return 45 + p * 10;
    case 'recognizing text':
      return 55 + p * 45;
    default:
      return p * 100;
  }
}

async function offlineRecognize() {
  const res = await OCR.recognize(state.blob, el.lang.value, (m) => {
    const label = OCR_LABELS[m.status] || m.status;
    showProgress(label, ocrWeight(m.status, m.progress));
  });
  return { text: res.text, confidence: res.confidence, fields: null, source: 'offline' };
}

function applyOcrResult(res, meta) {
  const text = res.text || '';
  state.lastOcrText = text;
  el.outUr.value = text;
  el.outUr.dir = /[\u0600-\u06FF]/.test(text) ? 'rtl' : 'ltr';

  const local = Fields.extract(text);
  const cloud = res.fields;
  const cloudUsed = !!cloud && Object.values(cloud).some(Boolean);
  const textOnline = res.source !== 'offline';

  state.fields = cloudUsed ? Fields.merge({ fields: cloud }, local) : local;
  if (!state.fields.sources) state.fields.sources = {};
  for (const k of state.fields.order) {
    if (!state.fields.sources[k]) state.fields.sources[k] = textOnline ? 'online' : 'offline';
    else if (textOnline) state.fields.sources[k] = 'online';
  }

  renderFields(state.fields);

  const bits = [];
  bits.push(meta.label);
  if (res.confidence != null) bits.push(`${Math.round(res.confidence)}% conf`);
  bits.push(`${(text.match(/\S+/g) || []).length} words`);
  el.ocrMeta.textContent = bits.join(' · ');

  if (!text) {
    setStatus('OCR ko koi text nahi mila — image clear hai? zyada zoom karke try karo', 'warn');
    return;
  }

  if (state.fields.found >= 2) {
    switchTab('fields');
    setStatus(`${state.fields.found} fields mil gaye · translate bhi kar sakte hain`, meta.kind || 'ok');
    el.btnTranslate.disabled = false;
    return;
  }

  switchTab('ur');
  el.btnTranslate.disabled = false;
  if (!meta.online && typeof MT !== 'undefined' && MT.scriptOf(text) === 'latin') {
    setStatus('Roman Urdu / English text mila — offline model Urdu script ke liye hai', 'warn');
  } else {
    setStatus('Text nikal aaya · ab translate kar sakte hain', meta.kind || 'ok');
  }
}

async function runOcr() {
  if (!state.blob) return;

  if (state.ocrRunning) {
    state.ocrRerun = true;
    return;
  }

  state.ocrRunning = true;
  el.btnOcr.disabled = true;
  el.btnTranslate.disabled = true;

  const online = state.mode === 'online';
  setStatus(online ? 'Online OCR chal raha hai…' : 'OCR chal raha hai (offline)…');
  showProgress(online ? 'Cloud OCR' : 'OCR', online ? 15 : 0);

  try {
    let res;

    if (online) {
      if (!Online.configured()) {
        setStatus('Online mode ke liye Settings me free API key daalo (⚙)', 'warn');
        openSettings(true);
        throw new Error('API key nahi hai');
      }

      try {
        showProgress('Cloud OCR', 45);
        const cloud = await Online.ocr(state.blob);
        res = {
          text: cloud.text,
          fields: cloud.fields,
          confidence: null,
          source: cloud.source
        };
      } catch (cloudErr) {
        const msg = String((cloudErr && cloudErr.message) || cloudErr);
        setStatus('Online fail (' + msg + ') — offline OCR try kar raha hoon…', 'warn');
        showProgress('Offline OCR', 20);
        res = await offlineRecognize();
        res.fallbackNote = msg;
      }
    } else {
      res = await offlineRecognize();
    }

    const label = res.source === 'gemini' ? 'Gemini · online' : res.source === 'ocrspace' ? 'OCR.space · online' : 'Tesseract · offline';
    applyOcrResult(res, { label, online: res.source !== 'offline', kind: res.fallbackNote ? 'warn' : 'ok' });

    if (res.fallbackNote) {
      setStatus('Online fail — offline OCR use hua (' + res.fallbackNote.slice(0, 60) + ')', 'warn');
    }
  } catch (err) {
    setStatus('OCR fail: ' + String((err && err.message) || err), 'err');
  } finally {
    state.ocrRunning = false;
    el.btnOcr.disabled = false;
    hideProgress();
    if (state.ocrRerun) {
      state.ocrRerun = false;
      runOcr();
    }
  }
}

/* --------------------------------------------------------------- fields */

function renderFields(result) {
  const list = el.fieldsList;
  list.innerHTML = '';

  if (!result || !result.found) {
    list.innerHTML = '<p class="empty-note">Card ke fields nahi mile. "Raw" tab me poora text dekho.</p>';
    el.btnCopyFields.disabled = true;
    el.btnFill.disabled = true;
    el.fieldsMeta.textContent = '';
    return;
  }

  for (const key of result.order) {
    const value = result.fields[key];

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'field';
    row.title = 'Click → copy';

    const k = document.createElement('span');
    k.className = 'field-key';
    k.textContent = result.labels[key];

    const sep = document.createElement('span');
    sep.className = 'field-sep';
    sep.textContent = ':';

    const v = document.createElement('span');
    v.className = 'field-val';
    v.textContent = value;
    if (/[\u0600-\u06FF]/.test(value)) v.setAttribute('dir', 'rtl');

    const src = (result.sources && result.sources[key]) || 'offline';
    const badge = document.createElement('span');
    badge.className = 'src ' + (src === 'online' ? 'src-on' : 'src-off');
    badge.textContent = src === 'online' ? 'online' : 'offline';
    badge.title =
      src === 'online' ? 'Ye value cloud API (online) se aayi' : 'Ye value offline OCR/parser se aayi';

    row.appendChild(k);
    row.appendChild(sep);
    row.appendChild(v);
    row.appendChild(badge);
    row.addEventListener('click', () => copyValue(row, value));
    list.appendChild(row);
  }

  const sources = result.sources || {};
  const onCount = result.order.filter((k) => sources[k] === 'online').length;
  const offCount = result.found - onCount;

  el.btnCopyFields.disabled = false;
  el.btnFill.disabled = false;
  el.fieldsMeta.textContent = `${result.found} fields · ${onCount} online, ${offCount} offline`;
}

async function copyValue(row, value) {
  try {
    await navigator.clipboard.writeText(value);
    row.classList.add('copied');
    setTimeout(() => row.classList.remove('copied'), 900);
    toast('Copy: ' + (value.length > 26 ? value.slice(0, 26) + '…' : value));
  } catch {
    toast('Copy nahi hua');
  }
}

function copyFields() {
  if (!state.fields || !state.fields.found) return;
  navigator.clipboard.writeText(Fields.toText(state.fields)).then(
    () => toast('Fields copy ho gaye'),
    () => toast('Copy nahi hua')
  );
}

/* ----------------------------------------------------------- form fill */

/* Runs inside the page (chrome.scripting.executeScript serialises this
 * function), so it must not use anything from the panel's scope.
 * Targets the PM Youth Programme loan form (pmybals.pmyp.gov.pk). */
function fillPmypForm(payload) {
  const d = payload || {};
  const dmy = (s) => String(s || '').replace(/[.]/g, '-');

  function setVal(el, value) {
    if (!el || value == null || value === '') return false;
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return true;
  }

  const byId = (id) => document.getElementById(id);
  const filled = [];
  const skipped = [];

  const map = [
    ['Applicantname', d.name, 'Name'],
    ['forhname', d.fatherName, 'Father Name'],
    ['cnic', d.cnic, 'CNIC'],
    ['txtDOB', dmy(d.dob), 'Date of Birth'],
    ['txtCnic', dmy(d.issue), 'Date of Issue'],
    ['present', d.address, 'Present Address']
  ];

  for (const [id, value, label] of map) {
    if (!value) {
      skipped.push(label);
      continue;
    }
    if (setVal(byId(id), value)) filled.push(label);
    else skipped.push(label);
  }

  // gender is a select2 dropdown
  const g = byId('gender');
  if (g && d.gender) {
    const want = String(d.gender).toUpperCase() === 'F' ? /female/i : /male/i;
    const opt = Array.from(g.options || []).find((o) => want.test((o.textContent || '').trim()));
    if (opt) {
      g.value = opt.value;
      g.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('Gender');
    } else {
      skipped.push('Gender');
    }
  } else {
    skipped.push('Gender');
  }

  return { filled, skipped, url: location.href, title: document.title };
}

async function fillActiveForm() {
  if (!state.fields || !state.fields.found) return;

  const f = state.fields.fields;
  const payload = {
    name: f.name,
    fatherName: f.fatherName,
    cnic: f.cnic,
    dob: f.dob,
    issue: f.issue,
    address: f.address,
    gender: f.gender
  };

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      toast('Koi tab nahi mila');
      return;
    }

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillPmypForm,
      args: [payload]
    });

    const out = (res && res.result) || { filled: [], skipped: [] };
    if (out.filled.length) {
      setStatus(`${out.filled.length} fields form me daal diye`, 'ok');
      toast('Form bhar diya: ' + out.filled.join(', ').slice(0, 60));
      if (out.skipped.length) {
        toast('Ye khud bharo: ' + out.skipped.join(', ').slice(0, 60));
      }
    } else {
      setStatus('Is page par form fields nahi mile — PM Youth form khola hua hai?', 'warn');
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/file:\/\//i.test(msg) || /cannot access|Cannot access/i.test(msg)) {
      setStatus('Local file par access nahi — chrome://extensions → Clip → "Allow access to file URLs" ON karo', 'warn');
    } else {
      setStatus('Form fill fail: ' + msg.slice(0, 90), 'err');
    }
  }
}

/* ----------------------------------------------------------- translation */

async function runTranslate() {
  const text = el.outUr.value.trim();
  if (!text || state.mtRunning) return;

  state.mtRunning = true;
  el.btnTranslate.disabled = true;
  switchTab('en');
  showProgress('Translation', 0);
  setStatus(state.mode === 'online' ? 'Online translation shuru…' : 'Offline translation shuru…');

  try {
    const res =
      state.mode === 'online'
        ? await Online.translate(text, (status, pct) => {
            showProgress(status === 'translate' ? 'Translate ho raha hai' : 'Offline model load', pct);
          })
        : await MT.translate(text, (status, pct) => {
            showProgress(status === 'translate' ? 'Translate ho raha hai' : 'Model load ho raha hai', pct);
          });

    el.outEn.value = res.text;
    el.mtMeta.textContent = res.text
      ? `${res.chunks} chunk(s) · ${state.mode === 'online' ? (res.engine === 'google' ? 'Google Translate' : 'offline model') : 'offline model'}`
      : '';

    if (res.text) {
      setStatus('Translation tayyar' + (res.note ? ` (${res.note})` : ''), 'ok');
      switchTab('en');
    } else {
      setStatus('Translation khali aayi — text chhota/saaf karke dobara try karo', 'warn');
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    setStatus('Translation fail: ' + msg, 'err');
    if (/model|onnx|fetch|404/i.test(msg)) {
      toast('Translation model load nahi hua');
    }
  } finally {
    state.mtRunning = false;
    el.btnTranslate.disabled = !el.outUr.value.trim();
    hideProgress();
  }
}

/* ------------------------------------------------------------------- ui */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  $('pane-fields').classList.toggle('hidden', name !== 'fields');
  $('pane-ur').classList.toggle('hidden', name !== 'ur');
  $('pane-en').classList.toggle('hidden', name !== 'en');
}

function applyMode(mode) {
  state.mode = mode === 'online' ? 'online' : 'offline';
  document.querySelectorAll('.mode').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === state.mode);
  });

  const online = state.mode === 'online';
  el.offlineChip.textContent = online ? 'ONLINE' : 'OFFLINE';
  el.offlineChip.classList.toggle('online', online);
  el.offlineChip.title = online
    ? 'Online mode: image cloud API par jati hai (jab tak aap Online chunte hain)'
    : 'Sab kuch aap ke computer par chalta hai';
  el.btnTranslate.textContent = online ? 'English me translate karo ⚡' : 'English me translate karo';
}

function setMode(mode) {
  applyMode(mode);
  store.set('mode', state.mode);
  if (state.mode === 'online' && !Online.configured()) openSettings(true);
  if (state.blob) runOcr();
}

function openSettings(force) {
  const show = force === true ? true : el.settingsCard.classList.contains('hidden');
  el.settingsCard.classList.toggle('hidden', !show);
  if (show) el.settingsCard.scrollIntoView({ block: 'nearest' });
}

function syncOnlineUi() {
  const cfg = Online.get();
  el.provider.value = cfg.provider;
  el.geminiKey.value = cfg.geminiKey || '';
  el.ocrSpaceKey.value = cfg.ocrSpaceKey || '';
  const gemini = cfg.provider === 'gemini';
  el.rowGemini.classList.toggle('hidden', !gemini);
  el.rowOcrSpace.classList.toggle('hidden', gemini);

  if (gemini) {
    el.onlineHint.innerHTML =
      'Gemini free key: <b>aistudio.google.com/apikey</b> → "Create API key" → copy. Urdu Nastaliq behtar padhta hai.';
  } else {
    el.onlineHint.innerHTML =
      'OCR.space free key: <b>ocr.space/ocrapi/freekey</b> (25,000/month). Demo key shared hai, is liye apni key lagana behtar hai. English/mix cards ke liye theek.';
  }
}

async function saveOnlineSettings() {
  const provider = el.provider.value;
  await Online.save({
    provider,
    geminiKey: el.geminiKey.value.trim(),
    ocrSpaceKey: el.ocrSpaceKey.value.trim()
  });
  syncOnlineUi();
  toast('Online settings save ho gayi');
  setStatus('Settings save · ' + (Online.configured() ? 'online ready' : 'key chahiye'), Online.configured() ? 'ok' : 'warn');
}

function clearAll() {
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blob = null;
  state.blobUrl = null;
  state.lastOcrText = '';
  state.fields = null;
  el.preview.removeAttribute('src');
  el.preview.classList.add('hidden');
  el.dzEmpty.classList.remove('hidden');
  el.btnOpenTab.classList.add('hidden');
  el.outUr.value = '';
  el.outEn.value = '';
  el.ocrMeta.textContent = '';
  el.mtMeta.textContent = '';
  renderFields(null);
  el.btnOcr.disabled = true;
  el.btnTranslate.disabled = true;
  hideProgress();
  switchTab('fields');
  setStatus('Clear — naya image paste karo');
}

function downloadText() {
  const fields = state.fields && state.fields.found ? Fields.toText(state.fields) : '';
  const urdu = el.outUr.value.trim();
  const english = el.outEn.value.trim();
  if (!fields && !urdu && !english) return;

  const parts = [];
  if (fields) parts.push('--- FIELDS ---\n' + fields);
  if (urdu) parts.push('--- RAW TEXT ---\n' + urdu);
  if (english) parts.push('--- ENGLISH ---\n' + english);

  const blob = new Blob([parts.join('\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clip-text-${Date.now()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* --------------------------------------------------------------- wiring */

el.btnClip.addEventListener('click', pickClipboardImage);
el.btnFile.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files && el.fileInput.files[0];
  if (f) setImage(f, 'file');
  el.fileInput.value = '';
});
el.btnOcr.addEventListener('click', runOcr);
el.btnTranslate.addEventListener('click', runTranslate);
el.btnClear.addEventListener('click', clearAll);
el.btnCopyFields.addEventListener('click', copyFields);
el.btnFill.addEventListener('click', fillActiveForm);

document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

el.btnOpenTab.addEventListener('click', async () => {
  if (!state.blob) return;
  try {
    if (state.blob.size > 7 * 1024 * 1024) {
      toast('Image bari hai — naye tab me kholne ke liye size kam karo');
      return;
    }
    const dataUrl = await blobToDataUrl(state.blob);
    await chrome.storage.session.set({ pendingImage: { dataUrl, type: state.blob.type } });
    await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  } catch (err) {
    toast('Naye tab me kholne me masla: ' + String((err && err.message) || err));
  }
});

el.btnDownload.addEventListener('click', downloadText);
el.lang.addEventListener('change', () => {
  if (state.blob) runOcr();
});

el.btnCopyUr.addEventListener('click', async () => {
  if (!el.outUr.value.trim()) return;
  await navigator.clipboard.writeText(el.outUr.value);
  toast('Raw text copy ho gaya');
});

el.btnCopyEn.addEventListener('click', async () => {
  if (!el.outEn.value.trim()) return;
  await navigator.clipboard.writeText(el.outEn.value);
  toast('English copy ho gaya');
});

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

el.btnSettings.addEventListener('click', () => openSettings());
el.provider.addEventListener('change', syncOnlineUi);
el.btnSaveOnline.addEventListener('click', saveOnlineSettings);
el.btnTestOnline.addEventListener('click', async () => {
  await saveOnlineSettings();
  if (!state.blob) {
    toast(Online.configured() ? 'Key save hai — ab image paste karo' : 'Pehle key daalo');
    return;
  }
  setMode('online');
});

/* paste anywhere in the panel */
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;

  const file = Array.from(cd.files || []).find((f) => f.type.startsWith('image/'));
  if (file) {
    e.preventDefault();
    setImage(file, 'paste');
    return;
  }

  for (const item of Array.from(cd.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        setImage(f, 'paste');
        return;
      }
    }
  }

  const text = cd.getData('text/plain');
  if (text && /^blob:/i.test(text.trim())) {
    e.preventDefault();
    chrome.runtime
      .sendMessage({ type: 'fetch-blob', url: text.trim() })
      .then((res) => {
        if (res && res.ok) setImage(dataUrlToBlob(res.dataUrl), 'WhatsApp Web');
        else setStatus('Blob URL load nahi hui', 'warn');
      });
  }
});

/* drag & drop */
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find((x) => x.type.startsWith('image/'));
  if (f) setImage(f, 'drop');
});

/* auto-read clipboard when the panel opens / regains focus */
let autoTried = false;
async function autoRead() {
  if (autoTried || state.blob) return;
  autoTried = true;
  if (!document.hasFocus()) return;
  await pickClipboardImage();
}

window.addEventListener('focus', autoRead);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoRead();
});

/* boot */
(async () => {
  await Online.load();
  syncOnlineUi();
  const savedMode = await store.get('mode');
  applyMode(savedMode === 'online' ? 'online' : 'offline');
  renderFields(null);
  requestAnimationFrame(() => setTimeout(autoRead, 150));
})();
