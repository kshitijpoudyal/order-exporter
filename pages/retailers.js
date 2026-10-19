(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = globalThis.SCX_RETAILERS;
  const E = globalThis.SCXExport;
  const U = globalThis.SCXUI;

  const range = () => U.rangeFor($('range').value);
  const ago = (ts) => {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    return new Date(ts).toLocaleDateString();
  };

  async function renderSupported() {
    const grid = $('supported');
    grid.textContent = '';
    const tpl = $('card-tpl');
    let allOrders = 0;
    let allTotal = 0;
    let stores = 0;
    for (const r of R.SUPPORTED) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.retailer = r.id;
      node.style.setProperty('--brand', r.color);
      node.querySelector('.mono-slot').replaceWith(U.monogram(r, 40));
      node.querySelector('.rname').textContent = r.name;
      node.querySelector('.rtypes').textContent = r.orderTypes;

      const orders = await U.ordersFor(r.id, range());
      const { updatedAt, orders: all } = await U.savedMap(r.id);
      const s = E.summarize(orders);
      node.querySelector('.v-orders').textContent = s.orders;
      node.querySelector('.v-items').textContent = s.items;
      node.querySelector('.v-total').textContent = U.fmtMoney(s.total);
      node.querySelector('.v-tax').textContent = U.fmtMoney(s.tax);
      const savedCount = Object.keys(all).length;
      node.querySelector('.rmeta').textContent = savedCount
        ? `${s.first && s.last ? `${s.first} → ${s.last} · ` : ''}${savedCount} saved · updated ${ago(updatedAt)}`
        : 'No orders saved yet. Open your order history and scan from the extension.';
      const warn = node.querySelector('.rwarn');
      if (s.missingDetails) {
        warn.textContent = `${s.missingDetails} order${s.missingDetails > 1 ? 's' : ''} without item or tax details — re-scan with details on.`;
        warn.classList.remove('hidden');
      }
      node.querySelector('.a-xlsx').disabled = node.querySelector('.a-csv').disabled = !s.orders;
      node.querySelector('.a-clear').classList.toggle('hidden', !savedCount);

      node.querySelector('.a-open').addEventListener('click', () => chrome.tabs.create({ url: r.orderHistoryUrls[0] }));
      node.querySelector('.a-xlsx').addEventListener('click', async () => U.exportXLSX(await U.ordersFor(r.id, range()), r.id, range()));
      node.querySelector('.a-csv').addEventListener('click', async () => U.exportCSV(await U.ordersFor(r.id, range()), r.id, range()));
      node.querySelector('.a-clear').addEventListener('click', async () => {
        if (!confirm(`Delete all saved ${r.name} orders from this browser?`)) return;
        await U.clearRetailer(r.id);
        render();
      });

      grid.appendChild(node);
      allOrders += s.orders;
      allTotal += s.total;
      if (savedCount) stores++;
    }
    $('totals').innerHTML = '';
    const t = (label, value) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = value;
      const sp = document.createElement('span');
      sp.textContent = label;
      d.append(b, sp);
      $('totals').appendChild(d);
    };
    t('orders', allOrders.toLocaleString());
    t('spent', U.fmtMoney(allTotal));
    t(`of ${R.SUPPORTED.length} stores with data`, String(stores));
    $('exportAll').disabled = !allOrders;
  }

  function renderSoon() {
    const grid = $('soon');
    grid.textContent = '';
    for (const r of R.COMING_SOON) {
      const a = document.createElement('article');
      a.className = 'rcard muted-card';
      const head = document.createElement('div');
      head.className = 'rhead';
      const name = document.createElement('h3');
      name.className = 'rname';
      name.textContent = r.name;
      const grow = document.createElement('div');
      grow.className = 'grow';
      grow.appendChild(name);
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'Coming soon';
      head.append(U.monogram(r, 32), grow, pill);
      a.appendChild(head);
      grid.appendChild(a);
    }
  }

  async function exportAll() {
    const rg = range();
    const all = [];
    for (const r of R.SUPPORTED) all.push(...(await U.ordersFor(r.id, rg)));
    all.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
    U.exportXLSX(all, 'all-retailers', rg);
  }

  function render() {
    return renderSupported();
  }

  $('range').addEventListener('change', render);
  $('exportAll').addEventListener('click', exportAll);
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => k.startsWith('orders:'))) render();
  });

  renderSoon();
  render();
})();
