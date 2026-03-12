// When the user clicks the extension icon, tell the content script to show the widget.
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: 'show' }).catch(() => {});
});
