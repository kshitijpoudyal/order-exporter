const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/retailers.js');
const N = require('../src/lib/normalize.js');
const E = require('../src/lib/export.js');
const XLSX = require('../vendor/xlsx.full.min.js');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('money parsing', () => {
  assert.equal(N.money('$1,234.56'), 1234.56);
  assert.equal(N.money('-$3.00'), -3);
  assert.equal(N.money('($2.00)'), -2);
  assert.equal(N.money({ value: 9.14 }), 9.14);
  assert.equal(N.money({ displayValue: '$5.10' }), 5.1);
  assert.equal(N.money('abc'), null);
});

test('date parsing', () => {
  assert.equal(N.toDate('2026-09-14T15:32:10.000Z'), '2026-09-14');
  assert.equal(N.toDate('09/02/2026'), '2026-09-02');
  assert.equal(N.toDate('Dec 3, 2025'), '2025-12-03');
  assert.equal(N.toDate('Placed on Oct 1, 2026'), '2026-10-01');
  assert.equal(N.toDate(1760000000), '2025-10-09');
});

test('online orders: totals, items, payment', () => {
  const orders = N.extractOrders(JSON.parse(fx('online-orders.json')), 'https://www.samsclub.com/orchestra/graphql/x');
  assert.equal(orders.length, 2);
  const [a, b] = orders;
  assert.equal(a.orderId, '2000123456789');
  assert.equal(a.orderDate, '2026-09-14');
  assert.equal(a.orderType, 'Delivery');
  assert.equal(a.subTotal, 152.38);
  assert.equal(a.tax, 9.14);
  assert.equal(a.grandTotal, 161.52);
  assert.equal(a.savings, 12);
  assert.equal(a.totalBeforeTax, 152.38);
  assert.equal(a.paymentMethods, "Sam's Club Mastercard ••4421");
  assert.equal(a.orderUrl, 'https://www.samsclub.com/orders/2000123456789');
  assert.equal(a.items.length, 3);
  assert.deepEqual(
    { name: a.items[0].name, n: a.items[0].itemNumber, q: a.items[0].quantity, u: a.items[0].unitPrice, t: a.items[0].itemTotal, c: a.items[0].category },
    { name: "Member's Mark Paper Towels, 15 ct.", n: '980012345', q: 2, u: 22.98, t: 45.96, c: 'Household' }
  );
  assert.equal(a.items[0].productUrl, 'https://www.samsclub.com/p/members-mark-paper-towels/prod123');
  assert.equal(a.items[2].unitPrice, 97.94); // derived from line total
  assert.equal(a.itemCount, 4);
  assert.equal(b.orderType, 'Pickup');
  assert.equal(b.items.length, 0);
  assert.equal(b.itemCount, 3);
});

test('in-club receipts with string money and tenders', () => {
  const [r] = N.extractOrders(JSON.parse(fx('club-receipts.json')));
  assert.equal(r.orderId, '1234567890123456');
  assert.equal(r.orderType, 'In-Club');
  assert.equal(r.orderDate, '2026-09-02');
  assert.equal(r.subTotal, 100);
  assert.equal(r.tax, 8.5);
  assert.equal(r.grandTotal, 108.5);
  assert.equal(r.paymentMethods, 'VISA ••1234');
  assert.equal(r.clubName, 'Shreveport Club #6431');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].unitPrice, 4.98);
  assert.equal(r.items[0].itemTotal, 9.96);
  assert.equal(r.items[1].itemTotal, 1.48);
  assert.equal(r.items[2].itemTotal, -2);
});

test('detail page __NEXT_DATA__ merges into list order', () => {
  const list = N.extractOrders(JSON.parse(fx('online-orders.json')));
  const html = fx('detail-page.html');
  const json = JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const detail = N.extractOrders(json, 'https://www.samsclub.com/orders/2000987654321');
  assert.equal(detail.length, 1);
  const map = {};
  N.mergeInto(map, list);
  const added = N.mergeInto(map, detail);
  assert.equal(added, 0);
  const o = map['2000987654321'];
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].quantity, 3);
  assert.equal(o.paymentMethods, 'Discover ••9090');
  assert.equal(o.invoiceUrl, 'https://www.samsclub.com/orders/2000987654321/receipt');
  assert.equal(o.orderDate, '2025-12-03');
});

test('non-order JSON is ignored', () => {
  const noise = { header: { cart: { itemCount: 3 } }, products: [{ name: 'TV', price: 499, id: 'abc12345' }], user: { id: '12345678' } };
  assert.equal(N.extractOrders(noise).length, 0);
});

test('CSV export: headers, filtering, formula-injection guard', () => {
  const map = {};
  N.mergeInto(map, N.extractOrders(JSON.parse(fx('online-orders.json'))));
  N.mergeInto(map, N.extractOrders(JSON.parse(fx('club-receipts.json'))));
  const sel = E.selectOrders(map, '2026-01-01', '2026-12-31');
  assert.deepEqual(sel.map((o) => o.orderId), ['2000123456789', '1234567890123456']);
  const { orders, items } = E.buildCSVs(sel);
  const oLines = orders.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(oLines.length, 3);
  assert.ok(oLines[0].startsWith('Retailer,Order Type,Order ID,TC Number,Order Date'));
  const iLines = items.trim().split('\r\n');
  assert.equal(iLines.length, 1 + 3 + 3);
  assert.ok(items.includes(`"'=HYPERLINK(""evil"") Coffee Pods, 100 ct."`));
});

test('XLSX export: two sheets with numeric money cells', () => {
  const map = {};
  N.mergeInto(map, N.extractOrders(JSON.parse(fx('online-orders.json'))));
  const buf = E.buildXLSX(E.selectOrders(map), XLSX);
  const wb = XLSX.read(buf, { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['Order Data', 'Product Data']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Order Data']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Grand Total'], 161.52);
  assert.equal(typeof rows[0]['Tax'], 'number');
  const items = XLSX.utils.sheet_to_json(wb.Sheets['Product Data']);
  assert.equal(items.length, 3);
});

test('plain `id` counts as order id inside an orders/receipts container; list cards need only id + date', () => {
  const json = { purchaseHistory: { orders: [{ id: 'ABC1234567', date: '2026-03-04' }, { id: 'X1', date: '2026-03-04' }] }, products: [{ id: 'P99999', date: '2026-01-01', name: 'TV' }] };
  const got = N.extractOrders(json);
  assert.deepEqual(got.map((o) => o.orderId), ['ABC1234567']);
  assert.equal(got[0].orderDate, '2026-03-04');
});

test('items carrying orderId + orderDate stay items', () => {
  const json = { orders: [{ orderId: '20001234', orderDate: '2026-01-02', items: [{ orderId: '20001234', orderDate: '2026-01-02', name: 'Soap', quantity: 1, price: 5 }] }] };
  const [o] = N.extractOrders(json);
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].name, 'Soap');
});

test('detail items with prices replace list items with the same count', () => {
  const list = { orderGroups: [{ orderId: '90001234', orderDate: '2026-09-20', items: [{ name: 'Milk', quantity: 2 }, { name: 'Eggs', quantity: 1 }] }] };
  const detail = { order: { id: '90001234', orderDate: '2026-09-20', priceDetails: { taxTotal: { value: 1 }, grandTotal: { value: 11 } },
    groups: [{ items: [
      { productInfo: { name: 'Milk', usItemId: '111' }, quantity: 2, priceInfo: { itemPrice: { value: 3 }, linePrice: { value: 6 } } },
      { productInfo: { name: 'Eggs', usItemId: '222' }, quantity: 1, priceInfo: { linePrice: { value: 4 } } },
    ] }] } };
  const map = {};
  N.mergeInto(map, N.extractOrders(list));
  N.mergeInto(map, N.extractOrders(detail));
  const items = map['90001234'].items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.name, i.itemNumber, i.unitPrice, i.itemTotal]), [['Milk', '111', 3, 6], ['Eggs', '222', 4, 4]]);
  // and in the other order (detail captured first)
  const map2 = {};
  N.mergeInto(map2, N.extractOrders(detail));
  N.mergeInto(map2, N.extractOrders(list));
  assert.equal(map2['90001234'].items[0].unitPrice, 3);
});
