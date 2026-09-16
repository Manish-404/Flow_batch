// FlowBatch service worker: opens the side panel when the toolbar icon is clicked.
// All queue orchestration lives in the side panel page, which stays alive while it is open.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
