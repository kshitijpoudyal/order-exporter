/*
 * Runs in the page's own JS world (manifest: "world": "MAIN") at document_start.
 * Wraps fetch and XMLHttpRequest so the JSON that samsclub.com loads for your order
 * history is copied to the extension's content script. Nothing leaves your browser.
 *
 * Patterns are duplicated from src/config.js because MAIN-world scripts can't share
 * globals with the isolated content script. The content script sends updated patterns
 * via postMessage on load.
 */
(function () {
  'use strict';
  if (window.__scxInjected) return;
  window.__scxInjected = true;

  let urlRes = [/./]; // same-origin only (checked in wanted()); narrowed by the content script
  let bodyRe = /order/i;
  let maxChars = 8_000_000;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__scx !== 'config') return;
    try {
      urlRes = e.data.urlPatterns.map((p) => new RegExp(p.source, p.flags));
      bodyRe = new RegExp(e.data.bodyPattern.source, e.data.bodyPattern.flags);
      maxChars = e.data.maxBodyChars || maxChars;
    } catch (_) {}
  });

  const wanted = (url) => {
    try {
      const abs = new URL(url, location.href);
      if (abs.origin !== location.origin) return false;
      return urlRes.some((re) => re.test(abs.href));
    } catch (_) {
      return false;
    }
  };

  const forward = (url, text) => {
    if (!text) return;
    const t = text.trimStart()[0];
    if (t !== '{' && t !== '[') return;
    if (text.length > maxChars || !bodyRe.test(text)) {
      // tell the content script it existed (for the debug report), without the body
      window.postMessage({ __scx: 'captureSkipped', url: String(url), size: text.length }, location.origin);
      return;
    }
    window.postMessage({ __scx: 'capture', url: String(url), body: text }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && wanted(url) && !/html|image|font|css|javascript|video|audio/i.test(res.headers.get('content-type') || '')) {
        res.clone().text().then((t) => forward(url, t)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__scxUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__scxUrl && wanted(this.__scxUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') forward(this.__scxUrl, this.responseText);
          else if (this.responseType === 'json') forward(this.__scxUrl, JSON.stringify(this.response));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
