/*
 * Isolated-world content script for supported retailers (see src/retailers.js).
 *
 * Data sources, in order of reliability:
 *   1. JSON responses captured by inject.js while the order pages load.
 *   2. JSON embedded in the HTML (__NEXT_DATA__ and other <script type="application/json">).
 *   3. Order links on the list page (to learn each order's detail URL).
 *   4. Detail pages fetched (or, failing that, loaded in a hidden iframe) to fill in
 *      items, tax and payment info that the list view doesn't show.
 *
 * A running scan is saved as "scanJob:<retailer>" in chrome.storage.local, so it survives
 * the page navigating to the next page of orders and resumes on the new page.
 * Orders are stored under "orders:<retailer>" (keyed by order id).
 */
(function () {
  'use strict';
  const CFG = globalThis.SCX_CONFIG;
  if (!CFG) return; // not a supported retailer
  const SCX = globalThis.SCX;
  const K = globalThis.SCX_RETAILERS.keys(CFG.id);
  const IS_TOP = window === window.top;
  const JOB_MAX_AGE_MS = 60 * 60 * 1000;

  const state = {
    orders: {},
    links: {}, // orderId -> detail URL seen on the page
    scanning: false,
    stopRequested: false,
    progress: '',
    lastCaptureAt: 0,
    job: null, // active scan job (persisted)
    pageSeen: new Set(), // order ids captured during this page view
    pageRef: '', // newest-possible date for the first card on this page (year inference)
    pageLast: '', // date of the last dated card on this page
    pendingDetail: null, // { id } while a detail iframe is open
    detailTemplate: '', // learned detail URL with {orderId}
    detailNote: '',
    diag: { captures: [], embedded: [], pages: [] },
  };

  // ---------- storage ----------

  let saveTimer = null;
  function scheduleSave() {
    if (!IS_TOP) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    const got = await chrome.storage.local.get([K.orders, 'orders']);
    const stored = got[K.orders] || {};
    // v0.4 kept Sam's Club orders under "orders"; if that key is still there (migration
    // running in parallel), fold it in so nothing is lost.
    if (CFG.id === 'samsclub' && got.orders) for (const [id, o] of Object.entries(got.orders)) if (!stored[id]) stored[id] = o;
    SCX.mergeInto(stored, Object.values(state.orders));
    state.orders = stored;
    const data = { [K.orders]: stored, [K.updatedAt]: Date.now() };
    if (state.job) data[K.job] = state.job;
    await chrome.storage.local.set(data);
  }
  let migrated = null;
  async function load() {
    if (!migrated) migrated = globalThis.SCX_RETAILERS.migrate(chrome.storage.local);
    await migrated;
    const orders = (await chrome.storage.local.get(K.orders))[K.orders] || {};
    SCX.mergeInto(orders, Object.values(state.orders)); // keep anything captured before load finished
    state.orders = orders;
  }

  // Nothing is read or saved until the user has agreed (see pages/welcome.html).
  let consented = false;
  let consentKnown = false;
  const heldUntilConsentKnown = [];
  const CONSENT_KEY = 'consent:v1';
  const consentReady = chrome.storage.local.get(CONSENT_KEY).then((r) => {
    consented = !!r[CONSENT_KEY];
    consentKnown = true;
    // Anything read while the check was in flight is kept only if the user has agreed.
    const held = heldUntilConsentKnown.splice(0);
    if (consented) held.forEach((o) => ingest(o));
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch[CONSENT_KEY]) consented = !!ch[CONSENT_KEY].newValue;
  });

  function ingest(orders) {
    if (!orders || !orders.length) return 0;
    if (!consentKnown) {
      heldUntilConsentKnown.push(orders);
      return 0;
    }
    if (!consented) return 0;
    for (const o of orders) {
      if (!o.orderUrl && state.links[o.orderId]) o.orderUrl = state.links[o.orderId];
    }
    if (!IS_TOP) {
      window.top.postMessage({ __scx: 'frameOrders', orders, href: location.href }, location.origin);
      return orders.length;
    }
    const added = SCX.mergeInto(state.orders, orders);
    for (const o of orders) if (o.orderId) state.pageSeen.add(o.orderId);
    if (state.job) for (const o of orders) if (o.orderId && !state.job.seen.includes(o.orderId)) state.job.seen.push(o.orderId);
    state.lastCaptureAt = Date.now();
    scheduleSave();
    return added;
  }

  // ---------- diagnostics (structure only, never values) ----------

  const pathOnly = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.pathname.replace(/\d{5,}/g, '#') + (x.search ? '?' + [...x.searchParams.keys()].join('&') : '');
    } catch (_) {
      return '?';
    }
  };
  function noteCapture(url, size, matched, json, found) {
    if (state.diag.captures.length >= 60) state.diag.captures.shift();
    state.diag.captures.push({ path: pathOnly(url), size, matched, ordersFound: found, shape: json ? SCX.shapeOf(json, 120) : [] });
  }

  /**
   * While one order's details are being opened, the detail data may label it differently
   * (display id vs TC number). If exactly one detailed order came back, it's that order.
   */
  function remapPending(orders) {
    const p = state.pendingDetail;
    if (!p || orders.some((o) => o.orderId === p.id)) return orders;
    const real = orders.filter((o) => (o.items && o.items.length) || o.grandTotal !== null);
    if (real.length !== 1) return orders;
    return [{ ...real[0], orderId: p.id, altOrderId: real[0].orderId }];
  }

  // ---------- source 1: network captures ----------

  window.postMessage(
    {
      __scx: 'config',
      urlPatterns: CFG.captureUrlPatterns.map((r) => ({ source: r.source, flags: r.flags })),
      bodyPattern: { source: CFG.captureBodyPattern.source, flags: CFG.captureBodyPattern.flags },
      maxBodyChars: CFG.maxBodyChars,
      forwardBodies: CFG.captureJson !== false,
    },
    location.origin
  );

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.__scx === 'capture' && e.source === window) {
      try {
        const json = JSON.parse(e.data.body);
        const found = SCX.extractOrders(json, e.data.url);
        noteCapture(e.data.url, e.data.body.length, true, json, found.length);
        if (CFG.captureJson !== false) ingest(IS_TOP ? remapPending(found) : found);
      } catch (_) {}
    } else if (e.data.__scx === 'captureSkipped' && e.source === window) {
      noteCapture(e.data.url, e.data.size, false, null, 0);
    } else if (e.data.__scx === 'frameOrders' && IS_TOP && Array.isArray(e.data.orders)) {
      ingest(remapPending(e.data.orders));
    }
  });

  // ---------- source 2 + 3: embedded JSON and links ----------

  function harvestDocument(doc, sourceUrl) {
    let n = 0;
    if (CFG.captureJson === false) return 0;
    doc.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]').forEach((s) => {
      const t = s.textContent;
      if (!t || t.length > CFG.maxBodyChars || !CFG.captureBodyPattern.test(t)) return;
      try {
        const json = JSON.parse(t);
        const found = SCX.extractOrders(json, sourceUrl);
        if (doc === document && state.diag.embedded.length < 20 && !state.diag.embedded.some((x) => x.size === t.length)) {
          state.diag.embedded.push({ tag: s.id || s.type, size: t.length, ordersFound: found.length, shape: SCX.shapeOf(json, 150) });
        }
        n += ingest(found);
      } catch (_) {}
    });
    return n;
  }

  function harvestLinks() {
    const found = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      for (const re of CFG.orderLinkPatterns) {
        const m = a.getAttribute('href').match(re);
        if (m) {
          const id = m[1];
          const url = new URL(a.getAttribute('href'), location.href).href;
          state.links[id] = url;
          if (state.orders[id] && !state.orders[id].orderUrl) state.orders[id].orderUrl = url;
          found.push({ id, url, card: a.closest('li, article, section, [class*="order" i], [data-testid*="order" i]') || a });
          break;
        }
      }
    });
    return found;
  }

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** Order cards on the list page: elements whose data-testid matches the retailer's pattern. */
  function findCards() {
    if (CFG.cardSelector) return [...document.querySelectorAll(CFG.cardSelector)];
    if (!CFG.orderCardTestId) return [];
    return [...document.querySelectorAll('[data-testid^="order"]')].filter((el) => CFG.orderCardTestId.test(el.getAttribute('data-testid')));
  }

  function normalizeType(t) {
    t = (t || '').replace(/_/g, ' ').trim();
    if (/scan/i.test(t)) return 'Scan & Go';
    if (/fuel|gas/i.test(t)) return 'Fuel';
    if (/club/i.test(t)) return 'In-Club';
    if (/store/i.test(t)) return 'In-Store';
    if (/pickup/i.test(t)) return 'Pickup';
    if (/deliver/i.test(t)) return 'Delivery';
    if (/ship|online/i.test(t)) return 'Shipping';
    return t;
  }

  /**
   * Walmart-platform purchase history ("Glass"): cards have a caption whose id carries the
   * order id (caption-<id>-<Type>), and/or a "See details" button (Sam's Club). Dates show
   * as "Purchased on Tue, Dec 2" (no year — inferred from card order, newest first) or
   * "Oct 11, 2026 purchase". Online Walmart orders show only delivery status; their order
   * date comes from the details page.
   */
  function harvestGlassCards() {
    if (CFG.scanStrategy === 'costco') return harvestCostcoCards();
    const cards = findCards();
    if (!cards.length) return 0;
    let ref = state.pageRef || today();
    const out = [];
    cards.forEach((card) => {
      const btn = card.querySelector(CFG.orderDetailButtonSelector);
      let id = btn ? btn.getAttribute('data-automation-id').slice(CFG.orderDetailButtonIdPrefix.length) : '';
      if (!id && btn) id = ((btn.getAttribute('aria-label') || '').match(/(\d{6,})/) || [])[1] || '';
      const caption = card.querySelector('[id^="caption-"]');
      if (!id && caption) id = (caption.id.match(/^caption-([A-Za-z0-9]{6,64})-/) || [])[1] || '';
      const txt = card.innerText || card.textContent || '';
      const tc = (txt.match(/\bTC#?\s+([\d -]{10,40}\d)/) || [])[1];
      if (!id && tc) id = tc.replace(/[\s-]/g, '');
      if (!id) return;

      const typeText = (caption ? caption.textContent : '').trim();
      const headings = [...card.querySelectorAll('h2, h3, h4')].map((h) => h.textContent.trim());
      let phrase = '';
      for (const h of headings) {
        const m = h.match(/\bon\s+(.+)$/i) || h.match(/^(.+?\d{4})\s+(?:purchase|order)\b/i);
        if (m && !/^(delivered|arriv|shipped|picked)/i.test(h)) {
          phrase = m[1];
          break;
        }
      }
      if (!phrase) phrase = (txt.match(/(?:purchased|ordered|placed)\s+on\s+([^\n|]+)/i) || [])[1] || '';
      const parsed = phrase ? SCX.parseLooseDate(phrase.trim(), ref) : null;
      if (parsed) {
        ref = parsed.date;
        state.pageLast = parsed.date;
      }
      const roleBtn = card.querySelector('[role="button"][aria-label]');
      const countMatch = txt.match(/(\d+)\s+items?\b/i) || (roleBtn && roleBtn.getAttribute('aria-label').match(/(\d+)\s+items?\b/i));
      const totalMatch = txt.match(/Order total\s*\$\s?([\d,]+\.\d{2})/i);
      const statusLine = headings.find((h) => /deliver|arriv|shipped|cancel|refund|return|ready|picked up|processing/i.test(h)) ||
        txt.split('\n').map((l) => l.trim()).find((l) =>
          /refund|cancel|return|deliver(ed|ing)|shipped|processing|ready|picked up|arriv/i.test(l) && !/\bon\s/i.test(l) && !/^start a return/i.test(l) && l.length < 40);
      const preview = [...card.querySelectorAll('[data-testid="collapsedItemList"] img[alt]')].map((i) => i.alt.trim()).filter(Boolean);
      const orderType = normalizeType(typeText);
      const o = { orderId: id, orderType };

      out.push({
        orderId: id,
        tcNumber: tc ? tc.trim() : '',
        orderDate: parsed ? parsed.date : '',
        _dateInferred: parsed ? parsed.inferred : false,
        orderType,
        status: statusLine || '',
        orderUrl: state.detailTemplate ? state.detailTemplate.replace('{orderId}', id) : CFG.detailUrlFor ? CFG.detailUrlFor(o) : '',
        invoiceUrl: '',
        subTotal: null, tax: null, shipping: null, savings: null, coupon: null, giftCard: null,
        totalBeforeTax: null, grandTotal: totalMatch ? SCX.money(totalMatch[1]) : null, refundTotal: null, paymentMethods: '', currency: 'USD',
        itemCount: countMatch ? Number(countMatch[1]) : null,
        shipmentCount: card.querySelectorAll('[data-testid^="orderGroup-"]').length || null, clubName: '',
        itemPreview: preview,
        items: [],
        _source: 'glass-dom',
      });
    });
    return ingest(out);
  }

  // ---------- order details page (item tiles) ----------

  /** "$ 10 98" split across spans, or plain "$10.98" / "-$2.00". */
  function priceFromEl(el) {
    if (!el) return null;
    const t = (el.textContent || '').replace(/\s+/g, '');
    const neg = /^[-−(]/.test(t) || /-\$/.test(t);
    if (/\d\.\d{2}/.test(t)) {
      const v = SCX.money((t.match(/\d[\d,]*\.\d{2}/) || [])[0]);
      return v === null ? null : neg ? -v : v;
    }
    const nums = [...el.querySelectorAll('span')].filter((sp) => !sp.children.length).map((sp) => sp.textContent.trim()).filter((x) => /^\d+$/.test(x));
    if (nums.length >= 2) {
      const cents = nums.pop();
      const v = Number(nums.join('') + '.' + cents);
      return neg ? -v : v;
    }
    return SCX.money(t);
  }

  function orderIdFromUrl(url) {
    for (const re of CFG.orderLinkPatterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return '';
  }

  /** Expand collapsed item sections so every tile is in the DOM. */
  function expandItems() {
    document.querySelectorAll(CFG.itemsToggleSelector).forEach((b) => {
      if (b.getAttribute('aria-expanded') === 'false') b.click();
    });
  }

  /**
   * Item tiles on the order details page carry the prices the background data lacks:
   * name, unit price ("$10.98" or "$1.38/lb"), "Qty N" and the line price.
   */
  function harvestDetailPage() {
    const tiles = document.querySelectorAll(CFG.itemTileSelector);
    if (!tiles.length) return 0;
    const id = orderIdFromUrl(location.href) || (state.pendingDetail && state.pendingDetail.id) || '';
    if (!id) return 0;
    const items = [...tiles].map((tile) => {
      const name = ((tile.querySelector('[data-testid="productName"]') || {}).textContent || '').trim();
      const desc = ((tile.querySelector('[data-testid="productDescription"]') || {}).textContent || '').trim();
      const txt = (tile.innerText || tile.textContent || '').replace(/\s+/g, ' ');
      const wt = txt.match(/\bWt\.?\s*([\d.]+)\s*(lb|lbs|oz|kg|g)\b/i);
      const qty = wt ? Number(wt[1]) : Number((txt.match(/\bQty\s*([\d.]+)/i) || [])[1]) || 1;
      const unitMatch = desc.match(/\$\s?([\d,]+\.\d{2})(?:\s*\/\s*([a-z]+))?/i);
      const lineTotal = priceFromEl(tile.querySelector('[data-testid="line-price"]'));
      const img = tile.querySelector('img[data-testid="productTileImage"], img');
      let imageUrl = img ? img.getAttribute('src') || (img.getAttribute('srcset') || '').split(/\s/)[0] : '';
      if (imageUrl && imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
      const link = tile.querySelector('a[href]:not([href=""])');
      const href = link ? link.getAttribute('href') : '';
      return {
        name,
        itemNumber: (CFG.itemNumberFromUrl && (href.match(CFG.itemNumberFromUrl) || [])[1]) || '',
        quantity: qty,
        unitPrice: unitMatch ? SCX.money(unitMatch[1]) : lineTotal !== null ? Math.round((lineTotal / qty) * 100) / 100 : null,
        priceUnit: unitMatch && unitMatch[2] ? unitMatch[2] : wt ? wt[2].toLowerCase().replace(/^lbs$/, 'lb') : '',
        itemTotal: lineTotal,
        savings: null,
        category: '',
        status: '',
        productUrl: href ? new URL(href, location.href).href : '',
        imageUrl: /^https?:/.test(imageUrl) ? imageUrl : '',
      };
    }).filter((i) => i.name);
    if (!items.length) return 0;
    const summary = parseDetailSummary();
    const order = { orderId: id, items, itemCount: items.filter((i) => !i.priceUnit).reduce((n, i) => n + (i.quantity || 1), 0) + items.filter((i) => i.priceUnit).length, _source: 'detail-dom' };
    for (const [k, v] of Object.entries(summary)) if (v !== null && v !== '' && v !== undefined) order[k] = v;
    return ingest([order]);
  }

  /**
   * Order summary as shown on the details page: date, store, payment, subtotal, fees,
   * savings, tax and total. Reads the page's visible text line by line, because the
   * markup differs between Walmart and Sam's Club but the labels don't.
   */
  function parseDetailSummary() {
    const main = document.querySelector(CFG.detailMainSelector) || document.body;
    const lines = (main.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const moneyAfter = (labelRe) => {
      for (let i = 0; i < lines.length; i++) {
        if (!labelRe.test(lines[i])) continue;
        const inline = lines[i].match(/(-?\$\s?[\d,]+\.\d{2})\s*$/);
        if (inline) return SCX.money(inline[1]);
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (/^free$/i.test(lines[j])) return 0;
          const m = lines[j].match(/^(-?\$\s?[\d,]+\.\d{2})$/);
          if (m) return SCX.money(m[1]);
          if (!labelRe.test(lines[j]) && /[a-z]{3}/i.test(lines[j])) break;
        }
      }
      return null;
    };
    const after = (labelRe) => {
      const i = lines.findIndex((l) => labelRe.test(l));
      return i >= 0 && lines[i + 1] ? lines[i + 1] : '';
    };
    const dateLine = lines.find((l) => /^(?:\w{3,9}\.? \d{1,2}, \d{4}) (?:purchase|order)$/i.test(l) || /^(?:order date|ordered on|placed on|purchased on)\b/i.test(l)) || '';
    const date = dateLine ? SCX.parseLooseDate(dateLine.replace(/\s+(purchase|order)$/i, '').replace(/^(order date:?|ordered on|placed on|purchased on)\s*/i, '')) : null;
    const payments = [...new Set(lines.filter((l) => /\bending in \d{4}\b/i.test(l)).map((l) => l.replace(/\s*ending in\s*(\d{4}).*/i, ' ••$1')))];
    const savings = moneyAfter(/^(savings|total savings|discounts?|instant savings)$/i);
    const tc = (lines.find((l) => /^TC#?\s*[\d -]{10,}/.test(l)) || '').replace(/^TC#?\s*/, '');
    return {
      orderDate: date && !date.inferred ? date.date : undefined,
      _dateInferred: date && !date.inferred ? false : undefined,
      clubName: after(/^store location$/i),
      paymentMethods: payments.join('; '),
      tcNumber: tc,
      subTotal: moneyAfter(/^subtotal\b/i),
      shipping: moneyAfter(/^(delivery|shipping|delivery fee|shipping fee|shipping & handling)$/i),
      savings: savings !== null ? Math.abs(savings) : null,
      tax: moneyAfter(/^(taxes|tax|estimated tax|sales tax)$/i),
      grandTotal: moneyAfter(/^(total|order total|grand total)$/i),
    };
  }

  /** Last-resort DOM parse for orders that never showed up in JSON. */
  function harvestCards(links) {
    const out = [];
    for (const { id, url, card } of links) {
      if (state.orders[id]) continue;
      const txt = (card.innerText || '').replace(/\s+/g, ' ');
      const dateMatch = txt.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
      const totalMatch = txt.match(/(?:total|paid)[^$]{0,20}\$\s?([\d,]+\.\d{2})/i) || txt.match(/\$\s?([\d,]+\.\d{2})/);
      out.push({
        orderId: id,
        orderDate: dateMatch ? SCX.toDate(dateMatch[0]) : '',
        orderType: /in.?club|receipt/i.test(txt) ? 'In-Club' : /pickup/i.test(txt) ? 'Pickup' : /deliver/i.test(txt) ? 'Delivery' : '',
        status: '',
        orderUrl: url,
        invoiceUrl: '',
        subTotal: null, tax: null, shipping: null, savings: null, coupon: null, giftCard: null,
        totalBeforeTax: null,
        grandTotal: totalMatch ? SCX.money(totalMatch[1]) : null,
        refundTotal: null, paymentMethods: '', currency: 'USD', itemCount: null, shipmentCount: null, clubName: '',
        items: [],
        _source: 'dom',
      });
    }
    return ingest(out);
  }


  // ---------- Costco ----------
  //
  // Orders & Purchases is a single-page app with tabs (Online / In-Warehouse). The
  // warehouse tab lists receipt cards for one 3-month period at a time, chosen in the
  // "Showing" dropdown; "View Receipt" opens the full receipt in a popup on the same page.

  const COSTCO_TYPE = (t) => (/gas|fuel/i.test(t) ? 'Fuel' : /warehouse/i.test(t) ? 'In-Warehouse' : /online/i.test(t) ? 'Online' : t);

  function costcoCardData(card) {
    const id = card.id.slice(CFG.cardIdPrefix.length);
    const lines = (card.innerText || card.textContent || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const dateLine = lines.find((l) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(l)) || '';
    const di = lines.indexOf(dateLine);
    const totalIdx = lines.findIndex((l) => /^total$/i.test(l));
    const total = totalIdx >= 0 ? SCX.money((lines.slice(totalIdx + 1).find((l) => /\$?[\d,]+\.\d{2}/.test(l)) || '').replace(/[^\d.,-]/g, '')) : null;
    return {
      orderId: id,
      orderDate: SCX.toDate((dateLine.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [])[0]),
      orderTime: (dateLine.match(/\d{1,2}:\d{2}\s*[ap]m/i) || [])[0] || '',
      orderType: COSTCO_TYPE(lines[0] || ''),
      clubName: di >= 0 && lines[di + 1] && !/^total$/i.test(lines[di + 1]) ? lines[di + 1] : '',
      grandTotal: total,
    };
  }

  function harvestCostcoCards() {
    const out = findCards().map((card) => {
      const d = costcoCardData(card);
      return {
        ...d,
        status: '', orderUrl: '', invoiceUrl: '',
        subTotal: null, tax: null, shipping: null, savings: null, coupon: null, giftCard: null,
        totalBeforeTax: null, refundTotal: null, paymentMethods: '', currency: 'USD',
        itemCount: null, shipmentCount: null, items: [], _source: 'costco-card',
      };
    }).filter((o) => o.orderId);
    return ingest(out);
  }

  const cellText = (td) => (td.textContent || '').replace(/\s+/g, ' ').trim();

  /**
   * Parse the receipt popup's table:
   *   [E] 647465  AVOCADOS        5.29 2      item: tax flag, item #, name, price + tax code
   *   2 @ 44.99                                quantity line for the next item
   *   390140  /1218891  5.80-                  instant saving applied to item 1218891
   *   SUBTOTAL / TAX / Total / TOTAL TAX / INSTANT SAVINGS / card / item count
   */
  function parseCostcoReceipt(dialog, id) {
    const rows = [...dialog.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td, th')].map(cellText));
    const items = [];
    const savingsFor = {};
    let pending = null; // { qty, unit } from an "N @ price" line
    const sum = {};
    let last4 = '';
    let tender = '';
    for (const c of rows) {
      const joined = c.join(' ').trim();
      if (!joined) continue;
      const qtyLine = c.length <= 2 && joined.match(/^([\d.]+)\s*(?:[a-z]+\s*)?@\s*\$?([\d,]+\.\d{2,3})$/i);
      if (qtyLine) {
        pending = { qty: Number(qtyLine[1]), unit: Number(qtyLine[2].replace(/,/g, '')) };
        continue;
      }
      if (c.length >= 4 && /^\d{1,10}$/.test(c[1])) {
        const pm = c[3].match(/^(-?[\d,]+\.\d{2})\s*(-)?\s*(\S*)$/);
        if (!pm) continue;
        let price = Number(pm[1].replace(/,/g, ''));
        if (pm[2]) price = -price;
        const name = c[2];
        const ref = name.match(/^\/\s*(\d+)/);
        if (ref && price < 0) {
          savingsFor[ref[1]] = (savingsFor[ref[1]] || 0) + -price;
          continue;
        }
        const qty = pending ? pending.qty : 1;
        items.push({
          name,
          itemNumber: c[1],
          quantity: qty,
          unitPrice: pending ? pending.unit : Math.round((price / qty) * 100) / 100,
          priceUnit: '',
          itemTotal: price,
          savings: null,
          category: '',
          status: price < 0 ? 'Return/credit' : '',
          taxCode: [c[0] === 'E' ? 'E' : '', pm[3] || ''].filter(Boolean).join(' '),
          productUrl: '',
          imageUrl: '',
        });
        pending = null;
        continue;
      }
      const label = c.find((x) => /[a-z]/i.test(x) && !/^\*+$/.test(x)) || '';
      const amount = [...c].reverse().find((x) => /^-?\$?[\d,]+\.\d{2}-?$/.test(x));
      const val = amount ? (/-$/.test(amount) ? -1 : 1) * Number(amount.replace(/[$,-]/g, '')) : null;
      if (/^subtotal$/i.test(label)) sum.subTotal = val;
      else if (/^total tax$/i.test(label)) sum.tax = val;
      else if (/^tax$/i.test(label) && sum.tax === undefined) sum.tax = val;
      else if (/^total$/i.test(label)) sum.grandTotal = val;
      else if (/^instant savings$/i.test(label)) sum.savings = val;
      const cnt = joined.match(/TOTAL NUMBER OF ITEMS SOLD\s*=\s*(\d+)/i);
      if (cnt) sum.itemCount = Number(cnt[1]);
      const card = joined.match(/^X{4,}(\d{4})\b/);
      if (card) last4 = card[1];
      if (c.length >= 2 && /visa|mastercard|amex|discover|debit|credit|cash|citi|card|ebt/i.test(c[0]) && amount && !/change/i.test(c[0])) tender = tender || c[0];
    }
    for (const it of items) if (savingsFor[it.itemNumber]) it.savings = Math.round(savingsFor[it.itemNumber] * 100) / 100;
    const head = dialog.querySelector('[data-private="true"], [data-bi-private="true"]');
    const headLines = head ? (head.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    const date = dialog.querySelector('.date');
    const order = {
      orderId: id,
      items,
      paymentMethods: tender || last4 ? [tender || 'Card', last4 ? '••' + last4 : ''].filter(Boolean).join(' ') : '',
      clubName: headLines[0] && !/receipt/i.test(headLines[0]) ? headLines[0] : '',
      _source: 'detail-dom',
    };
    if (date) order.orderDate = SCX.toDate(date.textContent.trim());
    for (const [k, v] of Object.entries(sum)) if (v !== null && v !== undefined) order[k] = k === 'savings' ? Math.abs(v) : v;
    if (order.grandTotal != null && order.tax != null) order.totalBeforeTax = Math.round((order.grandTotal - order.tax) * 100) / 100;
    return order;
  }

  const findDialog = () => [...document.querySelectorAll(CFG.receiptDialogSelector)].find((d) => d.querySelector('table'));

  async function closeDialog(dialog) {
    const btn = dialog.querySelector('button[aria-label="Close" i]') || (dialog.parentElement && dialog.parentElement.querySelector('button[aria-label="Close" i]'));
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !findDialog(), 4000);
  }

  /** A receipt the user opened themselves: match it to its card by the barcode it shows. */
  function harvestOpenReceipt() {
    const dialog = findDialog();
    if (!dialog) return;
    const text = dialog.textContent || '';
    const card = findCards().find((c) => text.includes(c.id.slice(CFG.cardIdPrefix.length)));
    if (card) ingest([parseCostcoReceipt(dialog, card.id.slice(CFG.cardIdPrefix.length))]);
  }

  /** Open each receipt on the current period's list, read it, close it. */
  async function readCostcoReceipts() {
    const { from, to } = state.job;
    const cards = findCards();
    let i = 0;
    for (const card of cards) {
      if (state.stopRequested) return;
      i++;
      const d = costcoCardData(card);
      const cur = state.orders[d.orderId];
      if (cur && !needsDetail(cur)) continue;
      if ((from && d.orderDate && d.orderDate < from) || (to && d.orderDate && d.orderDate > to)) continue;
      const btn = card.querySelector(CFG.viewReceiptSelector) || card.querySelector('button');
      if (!btn) continue;
      state.progress = `Reading receipts (${state.job.periodLabel || 'this period'}) ${i}/${cards.length}…`;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      const ok = await waitFor(() => {
        const dlg = findDialog();
        return dlg && dlg.querySelectorAll('tr').length > 3;
      }, 10000);
      const dialog = findDialog();
      if (ok && dialog) {
        await sleep(300);
        ingest([parseCostcoReceipt(dialog, d.orderId)]);
        if (state.orders[d.orderId]) state.orders[d.orderId]._detailVersion = DETAIL_VERSION;
        await closeDialog(dialog);
      }
      await sleep(CFG.detailFetchDelayMs);
    }
  }

  /** "Last 3 Months", "2026 May - July", "2026 November - January" (= Nov 2025 – Jan 2026). */
  function periodRange(label) {
    const M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const t = label.trim();
    if (/last\s+(\d+)\s+months?/i.test(t)) {
      const n = Number(t.match(/last\s+(\d+)/i)[1]);
      const d = new Date();
      d.setMonth(d.getMonth() - n);
      d.setDate(1);
      return { from: SCX.toDate(d.toISOString()), to: today() };
    }
    const m = t.match(/(\d{4})\s+([a-z]{3})[a-z]*\s*-\s*([a-z]{3})[a-z]*/i);
    if (!m) return null;
    const y = Number(m[1]);
    const a = M[m[2].toLowerCase()];
    const b = M[m[3].toLowerCase()];
    const fy = a > b ? y - 1 : y;
    const end = new Date(y, b, 0).getDate();
    return { from: `${fy}-${String(a).padStart(2, '0')}-01`, to: `${y}-${String(b).padStart(2, '0')}-${String(end).padStart(2, '0')}` };
  }

  /** Change a React-controlled <select> so the app notices. */
  function chooseOption(select, option) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function costcoTab(selector) {
    const tab = document.querySelector(selector);
    if (!tab) return false;
    if (tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      await sleep(CFG.actionDelayMs);
      await waitForQuiet();
    }
    return true;
  }

  async function scanCostco() {
    const job = state.job;
    // In-Warehouse: walk the "Showing" periods that overlap the requested range.
    if (await costcoTab(CFG.warehouseTabSelector)) {
      await waitFor(() => document.querySelector(CFG.periodSelectSelector), 8000);
      const select = document.querySelector(CFG.periodSelectSelector);
      const options = select ? [...select.options] : [];
      const wanted = options.filter((o) => {
        const r = periodRange(o.textContent);
        return r && (!job.from || r.to >= job.from) && (!job.to || r.from <= job.to);
      });
      if (!wanted.length) wanted.push(null); // no dropdown: just read what's shown
      for (const opt of wanted) {
        if (state.stopRequested) return;
        const sel = document.querySelector(CFG.periodSelectSelector);
        if (opt && sel && sel.value !== opt.value) {
          const before = findCards().map((c) => c.id).join();
          chooseOption(sel, opt);
          await waitFor(() => findCards().map((c) => c.id).join() !== before, 8000);
          await sleep(CFG.actionDelayMs);
          await waitForQuiet();
        }
        job.periodLabel = opt ? opt.textContent.trim() : '';
        harvestCostcoCards();
        state.progress = `Reading receipts (${job.periodLabel || 'this period'})… ${job.seen.length} found`;
        if (job.details) await readCostcoReceipts();
      }
    }
    // Online: orders on the Online tab (early support — read what the page shows and links to).
    if (!state.stopRequested && (await costcoTab(CFG.onlineTabSelector))) {
      state.progress = 'Reading online orders…';
      harvestCards(harvestLinks());
    }
  }


  // ---------- Amazon ----------
  //
  // Your Orders is server-rendered: list pages (one year at a time via ?timeFilter=year-YYYY,
  // "Next →" for more) and each order's invoice (/gp/css/summary/print.html?orderID=…) can be
  // fetched directly with the user's own session and parsed, so the scan never has to click
  // through the user's tab. Shipping names/addresses on the cards are deliberately not saved.

  /** Visible text of a node (live page or fetched document) as trimmed lines. */
  function textLines(root) {
    const out = [];
    if (!root) return out;
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** Money for a label: "Label: $1.23" on one line, or the label then the amount on a later line. */
  function moneyFor(lines, labelRe, from = 0) {
    for (let i = from; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      const inline = lines[i].match(/(-?\$\s?[\d,]+\.\d{2})\s*$/);
      if (inline) return SCX.money(inline[1].replace(/\s/g, ''));
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const m = lines[j].match(/^(-?\$\s?[\d,]+\.\d{2})$/);
        if (m) return SCX.money(m[1].replace(/\s/g, ''));
        if (/^free$/i.test(lines[j])) return 0;
        if (/[a-z]{3}/i.test(lines[j]) && !labelRe.test(lines[j])) break;
      }
    }
    return null;
  }

  const lineAfter = (lines, re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? lines[i + 1] || '' : '';
  };

  function amazonCards(doc) {
    const cards = [...doc.querySelectorAll('.order-card, .js-order-card')];
    return cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));
  }

  /** Read order cards from a Your Orders page (the live page or a fetched one). */
  function harvestAmazonDoc(doc, baseUrl) {
    const out = [];
    for (const card of amazonCards(doc)) {
      const lines = textLines(card);
      const idEl = card.querySelector('.yohtmlc-order-id [dir="ltr"], .yohtmlc-order-id span:last-child');
      const id = ((idEl && idEl.textContent) || lines.join(' ')).match(CFG.orderIdPattern);
      if (!id) continue;
      const abs = (a) => (a ? new URL(a.getAttribute('href'), baseUrl).href : '');
      const links = [...card.querySelectorAll('a[href]')];
      const detailsA = links.find((a) => /order-details|orderID=.*details|view order details/i.test(a.getAttribute('href') + ' ' + a.textContent));
      const invoiceA = links.find((a) => /print\.html|invoice/i.test(a.getAttribute('href') + ' ' + a.textContent));
      // Items listed on the card: product title links. Prices come from the invoice.
      const seen = new Set();
      const items = [];
      card.querySelectorAll('.yohtmlc-product-title, a[href*="/dp/"], a[href*="/gp/product/"]').forEach((el) => {
        const a = el.tagName === 'A' ? el : el.closest('a') || el.querySelector('a');
        const name = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const asin = a ? ((a.getAttribute('href') || '').match(CFG.asinFromUrl) || [])[1] || '' : '';
        if (!name || name.length < 3 || /^(buy it again|view your item)$/i.test(name)) return;
        const key = asin || name;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ name, itemNumber: asin, quantity: 1, unitPrice: null, itemTotal: null, priceUnit: '', savings: null, category: '', status: '',
          productUrl: asin ? `https://www.amazon.com/dp/${asin}` : '', imageUrl: '' });
      });
      const status = (card.querySelector('.yohtmlc-shipment-status-primaryText') || {}).textContent || '';
      out.push({
        orderId: id[1],
        orderDate: SCX.toDate(lineAfter(lines, /^order placed$/i)),
        orderType: /^D\d{2}-/.test(id[1]) ? 'Digital' : 'Online',
        status: status.replace(/\s+/g, ' ').trim(),
        orderUrl: abs(detailsA) || CFG.detailsUrl(id[1]),
        invoiceUrl: abs(invoiceA) || CFG.invoiceUrl(id[1]),
        subTotal: null, tax: null, shipping: null, savings: null, coupon: null, giftCard: null,
        totalBeforeTax: null, grandTotal: SCX.money(lineAfter(lines, /^total$/i)), refundTotal: null,
        paymentMethods: '', currency: 'USD', itemCount: items.length || null, shipmentCount: null, clubName: '',
        itemPreview: items.map((i) => i.name),
        items: [], // card items have no prices; kept as a fallback below
        _cardItems: items,
        _source: 'amazon-card',
      });
    }
    return ingest(out);
  }

  /**
   * Invoice (print.html): "Order Placed: October 18, 2026", items as "1 of: <title>" followed
   * by "Sold by: …" and the unit price, then Item(s) Subtotal / Shipping & Handling / Total
   * before tax / Estimated tax to be collected / Grand Total, and the card ("Visa | Last digits: 1234").
   */
  function parseAmazonInvoice(doc, id) {
    const lines = textLines(doc.body);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\d+(?:\.\d+)?)\s+of:\s*(.*)$/i);
      if (!m) continue;
      const qty = Number(m[1]);
      let name = m[2].trim();
      let j = i + 1;
      if (!name) name = lines[j++] || '';
      let price = null;
      for (; j < Math.min(i + 25, lines.length); j++) {
        if (/^\d+(?:\.\d+)?\s+of:/i.test(lines[j])) break;
        const pm = lines[j].match(/^\$\s?([\d,]+\.\d{2})$/);
        if (pm) {
          price = SCX.money(pm[1]);
          break;
        }
      }
      items.push({ name, itemNumber: '', quantity: qty, unitPrice: price, itemTotal: price !== null ? Math.round(price * qty * 100) / 100 : null,
        priceUnit: '', savings: null, category: '', status: '', productUrl: '', imageUrl: '' });
    }
    const placed = lines.find((l) => /order placed:/i.test(l)) || '';
    const placedVal = placed.replace(/.*order placed:\s*/i, '') || lineAfter(lines, /^order placed:?$/i);
    const cards = [...new Set(lines.map((l) => {
      const a = l.match(/^([A-Za-z][A-Za-z .]*?)\s*\|\s*Last digits:\s*(\d{4})/i) || l.match(/^([A-Za-z][A-Za-z .]*?)\s+ending in\s+(\d{4})/i);
      return a ? `${a[1].trim()} ••${a[2]}` : '';
    }).filter(Boolean))];
    const promo = moneyFor(lines, /^(promotion applied|your coupon savings|free shipping|subscribe & save|discount)s?:?/i);
    const order = {
      orderId: id,
      items,
      subTotal: moneyFor(lines, /^item\(s\) subtotal:?/i),
      shipping: moneyFor(lines, /^shipping & handling:?/i),
      totalBeforeTax: moneyFor(lines, /^total before tax:?/i),
      tax: moneyFor(lines, /^(estimated tax to be collected|tax collected|sales tax|tax):?/i),
      grandTotal: moneyFor(lines, /^(grand total|order total):?/i),
      giftCard: moneyFor(lines, /^gift card amount:?/i),
      refundTotal: moneyFor(lines, /^(refund total|total refund|refunded):?/i),
      savings: promo !== null ? Math.abs(promo) : null,
      paymentMethods: cards.join('; '),
      _source: 'detail-dom',
    };
    const d = SCX.toDate(placedVal);
    if (d) order.orderDate = d;
    if (order.giftCard !== null) order.giftCard = Math.abs(order.giftCard);
    if (order.refundTotal !== null) order.refundTotal = Math.abs(order.refundTotal);
    for (const k of Object.keys(order)) if (order[k] === null) delete order[k];
    return order;
  }

  /**
   * Order details page (/your-orders/order-details?orderID=…). Sections are marked with
   * data-component: orderDate, chargeSummary (Item(s) Subtotal / Shipping & Handling /
   * Total before tax / Estimated tax to be collected / Grand Total) and one purchasedItems
   * block per item with itemTitle (/dp/ASIN link), quantity (empty when 1) and unitPrice.
   * The payment card is filled in by a script after load, so it comes from the invoice.
   */
  function parseAmazonDetails(doc, id) {
    const items = [];
    doc.querySelectorAll('[data-component="purchasedItems"]').forEach((block) => {
      const a = block.querySelector('[data-component="itemTitle"] a[href]') || block.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const name = ((block.querySelector('[data-component="itemTitle"]') || a || {}).textContent || '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      const asin = a ? ((a.getAttribute('href') || '').match(CFG.asinFromUrl) || [])[1] || '' : '';
      const priceEl = block.querySelector('[data-component="unitPrice"] .a-offscreen') || block.querySelector('[data-component="unitPrice"]');
      const unit = priceEl ? SCX.money(((priceEl.textContent || '').match(/-?\$?\s?[\d,]+\.\d{2}/) || [''])[0].replace(/[\s$]/g, '')) : null;
      const qText = ((block.querySelector('[data-component="quantity"]') || {}).textContent || '').trim();
      const qty = Number((qText.match(/[\d.]+/) || [])[0]) || 1;
      const img = block.querySelector('[data-component="itemImage"] img');
      const imageUrl = img ? img.getAttribute('data-a-hires') || img.getAttribute('src') || '' : '';
      const seller = ((block.querySelector('[data-component="orderedMerchant"]') || {}).textContent || '').replace(/\s+/g, ' ').replace(/^\s*Sold by:\s*/i, '').trim();
      items.push({
        name, itemNumber: asin, quantity: qty, unitPrice: unit, itemTotal: unit !== null ? Math.round(unit * qty * 100) / 100 : null,
        priceUnit: '', savings: null, category: '', status: '', seller,
        productUrl: asin ? `https://www.amazon.com/dp/${asin}` : '', imageUrl: /^https:/.test(imageUrl) ? imageUrl : '',
      });
    });
    const summary = doc.querySelector('[data-component="chargeSummary"]') || doc.body;
    const lines = textLines(summary);
    const promo = moneyFor(lines, /^(promotion applied|your coupon savings|free shipping|subscribe & save|discount)s?:?/i);
    const order = {
      orderId: id,
      items,
      subTotal: moneyFor(lines, /^item\(s\) subtotal:?/i),
      shipping: moneyFor(lines, /^shipping & handling:?/i),
      totalBeforeTax: moneyFor(lines, /^total before tax:?/i),
      tax: moneyFor(lines, /^(estimated tax to be collected|tax collected|sales tax|tax):?/i),
      grandTotal: moneyFor(lines, /^(grand total|order total):?/i),
      giftCard: moneyFor(lines, /^gift card amount:?/i),
      refundTotal: moneyFor(lines, /^(refund total|total refund|refunded):?/i),
      savings: promo !== null ? Math.abs(promo) : null,
      shipmentCount: doc.querySelectorAll('[data-component="shipmentStatus"]').length || null,
      _source: 'detail-dom',
    };
    const dateEl = doc.querySelector('[data-component="orderDate"]');
    const d = dateEl ? SCX.toDate(textLines(dateEl)[0] || '') : '';
    if (d) order.orderDate = d;
    if (order.giftCard !== null) order.giftCard = Math.abs(order.giftCard);
    if (order.refundTotal !== null) order.refundTotal = Math.abs(order.refundTotal);
    for (const k of Object.keys(order)) if (order[k] === null) delete order[k];
    return order;
  }

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'text/html' } });
    if (/\/ap\/signin|\/ap\/mfa/.test(res.url)) throw new Error('Amazon asked you to sign in again. Sign in, then scan again.');
    if (!res.ok) return null;
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function amazonYears(doc, from, to) {
    const opts = [...doc.querySelectorAll('select[name="timeFilter"] option, #time-filter option')]
      .map((o) => ((o.value || '').match(/^year-(\d{4})$/) || [])[1]).filter(Boolean).map(Number);
    const now = new Date().getFullYear();
    let years = opts.length ? opts : Array.from({ length: 10 }, (_, i) => now - i);
    const fy = from ? Number(from.slice(0, 4)) : 0;
    const ty = to ? Number(to.slice(0, 4)) : 9999;
    return [...new Set(years)].filter((y) => y >= fy && y <= ty).sort((a, b) => b - a);
  }

  /** For each order: details page (items, prices, totals), then the invoice (payment card). */
  async function readAmazonDetails() {
    const { from, to } = state.job;
    const todo = state.job.seen.map((id) => state.orders[id])
      .filter((o) => o && needsDetail(o) && (!from || !o.orderDate || o.orderDate >= from) && (!to || !o.orderDate || o.orderDate <= to));
    let i = 0;
    for (const o of todo) {
      if (state.stopRequested) return;
      i++;
      state.progress = `Reading order details ${i}/${todo.length}…`;
      let order = null;
      const det = await fetchDoc(o.orderUrl || CFG.detailsUrl(o.orderId));
      if (det) order = parseAmazonDetails(det, o.orderId);
      await sleep(CFG.detailFetchDelayMs);
      const inv = await fetchDoc(o.invoiceUrl || CFG.invoiceUrl(o.orderId));
      if (inv) {
        const v = parseAmazonInvoice(inv, o.orderId);
        if (!order || !order.items.length) order = { ...(order || {}), ...v };
        else {
          if (v.paymentMethods) order.paymentMethods = v.paymentMethods;
          for (const k of ['subTotal', 'shipping', 'totalBeforeTax', 'tax', 'grandTotal', 'giftCard', 'refundTotal', 'savings', 'orderDate']) {
            if (order[k] === undefined && v[k] !== undefined) order[k] = v[k];
          }
        }
      }
      // Fall back to the card's item list (names + ASINs) so nothing is lost.
      if (order && !(order.items && order.items.length) && o._cardItems) order.items = o._cardItems;
      if (order) ingest([order]);
      if (state.orders[o.orderId]) state.orders[o.orderId]._detailVersion = DETAIL_VERSION;
      await sleep(CFG.detailFetchDelayMs);
    }
  }

  async function scanAmazon() {
    const job = state.job;
    harvestAmazonDoc(document, location.href);
    const first = (await fetchDoc(CFG.listUrl(new Date().getFullYear(), 0))) || document;
    const years = amazonYears(first, job.from, job.to);
    for (const year of years) {
      if (state.stopRequested) return;
      let url = CFG.listUrl(year, 0);
      const visited = new Set();
      const yearIds = new Set(); // orders seen on this year's pages (the open tab may already have some)
      for (let page = 1; page <= 200 && url && !visited.has(url); page++) {
        if (state.stopRequested) return;
        visited.add(url);
        state.progress = `Reading ${year} orders (page ${page})… ${job.seen.length} found`;
        const doc = await fetchDoc(url);
        if (!doc) break;
        harvestAmazonDoc(doc, url);
        const pageIds = amazonCards(doc).map((c) => (textLines(c).join(' ').match(CFG.orderIdPattern) || [])[1]).filter(Boolean);
        if (!pageIds.length) break;
        const fresh = pageIds.filter((id) => !yearIds.has(id));
        fresh.forEach((id) => yearIds.add(id));
        if (!fresh.length) break; // a page we've already read (loop guard)
        // Orders are newest first: stop once this year's page is older than the range.
        const dates = amazonCards(doc).map((c) => SCX.toDate(lineAfter(textLines(c), /^order placed$/i))).filter(Boolean).sort();
        if (job.from && dates[dates.length - 1] && dates[dates.length - 1] < job.from) break;
        const next = doc.querySelector('.a-pagination .a-last:not(.a-disabled) a[href]');
        if (!next) break;
        const nu = new URL(next.getAttribute('href'), url);
        if (!nu.searchParams.has('timeFilter')) nu.searchParams.set('timeFilter', `year-${year}`);
        url = nu.href;
        await sleep(CFG.actionDelayMs);
      }
    }
    if (job.details) await readAmazonDetails();
  }

  // ---------- paging ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForQuiet(maxMs = 8000) {
    const start = Date.now();
    await sleep(600);
    while (Date.now() - start < maxMs) {
      if (Date.now() - state.lastCaptureAt > 1200) return;
      await sleep(300);
    }
  }

  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/\bdisabled\b/i.test(el.className || '');
  const label = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();

  function findLoadMore() {
    return [...document.querySelectorAll('button, a, [role="button"]')].find(
      (el) => visible(el) && enabled(el) && CFG.loadMoreButtonText.test(label(el))
    );
  }

  function findNextPage() {
    const rel = document.querySelector('a[rel="next"], link[rel="next"]');
    if (rel && rel.getAttribute('href')) return rel;
    return [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
      if (!visible(el) || !enabled(el)) return false;
      const t = label(el);
      const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-automation-id') || '');
      return /^(next|next page|›|»|>|→)$/i.test(t) || /next.?page|pagination.?next|\bnext\b/i.test(aria);
    });
  }

  /** Infinite-scroll lists often scroll inside a container rather than the window. */
  function scrollEverything() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    document.querySelectorAll('main, section, div, ul').forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 50) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') el.scrollTop = el.scrollHeight;
      }
    });
  }

  function jobOldest() {
    const d = state.job.seen.map((id) => state.orders[id] && state.orders[id].orderDate).filter(Boolean).sort();
    return d[0] || '';
  }

  /** Returns 'done' or 'navigating'. */
  async function scanList() {
    const job = state.job;
    if (CFG.scanStrategy === 'costco') {
      await scanCostco();
      return 'done';
    }
    if (CFG.scanStrategy === 'amazon') {
      await scanAmazon();
      return 'done';
    }
    let idle = 0;
    for (let round = 0; round < 500 && !state.stopRequested; round++) {
      const before = job.seen.length;
      harvestDocument(document, location.href);
      harvestGlassCards();
      harvestCards(harvestLinks());
      state.progress = `Reading order list (page ${job.pages.length})… ${job.seen.length} orders found`;

      if (job.from && jobOldest() && jobOldest() < job.from) return 'done'; // reached the start of the range

      const more = findLoadMore();
      const next = more ? null : findNextPage();
      const target = more || next;
      if (next) {
        // Moving to an older page: its first card is on or before this page's last card.
        job.lastDate = state.pageLast || job.lastDate || '';
        state.pageRef = job.lastDate;
      }
      if (target) {
        const href = target.tagName === 'A' || target.tagName === 'LINK' ? target.getAttribute('href') : '';
        const abs = href && !/^(#|javascript:)/i.test(href) ? new URL(href, location.href).href : '';
        if (abs && abs.split('#')[0] !== location.href.split('#')[0]) {
          if (job.pages.includes(abs)) return 'done'; // loop guard
          job.pages.push(abs);
          await save();
          location.assign(abs); // resumes on the next page
          return 'navigating';
        }
        target.scrollIntoView({ block: 'center' });
        target.click();
      } else {
        scrollEverything();
      }
      await sleep(CFG.actionDelayMs);
      await waitForQuiet();
      if (location.href !== job.pages[job.pages.length - 1]) job.pages.push(location.href); // SPA route change

      idle = job.seen.length === before ? idle + 1 : 0;
      if (idle >= (target ? 4 : 3)) return 'done';
    }
    return 'done';
  }

  // ---------- detail backfill ----------

  const DETAIL_VERSION = 3; // bump when detail parsing improves, so old orders get re-read once

  function needsDetail(o) {
    if (!(o.items && o.items.length) || o.tax === null || o.grandTotal === null) return true;
    const unpriced = o.items.every((i) => i.unitPrice == null && i.itemTotal == null);
    return unpriced && (o._detailVersion || 0) < DETAIL_VERSION;
  }

  function detailUrl(o) {
    return o.orderUrl || state.links[o.orderId] || (CFG.detailUrlFor ? CFG.detailUrlFor(o) : CFG.orderDetailUrlTemplate.replace('{orderId}', encodeURIComponent(o.orderId)));
  }

  async function fetchDetail(o) {
    const url = detailUrl(o);
    try {
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'text/html,application/json' } });
      if (!res.ok) return false;
      const text = await res.text();
      let orders = [];
      if (/^\s*[{[]/.test(text)) {
        orders = SCX.extractOrders(JSON.parse(text), url);
      } else {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        doc.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]').forEach((s) => {
          try {
            orders.push(...SCX.extractOrders(JSON.parse(s.textContent), url));
          } catch (_) {}
        });
      }
      const mine = orders.filter((x) => x.orderId === o.orderId);
      if (mine.length) {
        mine.forEach((x) => (x.orderUrl = x.orderUrl || url));
        ingest(mine);
        return !needsDetail(state.orders[o.orderId]);
      }
    } catch (_) {}
    return false;
  }

  /** Detail pages that render client-side: load them in a hidden same-origin iframe so inject.js captures their API calls. */
  function iframeDetail(o, timeoutMs = 15000) {
    state.pendingDetail = { id: o.orderId };
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;';
      f.src = detailUrl(o);
      const start = Date.now();
      const timer = setInterval(() => {
        const cur = state.orders[o.orderId];
        if ((cur && !needsDetail(cur)) || Date.now() - start > timeoutMs || state.stopRequested) {
          clearInterval(timer);
          f.remove();
          state.pendingDetail = null;
          resolve(cur && !needsDetail(cur));
        }
      }, 500);
      document.body.appendChild(f);
    });
  }

  function setTemplateFrom(url, id) {
    state.detailTemplate = url.includes(id) ? url.split('#')[0].replace(id, '{orderId}') : '';
    return chrome.storage.local.set({ [K.template]: state.detailTemplate });
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * Cards with a "See details" button (no link): click one to learn what a detail URL
   * looks like, then come back. Survives both SPA routing and full page loads.
   */
  async function learnDetailTemplate() {
    if (state.detailTemplate) return true;
    const stored = (await chrome.storage.local.get(K.template))[K.template];
    if (stored) {
      state.detailTemplate = stored;
      return true;
    }
    const btn = document.querySelector(CFG.orderDetailButtonSelector);
    if (!btn) return false;
    const id = btn.getAttribute('data-automation-id').slice(CFG.orderDetailButtonIdPrefix.length);
    const before = location.href;
    state.pendingDetail = { id };
    state.job.phase = 'learning';
    state.job.learnId = id;
    state.job.listUrl = before;
    await save();
    state.progress = 'Opening one order to learn the details page…';
    btn.click();
    const moved = await waitFor(() => location.href !== before, 8000);
    state.job.phase = 'details';
    if (!moved) {
      state.pendingDetail = null;
      await save();
      return false;
    }
    await setTemplateFrom(location.href, id);
    await waitForQuiet(); // let this order's details be captured
    expandItems();
    if (await waitFor(() => document.querySelector(CFG.itemTileSelector), 6000)) {
      await sleep(500);
      harvestDetailPage();
    }
    state.pendingDetail = null;
    history.back();
    await waitFor(() => location.href === before && findCards().length, 10000);
    await save();
    return !!state.detailTemplate;
  }

  async function scanDetails() {
    const { from, to } = state.job;
    const inRange = (o) => (!from || !o.orderDate || o.orderDate >= from) && (!to || !o.orderDate || o.orderDate <= to);
    // Costco warehouse receipts only exist as popups (read during the list phase); only
    // orders with a real details link go through the generic details step.
    const eligible = (o) => (CFG.scanStrategy === 'costco' ? !!o.orderUrl : CFG.scanStrategy !== 'amazon');
    const pending = () => state.job.seen.map((id) => state.orders[id]).filter((o) => o && needsDetail(o) && inRange(o) && eligible(o));
    if (!CFG.detailUrlFor && pending().some((o) => !o.orderUrl && !state.links[o.orderId])) await learnDetailTemplate();
    if (!state.job) return; // navigated away; resumes on the next page load

    const todo = pending();
    let i = 0;
    let failures = 0;
    let successes = 0;
    for (const o of todo) {
      if (state.stopRequested) break;
      i++;
      state.progress = `Fetching order details ${i}/${todo.length}…`;
      if (!o.orderUrl && state.detailTemplate) o.orderUrl = state.detailTemplate.replace('{orderId}', o.orderId);
      let ok = await fetchDetail(o);
      if (!ok) ok = await iframeDetail(o);
      if (state.orders[o.orderId]) state.orders[o.orderId]._detailVersion = DETAIL_VERSION;
      if (ok) successes++;
      else failures++;
      if (!successes && failures >= 3) {
        state.detailNote = "Order detail pages couldn't be read automatically; the export has list data only (date, type, item count).";
        break;
      }
      await sleep(CFG.detailFetchDelayMs);
    }
  }

  // ---------- scan driver ----------

  async function runJob() {
    if (state.scanning) return;
    state.scanning = true;
    state.stopRequested = false;
    let navigating = false;
    try {
      await load();
      if (state.job.phase === 'learning') {
        // We landed on a detail page after clicking "See details" (full page load).
        await setTemplateFrom(location.href, state.job.learnId);
        state.job.phase = 'details';
        await save();
        navigating = true;
        location.assign(state.job.listUrl);
        return;
      }
      if (state.job.phase === 'list') {
        const r = await scanList();
        if (r === 'navigating') {
          navigating = true;
          return;
        }
        state.job.phase = 'details';
        await save();
      }
      if (state.job.details && !state.stopRequested) await scanDetails();
      if (!state.job) return;
      const n = state.job.seen.length;
      state.job = null;
      await chrome.storage.local.remove(K.job);
      await save();
      state.progress = state.stopRequested ? 'Stopped.' : `Done — ${n} order${n === 1 ? '' : 's'} found in this scan.` + (state.detailNote ? ' ' + state.detailNote : '');
      state.detailNote = '';
    } catch (err) {
      state.progress = 'Error: ' + (err && err.message ? err.message : err);
      state.job = null;
      await chrome.storage.local.remove(K.job);
    } finally {
      if (!navigating) state.scanning = false;
    }
  }

  async function startScan({ from, to, details }) {
    if (state.scanning) return;
    state.pageRef = '';
    state.job = { from, to, details, phase: 'list', seen: [...state.pageSeen], pages: [location.href], startedAt: Date.now() };
    await chrome.storage.local.set({ [K.job]: state.job });
    runJob();
  }

  async function resumeIfNeeded() {
    const scanJob = (await chrome.storage.local.get(K.job))[K.job];
    if (!scanJob) return;
    if (Date.now() - scanJob.startedAt > JOB_MAX_AGE_MS) return chrome.storage.local.remove(K.job);
    state.job = scanJob;
    state.pageRef = scanJob.lastDate || '';
    for (const id of state.pageSeen) if (!scanJob.seen.includes(id)) scanJob.seen.push(id);
    state.progress = 'Resuming scan on the next page…';
    await sleep(2000); // let the new page load its orders
    runJob();
  }

  function debugReport() {
    const orders = Object.values(state.orders);
    const btns = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(visible)
      .map((el) => label(el).replace(/\s+/g, ' ').replace(/\d/g, '#'))
      .filter((t) => t && t.length <= 30 && /more|next|prev|page|detail|receipt|order|view|show|load|online|warehouse|purchase|history|item/i.test(t) && !/^hi\b|account|sign/i.test(t));
    return {
      tool: 'Order History Exporter debug report (structure only — no order values)',
      retailer: CFG.id,
      version: chrome.runtime.getManifest().version,
      page: pathOnly(location.href),
      savedOrders: orders.length,
      withDate: orders.filter((o) => o.orderDate).length,
      withItems: orders.filter((o) => o.items && o.items.length).length,
      withTax: orders.filter((o) => o.tax !== null).length,
      orderIdShapes: [...new Set(orders.map((o) => String(o.orderId).replace(/\d/g, '#').replace(/[A-Za-z]/g, 'a')))].slice(0, 10),
      orderCardsOnPage: findCards().length,
      itemTilesOnPage: document.querySelectorAll(CFG.itemTileSelector).length,
      detailButtonsOnPage: document.querySelectorAll(CFG.orderDetailButtonSelector).length,
      detailTemplate: state.detailTemplate ? pathOnly(state.detailTemplate.replace('{orderId}', '0000000000')) : '',
      orderLinksOnPage: Object.keys(state.links).length,
      orderLinkSamples: [...new Set(Object.values(state.links).map(pathOnly))].slice(0, 5),
      loadMoreFound: !!findLoadMore(),
      nextPageFound: (() => { const n = findNextPage(); return n ? `${n.tagName} "${label(n).slice(0, 20)}"` : false; })(),
      clickableTexts: [...new Set(btns)].slice(0, 80),
      lastScan: state.progress,
      embeddedJson: state.diag.embedded,
      networkJson: state.diag.captures,
    };
  }

  // ---------- popup messaging ----------

  if (IS_TOP) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === 'status') {
        reply({
          retailer: CFG.id,
          onOrdersPage: /order|purchase|receipt|history/i.test(location.pathname + location.hash),
          count: Object.keys(state.orders).length,
          scanning: state.scanning,
          progress: state.progress,
          url: location.href,
        });
      } else if (msg.type === 'scan') {
        if (!consented) return reply({ started: false, reason: 'consent' });
        startScan(msg);
        reply({ started: true });
      } else if (msg.type === 'stop') {
        state.stopRequested = true;
        state.job = null;
        chrome.storage.local.remove(K.job);
        reply({ ok: true });
      } else if (msg.type === 'cleared') {
        state.orders = {};
        state.links = {};
        reply({ ok: true });
      } else if (msg.type === 'debug') {
        harvestLinks();
        reply(debugReport());
      }
      return true;
    });

    consentReady.then(load).then(() => {
      const run = () => {
        harvestDocument(document, location.href);
        harvestLinks();
        harvestGlassCards();
        if (CFG.scanStrategy === 'amazon') harvestAmazonDoc(document, location.href);
        // Cards render after the page's own data request; pick them up as they appear.
        let t = null;
        new MutationObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => {
            if (!state.job || state.job.phase === 'list') harvestGlassCards();
            harvestDetailPage();
            if (CFG.scanStrategy === 'costco' && !state.scanning) harvestOpenReceipt();
            if (CFG.scanStrategy === 'amazon' && !state.scanning) harvestAmazonDoc(document, location.href);
          }, 700);
        }).observe(document.body, { childList: true, subtree: true });
        resumeIfNeeded();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
      else run();
    });
  } else {
    // In a detail iframe: report embedded data and item tiles as they render. Also re-read
    // on a timer, since expanding the item list changes styles, not the DOM tree.
    const run = () => {
      harvestDocument(document, location.href);
      let ticks = 0;
      const timer = setInterval(() => {
        expandItems();
        harvestDetailPage();
        if (++ticks >= 12) clearInterval(timer);
      }, 1500);
      let t = null;
      new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          expandItems();
          harvestDetailPage();
        }, 600);
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();
