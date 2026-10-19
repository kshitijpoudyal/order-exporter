(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = globalThis.SCX_RETAILERS;
  const E = globalThis.SCXExport;
  const U = globalThis.SCXUI;

  let retailer = null; // selected retailer config
  let tab = null; // active tab
  let tabRetailer = null; // retailer of the active tab, if any
  let pollTimer = null;

  const range = () => U.rangeFor($('range').value, $('from').value, $('to').value);
  // We can only talk to the tab if it's on the selected retailer's site.
  const tabId = () => (tab && tabRetailer && retailer && tabRetailer.id === retailer.id ? tab.id : null);

  // ---------- retailer picker ----------

  function renderPicker() {
    const box = $('retailerPicker');
    box.textContent = '';
    for (const r of R.SUPPORTED) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (retailer && retailer.id === r.id ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(retailer && retailer.id === r.id));
      b.appendChild(U.monogram(r, 22));
      b.appendChild(document.createTextNode(r.name));
      b.addEventListener('click', () => selectRetailer(r, { manual: true }));
      box.appendChild(b);
    }
    $('autoBadge').classList.toggle('hidden', !(tabRetailer && retailer && tabRetailer.id === retailer.id));
  }

  async function selectRetailer(r, { manual } = {}) {
    retailer = r;
    if (manual) chrome.storage.local.set({ lastRetailer: r.id });
    renderPicker();
    $('openOrders').textContent = `Open ${r.name} order history`;
    const st = await refreshStatus();
    if (st && st.scanning) startPolling();
  }

  // ---------- status + stats ----------

  async function refreshStats() {
    if (!retailer) return;
    const orders = await U.ordersFor(retailer.id, range());
    const s = E.summarize(orders);
    $('sOrders').textContent = s.orders;
    $('sItems').textContent = s.items;
    $('sTotal').textContent = U.fmtMoney(s.total);
    $('sTax').textContent = U.fmtMoney(s.tax);
    $('sRange').textContent = s.orders ? `${s.first || '…'} → ${s.last || '…'}` : `No ${retailer.name} orders saved for this range yet.`;
    const warns = [];
    if (s.missingDetails) warns.push(`${s.missingDetails} order${s.missingDetails > 1 ? 's are' : ' is'} missing item or tax details. Re-scan with details on.`);
    if (orders.undatedExcluded) warns.push(`${orders.undatedExcluded} saved order${orders.undatedExcluded > 1 ? 's have' : ' has'} no date yet and ${orders.undatedExcluded > 1 ? 'are' : 'is'} hidden by the date range. Scan with details on, or choose "All available history".`);
    $('sWarn').classList.toggle('hidden', !warns.length);
    $('sWarn').textContent = warns.join(' ');
    $('xlsx').disabled = $('csv').disabled = !s.orders;
  }

  function send(msg) {
    return new Promise((resolve) => {
      const id = tabId();
      if (id === null) return resolve(null);
      chrome.tabs.sendMessage(id, msg, (r) => {
        void chrome.runtime.lastError; // tab without our content script (e.g. not reloaded since install)
        resolve(r || null);
      });
    });
  }

  async function refreshStatus() {
    const st = await send({ type: 'status' });
    const dot = $('dot');
    if (!st) {
      dot.className = 'dot bad';
      $('connText').textContent =
        tabRetailer && tabRetailer.id === retailer.id
          ? `Reload this ${retailer.name} tab, then open the extension again.`
          : `Open ${retailer.name} and sign in to scan.`;
      $('openOrders').classList.remove('hidden');
      $('scan').disabled = true;
      $('stop').classList.add('hidden');
      $('progress').textContent = '';
    } else {
      dot.className = 'dot ok';
      $('connText').textContent = st.onOrdersPage ? `On your ${retailer.name} order history.` : `On ${retailer.name} — open your orders to scan.`;
      $('openOrders').classList.toggle('hidden', st.onOrdersPage);
      $('scan').disabled = st.scanning;
      $('stop').classList.toggle('hidden', !st.scanning);
      $('progress').textContent = st.progress || '';
    }
    await refreshStats();
    return st;
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const st = await refreshStatus();
      if (st && !st.scanning) clearInterval(pollTimer);
    }, 1000);
  }

  // ---------- wire up ----------

  $('range').addEventListener('change', () => {
    $('custom').classList.toggle('hidden', $('range').value !== 'custom');
    refreshStats();
  });
  $('from').addEventListener('change', refreshStats);
  $('to').addEventListener('change', refreshStats);

  $('openRetailers').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/retailers.html') });
    window.close();
  });

  $('openOrders').addEventListener('click', async () => {
    const url = retailer.orderHistoryUrls[0];
    if (tabId() !== null) await chrome.tabs.update(tabId(), { url });
    else chrome.tabs.create({ url });
    window.close();
  });

  $('scan').addEventListener('click', async () => {
    const { from, to } = range();
    $('scan').disabled = true;
    $('progress').textContent = 'Starting…';
    await send({ type: 'scan', from, to, details: $('details').checked });
    startPolling();
  });

  $('stop').addEventListener('click', () => send({ type: 'stop' }));

  $('debug').addEventListener('click', async () => {
    const msg = $('debugMsg');
    msg.classList.remove('hidden');
    const report = await send({ type: 'debug' });
    if (!report) {
      msg.textContent = `Open your ${retailer.name} order history tab first.`;
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 1));
      msg.textContent = 'Copied. It contains page structure and field names only — no order details.';
    } catch (_) {
      msg.textContent = 'Could not access the clipboard.';
    }
  });

  $('csv').addEventListener('click', async () => U.exportCSV(await U.ordersFor(retailer.id, range()), retailer.id, range()));
  $('xlsx').addEventListener('click', async () => U.exportXLSX(await U.ordersFor(retailer.id, range()), retailer.id, range()));

  $('clear').addEventListener('click', async () => {
    if (!confirm(`Delete all saved ${retailer.name} orders from this browser?`)) return;
    await U.clearRetailer(retailer.id);
    await send({ type: 'cleared' });
    refreshStats();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (retailer && changes[R.keys(retailer.id).orders]) refreshStats();
  });

  // Pick the retailer: ?retailer= (from the Retailers page) → active tab's site → last used → first.
  (async () => {
    await U.ready();
    const params = new URLSearchParams(location.search);
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
    const forced = Number(params.get('tabId')); // opened as a page (tests / pinned tab)
    if (forced) tab = await chrome.tabs.get(forced);
    tabRetailer = tab ? R.forUrl(tab.url || '') : null;
    const { lastRetailer } = await chrome.storage.local.get('lastRetailer');
    const pick = R.byId(params.get('retailer')) || tabRetailer || R.byId(lastRetailer) || R.SUPPORTED[0];
    selectRetailer(pick);
  })();
})();
