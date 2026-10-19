/*
 * Order normalizer.
 *
 * Sam's Club does not publish an order-history API, and the shape of the JSON its
 * pages load changes over time. Instead of hard-coding one schema, this module walks
 * any JSON payload, recognises objects that look like orders (an order-ish id plus a
 * date or money total), and maps them onto a stable export schema.
 *
 * If you pin the exact field names with REA (see REA_RECON.md), add them to
 * fieldHints in src/retailers.js; they are tried before the heuristics.
 *
 * Works in the extension (attaches to globalThis.SCX) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const cfg = () => (root.SCX_CONFIG && root.SCX_CONFIG.fieldHints) || {};

  // ---------- small helpers ----------

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

  function firstKey(obj, names) {
    if (!isObj(obj)) return undefined;
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(obj, n) && !isEmpty(obj[n])) return obj[n];
    }
    // case-insensitive pass
    const lower = {};
    for (const k of Object.keys(obj)) lower[k.toLowerCase()] = k;
    for (const n of names) {
      const k = lower[n.toLowerCase()];
      if (k !== undefined && !isEmpty(obj[k])) return obj[k];
    }
    return undefined;
  }

  /** Find a value whose key matches `re` within `depth` levels of nesting (objects only). */
  function deepKey(obj, re, depth = 2, exclude) {
    if (!isObj(obj)) return undefined;
    const queue = [[obj, 0]];
    while (queue.length) {
      const [o, d] = queue.shift();
      for (const k of Object.keys(o)) {
        if (re.test(k) && !(exclude && exclude.test(k)) && !isEmpty(o[k])) {
          const m = money(o[k]);
          if (m !== null) return o[k];
        }
      }
      if (d < depth) {
        for (const k of Object.keys(o)) if (isObj(o[k])) queue.push([o[k], d + 1]);
      }
    }
    return undefined;
  }

  /** Parse money from numbers, "$1,234.56", "-$3.00", {value}, {amount}, {displayValue}, {price}. */
  function money(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
    if (typeof v === 'string') {
      const s = v.replace(/[,\s]/g, '');
      const m = s.match(/^\(?(-)?\$?(-)?(\d+(?:\.\d+)?)\)?$/);
      if (!m) return null;
      const neg = m[1] || m[2] || /^\(.*\)$/.test(s);
      return round2((neg ? -1 : 1) * parseFloat(m[3]));
    }
    if (isObj(v)) {
      for (const k of ['value', 'amount', 'price', 'currencyAmount', 'amountValue', 'displayValue', 'displayPrice', 'priceString', 'formattedValue']) {
        if (k in v) {
          const r = money(v[k]);
          if (r !== null) return r;
        }
      }
    }
    return null;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function currencyOf(v) {
    if (isObj(v)) return firstKey(v, ['currencyUnit', 'currency', 'currencyCode']) || null;
    return null;
  }

  /** Parse a date from ISO strings, epoch ms/s, "Oct 3, 2026", "10/03/2026". Returns YYYY-MM-DD or ''. */
  function toDate(v) {
    if (v === undefined || v === null || v === '') return '';
    if (isObj(v)) return toDate(firstKey(v, ['value', 'date', 'dateTime', 'displayValue', 'formatted']));
    let d;
    if (typeof v === 'number') {
      d = new Date(v < 1e12 ? v * 1000 : v);
    } else if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d{10,13}$/.test(s)) return toDate(Number(s));
      // Avoid timezone shift for plain dates
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (us) {
        const y = us[3].length === 2 ? '20' + us[3] : us[3];
        return `${y}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      }
      d = new Date(s.replace(/^(placed|ordered|purchased)( on)?:?\s*/i, ''));
    }
    if (!d || isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    if (y < 1995 || y > 2100) return '';
    return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  /**
   * "Purchased on Tue, Dec 2" has no year. Pick the latest year that puts the date on or
   * before `notAfter` (YYYY-MM-DD; the previous, newer order in the list, or today).
   * Returns { date, inferred } or null.
   */
  function parseLooseDate(str, notAfter) {
    if (!str) return null;
    const full = toDate(str);
    if (full && /\b(19|20)\d{2}\b/.test(str)) return { date: full, inferred: false };
    const m = String(str).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
    if (!m) return full ? { date: full, inferred: false } : null;
    const mon = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const ref = notAfter || toDate(new Date().toISOString());
    let y = Number(ref.slice(0, 4));
    if (iso(y, mon, day) > ref) y -= 1;
    return { date: iso(y, mon, day), inferred: true };
  }

  const DATE_PHRASE_RE = /\b(?:purchased|ordered|placed|delivered|picked up|completed|bought)\s+on\s+([^|\n]{3,40})/i;

  /** Look for "Purchased on …" style text anywhere shallow in an object. */
  function datePhraseIn(o, depth = 3) {
    let hit = '';
    (function walk(v, d) {
      if (hit || d > depth || v === null) return;
      if (typeof v === 'string') {
        const m = v.match(DATE_PHRASE_RE);
        if (m) hit = m[1];
      } else if (Array.isArray(v)) v.slice(0, 20).forEach((x) => walk(x, d + 1));
      else if (typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], d + 1));
    })(o, 0);
    return hit;
  }

  function text(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (isObj(v)) return text(firstKey(v, ['displayName', 'name', 'text', 'value', 'label', 'title', 'description']));
    return '';
  }

  // ---------- recognisers ----------

  const ORDER_ID_KEYS = ['orderId', 'orderNumber', 'purchaseOrderId', 'orderNo', 'displayOrderNumber', 'customerOrderId', 'salesOrderId', 'receiptId', 'tcNumber', 'transactionId', 'transactionNumber'];
  const ORDER_DATE_KEYS = ['orderDate', 'orderPlacedDate', 'orderPlacedTime', 'placedDate', 'placedTime', 'orderPlacedDateTime', 'purchaseDate', 'transactionDate', 'transactionDateTime', 'createdDate', 'creationDate', 'createdAt', 'orderCreatedDate', 'date'];
  const ITEM_ARRAY_RE = /^(items|lineItems|orderItems|orderLines|lines|products|itemDetails|purchasedItems|groups|fulfillmentGroups|shipments|packages|receiptItems)$/i;
  const ITEM_NAME_KEYS = ['productName', 'itemName', 'name', 'title', 'description', 'itemDescription', 'displayName', 'productTitle'];
  const ITEM_ID_KEYS = ['itemNumber', 'itemNo', 'itemId', 'usItemId', 'productId', 'sku', 'skuId', 'upc', 'gtin', 'catalogItemId', 'offerId'];

  // Parent keys that mean "the objects in here are orders", so a plain `id` counts as the order id.
  const ORDER_CONTEXT_RE = /order|purchase|receipt|transaction|history|invoice/i;

  function orderIdOf(o, ctx) {
    const hints = cfg().orderId || [];
    let id = firstKey(o, hints.concat(ORDER_ID_KEYS));
    if (id === undefined && ctx && ORDER_CONTEXT_RE.test(ctx)) id = firstKey(o, ['id', 'displayId', 'number', 'orderID']);
    if (id === undefined) return '';
    const s = text(id);
    return /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : '';
  }

  const hasItemArray = (o) => Object.keys(o).some((k) => ITEM_ARRAY_RE.test(k) && Array.isArray(o[k]));

  function orderDateOf(o) {
    const hints = cfg().orderDate || [];
    const v = firstKey(o, hints.concat(ORDER_DATE_KEYS));
    return toDate(v);
  }

  function looksLikeOrder(o, ctx) {
    if (!isObj(o)) return false;
    if (!orderIdOf(o, ctx)) return false;
    // A list card often has just an id and a date (totals/items only on the detail page).
    if (orderDateOf(o) || datePhraseIn(o)) return true;
    // Purchase-history entries: explicit order id + items, totals only on the detail page.
    if (ctx && ORDER_CONTEXT_RE.test(ctx) && hasItemArray(o)) return true;
    const hasMoney = deepKey(o, /total|amount|subtotal/i, 2) !== undefined;
    return hasMoney && hasItemArray(o);
  }

  function looksLikeItem(o) {
    if (!isObj(o)) return false;
    const name = text(firstKey(o, ITEM_NAME_KEYS)) || text(firstKey(firstKey(o, ['product', 'productInfo', 'item']) || {}, ITEM_NAME_KEYS));
    if (!name || name.length < 2) return false;
    const hasQtyOrPrice =
      firstKey(o, ['quantity', 'qty', 'orderedQuantity', 'quantityOrdered', 'itemQuantity']) !== undefined ||
      deepKey(o, /price|amount|total|cost/i, 2) !== undefined;
    return hasQtyOrPrice;
  }

  // ---------- extractors ----------

  function extractItems(order) {
    const out = [];
    const seen = new Set();
    (function walk(node, depth) {
      if (depth > 6 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1));
        return;
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v) && ITEM_ARRAY_RE.test(k)) {
          for (const el of v) {
            if (looksLikeItem(el) && !hasItemArray(el)) {
              const item = normalizeItem(el);
              const key = `${item.itemNumber}|${item.name}|${item.quantity}|${item.itemTotal}`;
              if (!seen.has(key)) {
                seen.add(key);
                out.push(item);
              }
            } else {
              walk(el, depth + 1); // e.g. shipments -> items
            }
          }
        } else if (isObj(v) && !looksLikeOrder(v)) {
          walk(v, depth + 1);
        }
      }
    })(order, 0);
    return out;
  }

  function normalizeItem(el) {
    const product = firstKey(el, ['product', 'productInfo', 'item', 'itemInfo']) || {};
    const name = text(firstKey(el, ITEM_NAME_KEYS)) || text(firstKey(product, ITEM_NAME_KEYS));
    const qtyRaw = firstKey(el, ['quantity', 'qty', 'orderedQuantity', 'quantityOrdered', 'itemQuantity']);
    let quantity = Number(isObj(qtyRaw) ? money(qtyRaw) : qtyRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;

    const unit = money(firstKey(el, ['unitPrice', 'price', 'itemPrice', 'salePrice'])) ??
      money(deepKey(el, /^(unit.?price|price|item.?price)$/i, 2));
    const lineTotal = money(firstKey(el, ['totalPrice', 'lineTotal', 'linePrice', 'subTotal', 'subtotal', 'extendedPrice', 'itemTotal', 'total', 'amount'])) ??
      money(deepKey(el, /^((line|extended).?(total|price|amount)|item.?total|total.?price|line.?amount)$/i, 2, /unit/i));

    const unitPrice = unit ?? (lineTotal !== null ? round2(lineTotal / quantity) : null);
    const itemTotal = lineTotal ?? (unitPrice !== null ? round2(unitPrice * quantity) : null);

    const url = text(firstKey(el, ['productUrl', 'canonicalUrl', 'url', 'productPageUrl'])) || text(firstKey(product, ['productUrl', 'canonicalUrl', 'url']));
    const image = text(firstKey(el, ['imageUrl', 'thumbnailUrl', 'image', 'imageInfo'])) || text(firstKey(product, ['imageUrl', 'thumbnailUrl', 'image']));

    return {
      name,
      itemNumber: text(firstKey(el, ITEM_ID_KEYS)) || text(firstKey(product, ITEM_ID_KEYS)),
      quantity,
      unitPrice,
      itemTotal,
      savings: money(deepKey(el, /saving|discount|instantSaving/i, 2)),
      category: text(firstKey(el, ['category', 'categoryName', 'department', 'departmentName'])) || text(firstKey(product, ['category', 'categoryName', 'department'])),
      status: text(firstKey(el, ['status', 'itemStatus', 'fulfillmentStatus', 'deliveryStatus'])),
      productUrl: absUrl(url),
      imageUrl: absUrl(isObj(image) ? text(image.url) : image),
    };
  }

  function absUrl(u) {
    if (!u || typeof u !== 'string') return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return 'https://www.samsclub.com' + u;
    return '';
  }

  function paymentMethodsOf(o) {
    const arr = firstKey(o, ['paymentMethods', 'payments', 'tenders', 'paymentInfo', 'paymentDetails', 'tenderDetails']);
    const list = Array.isArray(arr) ? arr : isObj(arr) ? [arr] : [];
    return list
      .map((p) => {
        const type = text(firstKey(p, ['displayName', 'cardType', 'paymentType', 'type', 'tenderType', 'brand', 'name']));
        const last4 = text(firstKey(p, ['lastFour', 'last4', 'cardLast4', 'lastFourDigits']));
        return [type, last4 ? `••${last4}` : ''].filter(Boolean).join(' ');
      })
      .filter(Boolean)
      .join('; ');
  }

  function orderTypeOf(o) {
    const raw = text(firstKey(o, ['orderType', 'type', 'channel', 'fulfillmentType', 'purchaseType', 'orderChannel', 'shoppingChannel'])).toLowerCase();
    if (/scan.?(and|&|n)?.?go/.test(raw)) return 'Scan & Go';
    if (/fuel|gas/.test(raw)) return 'Fuel';
    if (/club|store|in.?club|pos|receipt/.test(raw) || firstKey(o, ['tcNumber', 'receiptId']) !== undefined) return 'In-Club';
    if (/pickup|curbside/.test(raw)) return 'Pickup';
    if (/delivery/.test(raw)) return 'Delivery';
    if (/ship|online|web|dotcom/.test(raw)) return 'Shipping';
    return raw ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  }

  function countShipments(o) {
    const s = firstKey(o, ['shipments', 'packages', 'fulfillmentGroups', 'groups']);
    return Array.isArray(s) ? s.length : null;
  }

  function normalizeOrder(o, sourceUrl, ctx) {
    const id = orderIdOf(o, ctx);
    const totalsRoot = firstKey(o, ['priceDetails', 'orderTotals', 'totals', 'paymentSummary', 'charges', 'summary', 'priceSummary', 'orderSummary']) || o;
    const pick = (re, ex) => money(deepKey(totalsRoot, re, 3, ex)) ?? money(deepKey(o, re, 1, ex));

    const subTotal = pick(/^sub.?total(amount)?$/i);
    const tax = pick(/^(total.?)?tax(es)?(.?total|.?amount)?$|^salesTax$/i, /taxable|exempt/i);
    const shipping = pick(/^(shipping|delivery|shippingAndHandling|shippingCharges?|deliveryFee|shippingFee)(.?total|.?amount)?$/i);
    const grand = pick(/^(grand.?total|order.?total|total(amount)?|amount.?paid|totalCharged|total.?price|orderAmount)$/i);
    const refund = pick(/refund/i);
    const savings = pick(/^(total.?)?(savings?|discounts?|instant.?savings?)(.?total|.?amount)?$/i);
    const coupon = pick(/coupon|promo/i);
    const giftCard = pick(/gift.?card/i);

    const items = extractItems(o);
    const itemCountRaw = firstKey(o, ['itemCount', 'numberOfItems', 'totalItems', 'totalItemCount', 'itemsCount']);
    const itemCount = Number(itemCountRaw) || items.reduce((n, i) => n + (i.quantity || 1), 0) || null;

    const urlRaw = text(firstKey(o, ['orderDetailsUrl', 'orderUrl', 'detailsUrl', 'url', 'link']));
    const invoiceRaw = text(firstKey(o, ['invoiceUrl', 'receiptUrl', 'printReceiptUrl', 'invoiceLink']));

    const totalBeforeTax =
      grand !== null && tax !== null ? round2(grand - tax) : subTotal !== null ? round2(subTotal + (shipping || 0)) : null;

    let orderDate = orderDateOf(o);
    let dateInferred = false;
    if (!orderDate) {
      const loose = parseLooseDate(datePhraseIn(o));
      if (loose) ({ date: orderDate, inferred: dateInferred } = loose);
    }

    return {
      orderId: id,
      orderDate,
      _dateInferred: dateInferred,
      tcNumber: text(firstKey(o, ['tcNumber', 'tc', 'transactionNumber'])),
      orderType: orderTypeOf(o),
      status: text(firstKey(o, ['status', 'orderStatus', 'displayStatus', 'statusText'])),
      orderUrl: absUrl(urlRaw),
      invoiceUrl: absUrl(invoiceRaw),
      subTotal,
      tax,
      shipping,
      savings: savings !== null ? Math.abs(savings) : null,
      coupon: coupon !== null ? Math.abs(coupon) : null,
      giftCard: giftCard !== null ? Math.abs(giftCard) : null,
      totalBeforeTax,
      grandTotal: grand,
      refundTotal: refund !== null ? Math.abs(refund) : null,
      paymentMethods: paymentMethodsOf(o),
      currency: currencyOf(deepKey(totalsRoot, /total/i, 2)) || 'USD',
      itemCount,
      shipmentCount: countShipments(o),
      clubName: text(firstKey(o, ['clubName', 'storeName', 'clubLocation', 'storeAddress'])),
      items,
      _source: sourceUrl || '',
    };
  }

  /** Walk any JSON value and return every normalized order found in it. */
  function extractOrders(json, sourceUrl) {
    const found = [];
    const visited = new WeakSet();
    (function walk(node, depth, ctx) {
      if (depth > 40 || node === null || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1, ctx));
        return;
      }
      if (looksLikeOrder(node, ctx)) {
        found.push(normalizeOrder(node, sourceUrl, ctx));
        return; // don't descend: sub-objects are part of this order
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1, k);
    })(json, 0, '');
    return found;
  }

  // How much an item list actually tells us: priced / identified items beat bare names.
  function richness(items) {
    let score = 0;
    for (const i of items) {
      score += 1;
      if (i.unitPrice !== null && i.unitPrice !== undefined) score += 4;
      if (i.itemTotal !== null && i.itemTotal !== undefined) score += 4;
      for (const k of ['itemNumber', 'productUrl', 'imageUrl', 'category']) if (i[k]) score += 1;
    }
    return score;
  }

  /**
   * Pick the more informative item list (the order list often has names + quantities only,
   * the detail page has prices). Then fill any gaps in it from the other list, matching
   * items by name.
   */
  function mergeItems(ai, bi) {
    if (!ai.length) return bi;
    if (!bi.length) return ai;
    const [main, other] = richness(bi) >= richness(ai) ? [bi, ai] : [ai, bi];
    const byName = new Map(other.map((i) => [String(i.name).toLowerCase().trim(), i]));
    return main.map((i) => {
      const o = byName.get(String(i.name).toLowerCase().trim());
      if (!o) return i;
      const m = { ...i };
      for (const k of Object.keys(o)) if (isEmpty(m[k]) && !isEmpty(o[k])) m[k] = o[k];
      return m;
    });
  }

  /** Merge b into a, keeping non-empty values; items take the richer list. */
  function mergeOrder(a, b) {
    if (!a) return b;
    const out = { ...a };
    // A real date beats one whose year we had to guess.
    if (a._dateInferred && b.orderDate && !b._dateInferred) {
      out.orderDate = b.orderDate;
      out._dateInferred = false;
    }
    for (const k of Object.keys(b)) {
      if (k === 'items' || k === 'orderDate' && out.orderDate) continue;
      if (isEmpty(out[k]) && !isEmpty(b[k])) out[k] = b[k];
      // detail pages are usually more accurate than list cards for money
      else if (typeof b[k] === 'number' && b._source && /detail|\/orders?\/[^/?]+/i.test(b._source)) out[k] = b[k];
    }
    out.items = mergeItems(a.items || [], b.items || []);
    out._detailVersion = Math.max(a._detailVersion || 0, b._detailVersion || 0);
    if (!out.itemCount && out.items.length) out.itemCount = out.items.reduce((n, i) => n + (i.quantity || 1), 0);
    return out;
  }

  function mergeInto(map, orders) {
    let added = 0;
    for (const o of orders) {
      if (!o.orderId) continue;
      if (!map[o.orderId]) added++;
      map[o.orderId] = mergeOrder(map[o.orderId], o);
    }
    return added;
  }

  /** Value-free structure of a JSON payload (paths and types only) for debug reports. */
  function shapeOf(json, maxPaths = 200) {
    const out = new Set();
    (function walk(v, p, d) {
      if (out.size >= maxPaths || d > 12) return;
      if (Array.isArray(v)) {
        if (!v.length) out.add(p + '[]: empty');
        else walk(v[0], p + '[]', d + 1);
      } else if (isObj(v)) {
        for (const k of Object.keys(v)) walk(v[k], p ? p + '.' + k : k, d + 1);
      } else out.add(p + ': ' + (v === null ? 'null' : typeof v));
    })(json, '', 0);
    return [...out];
  }

  const api = { parseLooseDate, shapeOf, extractOrders, normalizeOrder, normalizeItem, mergeOrder, mergeInto, money, toDate, looksLikeOrder, looksLikeItem };
  root.SCX = Object.assign(root.SCX || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
