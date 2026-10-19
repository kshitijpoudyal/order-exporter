// Service worker: only opens the welcome / disclosure page on first install.
// No network access, no data handling.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
});
