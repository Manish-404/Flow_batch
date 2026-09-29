// FlowBatch service worker: opens the side panel when the toolbar icon is clicked.
// All queue orchestration lives in the side panel page, which stays alive while it is open.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// "Send to FlowBatch" from Gemini's share dialog: keep the request where the side panel will find
// it (even if it isn't open yet), and open the panel. The panel downloads the file through the tab.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.channel !== 'flowbatch-import' || !sender.tab || !msg.item?.url) return undefined;
  // Opening needs the user's click, so it has to start before anything is awaited.
  const opened = chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(
    () => true,
    () => false
  );
  const item = { ...msg.item, tabId: sender.tab.id, at: Date.now() };
  chrome.storage.session
    .get('pendingImports')
    .then(({ pendingImports = [] }) => chrome.storage.session.set({ pendingImports: [...pendingImports, item].slice(-10) }))
    .then(() => opened)
    .then(
      (ok) => sendResponse({ ok: true, opened: ok }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) })
    );
  return true;
});
