'use strict';

const WHATSAPP_TABS = ['https://web.whatsapp.com/*'];

// Toolbar icon click -> open the side panel (no popup needed).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-clip-viewer') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    /* side panel could not be opened (e.g. window closing) */
  }
});

// --- blob: URL relay via the WhatsApp Web tab ------------------------------
// blob: URLs only resolve inside the origin that created them, so we ask an
// open web.whatsapp.com tab to fetch the bytes and hand them back as a data URL.

async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_TABS });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

function readBlobInPage(url) {
  return fetch(url, { credentials: 'include' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    })
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          if (blob.size > 40 * 1024 * 1024) {
            reject(new Error('too-large'));
            return;
          }
          const fr = new FileReader();
          fr.onload = () => resolve({ dataUrl: fr.result, type: blob.type, size: blob.size });
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        })
    )
    .catch((err) => ({ error: String((err && err.message) || err) }));
}

async function fetchBlobViaWhatsApp(url) {
  const tab = await findWhatsAppTab();
  if (!tab) return { ok: false, reason: 'no-tab' };

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readBlobInPage,
      args: [url]
    });
    const result = injection && injection.result;
    if (!result || result.error) {
      return { ok: false, reason: 'failed', detail: result && result.error };
    }
    return { ok: true, dataUrl: result.dataUrl, type: result.type, size: result.size };
  } catch (err) {
    return { ok: false, reason: 'failed', detail: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'fetch-blob') {
    fetchBlobViaWhatsApp(String(msg.url)).then(sendResponse);
    return true;
  }
});