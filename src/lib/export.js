/*
 * Builds the two reports (orders and purchased items) and serialises them to CSV or
 * an Excel workbook. Excel output needs SheetJS (vendor/xlsx.full.min.js) as global XLSX.
 */
(function (root) {
  'use strict';

  const ORDER_COLUMNS = [
    ['Retailer', 'retailer'],
    ['Order Type', 'orderType'],
    ['Order ID', 'orderId'],
    ['TC Number', 'tcNumber'],
    ['Order Date', 'orderDate'],
    ['Status', 'status'],
    ['Order URL', 'orderUrl'],
    ['Invoice URL', 'invoiceUrl'],
    ['Sub Total', 'subTotal'],
    ['Shipping & Handling', 'shipping'],
    ['Savings', 'savings'],
    ['Coupon', 'coupon'],
    ['Gift Card', 'giftCard'],
    ['Total Before Tax', 'totalBeforeTax'],
    ['Tax', 'tax'],
    ['Grand Total', 'grandTotal'],
    ['Refund Total', 'refundTotal'],
    ['Payment Methods', 'paymentMethods'],
    ['Currency', 'currency'],
    ['Number of Items', 'itemCount'],
    ['Number of Shipments', 'shipmentCount'],
    ['Store / Club', 'clubName'],
    ['Item Names', 'itemNames'],
  ];

  const ITEM_COLUMNS = [
    ['Retailer', 'retailer'],
    ['Order ID', 'orderId'],
    ['Order Date', 'orderDate'],
    ['Order Type', 'orderType'],
    ['Item Name', 'name'],
    ['Item Number', 'itemNumber'],
    ['Quantity', 'quantity'],
    ['Unit Price', 'unitPrice'],
    ['Price Per', 'priceUnit'],
    ['Item Total', 'itemTotal'],
    ['Item Savings', 'savings'],
    ['Category', 'category'],
    ['Sold By', 'seller'],
    ['Status', 'status'],
    ['Product URL', 'productUrl'],
    ['Image URL', 'imageUrl'],
    ['Order URL', 'orderUrl'],
  ];

  const MONEY_KEYS = new Set(['subTotal', 'shipping', 'savings', 'coupon', 'giftCard', 'totalBeforeTax', 'tax', 'grandTotal', 'refundTotal', 'unitPrice', 'itemTotal']);

  /** Filter orders by inclusive YYYY-MM-DD bounds (either may be empty) and sort newest first. */
  function selectOrders(orderMap, from, to) {
    return Object.values(orderMap || {})
      .filter((o) => (!from || (o.orderDate && o.orderDate >= from)) && (!to || (o.orderDate && o.orderDate <= to)))
      .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '') || String(b.orderId).localeCompare(String(a.orderId)));
  }

  function orderRows(orders) {
    return orders.map((o) => {
      const names = (o.items && o.items.length ? o.items.map((i) => i.name) : o.itemPreview || []).filter(Boolean);
      const row = { ...o, itemNames: names.join('; ') };
      return ORDER_COLUMNS.map(([, k]) => cell(row[k], k));
    });
  }

  function itemRows(orders) {
    const rows = [];
    for (const o of orders) {
      for (const it of o.items || []) {
        const merged = { ...it, retailer: o.retailer, orderId: o.orderId, orderDate: o.orderDate, orderType: o.orderType, orderUrl: o.orderUrl };
        rows.push(ITEM_COLUMNS.map(([, k]) => cell(merged[k], k)));
      }
    }
    return rows;
  }

  function cell(v, key) {
    if (v === undefined || v === null) return '';
    if (MONEY_KEYS.has(key) && typeof v === 'number') return Math.round(v * 100) / 100;
    return v;
  }

  function csvEscape(v) {
    if (v === '' || v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection from product names etc.
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(header, rows) {
    // BOM so Excel opens UTF-8 correctly
    return '﻿' + [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }

  function buildCSVs(orders) {
    return {
      orders: toCSV(ORDER_COLUMNS.map((c) => c[0]), orderRows(orders)),
      items: toCSV(ITEM_COLUMNS.map((c) => c[0]), itemRows(orders)),
    };
  }

  /** Returns an ArrayBuffer for an .xlsx with "Order Data" and "Product Data" sheets. */
  function buildXLSX(orders, XLSX) {
    XLSX = XLSX || root.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) is not loaded');
    const wb = XLSX.utils.book_new();
    const add = (name, cols, rows, widths) => {
      const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c[0]), ...rows]);
      ws['!cols'] = cols.map(([h, k]) => ({ wch: widths[k] || Math.max(10, h.length + 2) }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: cols.length - 1 } }) };
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      // currency format on money columns
      cols.forEach(([, k], ci) => {
        if (!MONEY_KEYS.has(k)) return;
        for (let r = 1; r <= rows.length; r++) {
          const ref = XLSX.utils.encode_cell({ r, c: ci });
          if (ws[ref] && ws[ref].t === 'n') ws[ref].z = '$#,##0.00';
        }
      });
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add('Order Data', ORDER_COLUMNS, orderRows(orders), { orderUrl: 40, invoiceUrl: 30, paymentMethods: 24, orderId: 18 });
    add('Product Data', ITEM_COLUMNS, itemRows(orders), { name: 50, productUrl: 40, imageUrl: 30, orderUrl: 40, orderId: 18 });
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  function summarize(orders) {
    const total = orders.reduce((s, o) => s + (o.grandTotal || 0), 0);
    const tax = orders.reduce((s, o) => s + (o.tax || 0), 0);
    const items = orders.reduce((s, o) => s + (o.items ? o.items.length : 0), 0);
    const dates = orders.map((o) => o.orderDate).filter(Boolean).sort();
    return {
      orders: orders.length,
      items,
      total: Math.round(total * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      first: dates[0] || '',
      last: dates[dates.length - 1] || '',
      missingDetails: orders.filter((o) => !(o.items && o.items.length) || o.tax === null).length,
    };
  }

  const api = { ORDER_COLUMNS, ITEM_COLUMNS, selectOrders, buildCSVs, buildXLSX, summarize, toCSV };
  root.SCXExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
