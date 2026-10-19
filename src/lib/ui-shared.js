/*
 * Helpers shared by the popup and the Retailers page: reading saved orders per retailer,
 * date ranges, exports and downloads. Needs SCX_RETAILERS and SCXExport (and XLSX for Excel).
 */
(function (root) {
  'use strict';
  const R = root.SCX_RETAILERS;
  const E = root.SCXExport;

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtMoney = (n) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  /** Range select value ("30", "90", "ytd", "lastyear", "all", "custom") → {from, to}. */
  function rangeFor(value, customFrom, customTo) {
    const now = new Date();
    if (value === 'all') return { from: '', to: '' };
    if (value === 'custom') return { from: customFrom || '', to: customTo || '' };
    if (value === 'ytd') return { from: `${now.getFullYear()}-01-01`, to: '' };
    if (value === 'lastyear') return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` };
    const d = new Date(now);
    d.setDate(d.getDate() - Number(value));
    return { from: iso(d), to: '' };
  }

  async function ready() {
    await R.migrate(chrome.storage.local);
  }

  /** All saved orders for a retailer, as a map keyed by order id. */
  async function savedMap(retailerId) {
    await ready();
    const k = R.keys(retailerId);
    const got = await chrome.storage.local.get([k.orders, k.updatedAt]);
    return { orders: got[k.orders] || {}, updatedAt: got[k.updatedAt] || 0 };
  }

  /** Orders in range, newest first, tagged with the retailer's display name. */
  async function ordersFor(retailerId, range) {
    const r = R.byId(retailerId);
    const { orders } = await savedMap(retailerId);
    const sel = E.selectOrders(orders, range.from, range.to).map((o) => ({ ...o, retailer: r.name }));
    sel.undatedExcluded = range.from || range.to ? Object.values(orders).filter((o) => !o.orderDate).length : 0;
    return sel;
  }

  async function clearRetailer(retailerId) {
    const k = R.keys(retailerId);
    await chrome.storage.local.remove([k.orders, k.updatedAt, k.job, k.template]);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, () => setTimeout(() => URL.revokeObjectURL(url), 30000));
  }

  function stamp(prefix, range) {
    return `${prefix}_${range.from || 'all'}_to_${range.to || iso(new Date())}`;
  }

  function exportXLSX(orders, prefix, range) {
    const buf = E.buildXLSX(orders, root.XLSX);
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${stamp(prefix, range)}.xlsx`);
  }

  function exportCSV(orders, prefix, range) {
    const { orders: o, items } = E.buildCSVs(orders);
    download(new Blob([o], { type: 'text/csv' }), `${stamp(prefix, range)}_orders.csv`);
    setTimeout(() => download(new Blob([items], { type: 'text/csv' }), `${stamp(prefix, range)}_items.csv`), 400);
  }

  /** Small brand tile (monogram on the retailer's colour). Text only — no logos. */
  function monogram(r, size = 32) {
    const el = document.createElement('span');
    el.className = 'mono';
    el.textContent = r.short;
    el.style.cssText = `--mono:${r.color};width:${size}px;height:${size}px;font-size:${Math.round(size * (r.short.length > 1 ? 0.36 : 0.46))}px`;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  root.SCXUI = { iso, fmtMoney, rangeFor, savedMap, ordersFor, clearRetailer, exportXLSX, exportCSV, monogram, ready };
})(typeof globalThis !== 'undefined' ? globalThis : this);
