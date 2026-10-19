// End-to-end: real Chromium + the unpacked extension against the mock samsclub.com.
// Usage: node tests/e2e/run.js [screenshotDir]
const { chromium } = require(require.resolve('playwright', { paths: ['/opt/npm-tools/node_modules'] }));
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const EXT = path.resolve(__dirname, '..', '..');
const shotDir = process.argv[2] || os.tmpdir();
const extId = [...crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(path.join(__dirname, 'key.pem'))) {
    require('node:child_process').execSync(
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=www.samsclub.com" -addext "subjectAltName=DNS:www.samsclub.com,DNS:www.walmart.com,DNS:www.costco.com"',
      { cwd: __dirname, stdio: 'ignore' }
    );
  }
  const server = require('./mock-server.js');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scx-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP www.samsclub.com:443 127.0.0.1:8443, MAP www.walmart.com:443 127.0.0.1:8443, MAP www.costco.com:443 127.0.0.1:8443',
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  try {
    const site = await ctx.newPage();
    site.on('pageerror', (e) => console.log('[site error]', e.message));
    await site.goto('https://www.samsclub.com/orders');
    await sleep(1500);

    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => console.log('[popup error]', e.message));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.samsclub.com/*' }))[0].id);
    // Data saved by v0.4 (single-store keys) must carry over to the per-retailer keys.
    await popup.evaluate(() => chrome.storage.local.set({ orders: { LEGACY12345: { orderId: 'LEGACY12345', orderDate: '2024-01-02', items: [], grandTotal: 5 } } }));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await popup.setViewportSize({ width: 340, height: 600 });
    const mig = await popup.evaluate(async () => chrome.storage.local.get(['orders', 'orders:samsclub']));
    assert.ok(!mig.orders && mig['orders:samsclub'] && mig['orders:samsclub'].LEGACY12345, 'v0.4 data migrated');
    await popup.evaluate(async () => {
      const k = 'orders:samsclub';
      const x = (await chrome.storage.local.get(k))[k];
      delete x.LEGACY12345;
      await chrome.storage.local.set({ [k]: x });
    });
    await sleep(500);
    assert.match(await popup.textContent('#connText'), /Sam's Club order history/);
    assert.equal(await popup.textContent('.chip.on'), "SCSam's Club", 'Sam\'s Club auto-selected from the tab');

    await popup.selectOption('#range', 'all');
    await popup.click('#scan');

    const deadline = Date.now() + 90_000;
    let st;
    while (Date.now() < deadline) {
      await sleep(1000);
      st = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'status' }, r)), tabId);
      process.stdout.write(`\r${st.progress}                    `);
      if (!st.scanning && /Done|Error|Stopped/.test(st.progress)) break;
    }
    console.log();
    assert.match(st.progress, /^Done/);

    const orders = await popup.evaluate(async () => (await chrome.storage.local.get('orders:samsclub'))['orders:samsclub']);
    const ids = Object.keys(orders).sort();
    console.log('orders:', ids.join(', '));
    assert.deepEqual(ids, ['1234567890123456', '2000123456789', '2000555000111', '2000987654321']);
    assert.equal(orders['2000987654321'].items.length, 1, 'SSR detail backfilled');
    assert.equal(orders['2000987654321'].paymentMethods, 'Discover ••9090');
    assert.equal(orders['2000555000111'].items.length, 1, 'client-rendered detail backfilled via iframe');
    assert.equal(orders['2000555000111'].tax, 5);
    assert.equal(orders['1234567890123456'].orderType, 'In-Club');
    assert.equal(orders['2000123456789'].items.length, 3);

    const xlsxBytes = await popup.evaluate(async () => {
      const orders = (await chrome.storage.local.get('orders:samsclub'))['orders:samsclub'];
      return SCXExport.buildXLSX(SCXExport.selectOrders(orders), XLSX).byteLength;
    });
    assert.ok(xlsxBytes > 5000);

    // ---- Scenario 2: Next-page navigation, generic ids, and old orders already saved ----
    await site.goto('https://www.samsclub.com/history');
    await sleep(1500);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await sleep(500);
    await popup.selectOption('#range', 'custom');
    await popup.fill('#from', '2026-01-01');
    await popup.fill('#to', '2026-12-31');
    await popup.uncheck('#details');
    await popup.click('#scan');
    const deadline2 = Date.now() + 90_000;
    while (Date.now() < deadline2) {
      await sleep(1000);
      st = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'status' }, r)), tabId).catch(() => null);
      if (st) process.stdout.write(`\r${st.progress}                    `);
      if (st && !st.scanning && /Done|Error|Stopped/.test(st.progress)) break;
    }
    console.log();
    assert.match(st.progress, /^Done/);
    const all = await popup.evaluate(async () => (await chrome.storage.local.get('orders:samsclub'))['orders:samsclub']);
    const paged = Object.keys(all).filter((k) => k.startsWith('P')).sort();
    console.log('paged orders:', paged.join(', '));
    assert.ok(['P1000123456', 'P1001123456', 'P2000123456', 'P2001123456'].every((id) => paged.includes(id)), 'followed Next to page 2');
    assert.equal(site.url(), 'https://www.samsclub.com/history?page=3', 'stopped after reaching orders older than the range');
    const report = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'debug' }, r)), tabId);
    assert.ok(report.embeddedJson.length >= 1 && !JSON.stringify(report).includes('2026-10-01'), 'debug report has shapes, no values');

    // ---- Scenario 3: Sam's Club "Glass" purchase history (buttons, yearless dates, Next page, SPA) ----
    await popup.evaluate(async (id) => {
      await chrome.storage.local.clear();
      await new Promise((r) => chrome.tabs.sendMessage(id, { type: 'cleared' }, r));
    }, tabId);
    await site.goto('https://www.samsclub.com/en/orders');
    await sleep(2000);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await sleep(500);
    await popup.selectOption('#range', 'all');
    await popup.click('#scan');
    const deadline3 = Date.now() + 150_000;
    while (Date.now() < deadline3) {
      await sleep(1000);
      st = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'status' }, r)), tabId).catch(() => null);
      if (st) process.stdout.write(`\r${st.progress}                    `);
      if (st && !st.scanning && /Done|Error|Stopped/.test(st.progress)) break;
    }
    console.log();
    assert.match(st.progress, /^Done — 6 orders/);
    const g = await popup.evaluate(async () => {
      const x = await chrome.storage.local.get(['orders:samsclub', 'detailTemplate:samsclub']);
      return { orders: x['orders:samsclub'], detailTemplate: x['detailTemplate:samsclub'] };
    });
    const { ORDERS } = require('./glass-mock.js');
    assert.deepEqual(Object.keys(g.orders).sort(), ORDERS.map((o) => o.id).sort());
    assert.equal(g.detailTemplate, 'https://www.samsclub.com/en/orders/{orderId}?storePurchase=true');
    const N = require('../../src/lib/normalize.js');
    let ref = '';
    for (const o of ORDERS) {
      const got = g.orders[o.id];
      if (o.date) {
        const exp = N.parseLooseDate(o.date, ref || undefined).date;
        ref = exp;
        assert.equal(got.orderDate, exp, `date for ${o.id}`);
      }
      assert.ok(got.items.length > 0 && got.grandTotal !== null, `details for ${o.id}`);
      for (const [k, it] of got.items.entries()) {
        const exp = k === 2 ? [1.38, 3.1, 'lb'] : [10, 10, ''];
        assert.deepEqual([it.unitPrice, it.itemTotal, it.priceUnit || ''], exp, `item ${k + 1} prices for ${o.id}`);
        assert.equal(it.itemNumber, `98000${k}`, 'item number filled in from the background data');
      }
      assert.equal(got.paymentMethods, 'Visa ••1111');
    }
    assert.equal(g.orders['04769673780265790079'].orderType, 'Fuel');
    assert.equal(g.orders['415142608087938010742'].orderType, 'Scan & Go');
    assert.equal(g.orders['415142608087938010742'].clubName, "Monroe Sam's Club");
    console.log('glass dates:', ORDERS.map((o) => g.orders[o.id].orderDate || '(none)').join(', '));

    // ---- Scenario 4: Walmart (auto-detected), list + details read from the page itself ----
    await site.goto('https://www.walmart.com/orders');
    await sleep(2000);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await sleep(800);
    assert.equal(await popup.textContent('.chip.on'), 'WWalmart', 'Walmart auto-selected from the tab');
    assert.ok(await popup.isVisible('#autoBadge'));
    assert.match(await popup.textContent('#connText'), /Walmart order history/);
    await popup.selectOption('#range', 'all');
    await popup.click('#scan');
    const deadline4 = Date.now() + 150_000;
    while (Date.now() < deadline4) {
      await sleep(1000);
      st = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'status' }, r)), tabId).catch(() => null);
      if (st) process.stdout.write(`\r${st.progress}                    `);
      if (st && !st.scanning && /Done|Error|Stopped/.test(st.progress)) break;
    }
    console.log();
    assert.match(st.progress, /^Done — 5 orders/);
    const W = require('./walmart-mock.js');
    const wo = await popup.evaluate(async () => (await chrome.storage.local.get('orders:walmart'))['orders:walmart']);
    assert.deepEqual(Object.keys(wo).sort(), W.ORDERS.map((o) => o.id).sort());
    const typeOf = { Delivery: 'Delivery', Shipping: 'Shipping', Store_purchase: 'In-Store', Pickup: 'Pickup' };
    for (const o of W.ORDERS) {
      const got = wo[o.id];
      assert.equal(got.orderType, typeOf[o.type], `type ${o.id}`);
      assert.equal(got.orderDate, N.toDate(o.purchase || o.orderDate), `date ${o.id}`);
      assert.equal(got.grandTotal, W.total(o), `total ${o.id}`);
      assert.equal(got.subTotal, W.sub(o), `subtotal ${o.id}`);
      assert.equal(got.tax, o.tax, `tax ${o.id}`);
      if (o.fee !== null) assert.equal(got.shipping, o.fee, `fee ${o.id}`);
      assert.equal(got.paymentMethods, 'Amex ••1006');
      if (o.purchase) assert.equal(got.clubName, 'Ruston N Service Rd E Supercenter');
      assert.equal(got.items.length, o.items.length, `items ${o.id}`);
      o.items.forEach((it, k) => {
        const gi = got.items[k];
        assert.equal(gi.name, it[0]);
        assert.equal(gi.itemNumber, it[3], 'item number from /ip/ link');
        assert.equal(gi.itemTotal, it[2], `line price ${it[0]}`);
        if (it[4]) assert.deepEqual([gi.quantity, gi.priceUnit, gi.unitPrice], [it[4], 'lb', Math.round((it[2] / it[4]) * 100) / 100], 'weighed item');
        else assert.equal(gi.unitPrice, Math.round((it[2] / it[1]) * 100) / 100);
      });
    }
    console.log('walmart dates:', W.ORDERS.map((o) => wo[o.id].orderDate).join(', '));

    await sleep(800);
    await popup.screenshot({ path: path.join(shotDir, 'popup-walmart.png'), fullPage: true });

    // ---- Scenario 5: Costco — tabs, "Showing" periods, receipt popups ----
    await site.goto('https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/ordersandpurchases');
    await sleep(1500);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
    await sleep(800);
    assert.equal(await popup.textContent('.chip.on'), 'CCostco', 'Costco auto-selected from the tab');
    await popup.selectOption('#range', 'ytd');
    await popup.click('#scan');
    const deadline5 = Date.now() + 150_000;
    while (Date.now() < deadline5) {
      await sleep(1000);
      st = await popup.evaluate((id) => new Promise((r) => chrome.tabs.sendMessage(id, { type: 'status' }, r)), tabId).catch(() => null);
      if (st) process.stdout.write(`\r${st.progress}                    `);
      if (st && !st.scanning && /Done|Error|Stopped/.test(st.progress)) break;
    }
    console.log();
    assert.match(st.progress, /^Done — 6 orders/, 'periods overlapping this year: 3 + 1 + 1 + 1 receipts');
    const C = require('./costco-mock.js');
    const co = await popup.evaluate(async () => (await chrome.storage.local.get('orders:costco'))['orders:costco']);
    assert.ok(!co['21136600300319120051011'], 'did not visit periods before this year');
    assert.equal(co['21136600300319120051010'].items.length, 0, 'Dec 2025 receipt listed but not opened (outside range)');
    for (const r of C.RECEIPTS.filter((x) => x.date.endsWith('2026'))) {
      const got = co[r.id];
      assert.ok(got, `receipt ${r.id}`);
      assert.equal(got.orderDate, N.toDate(r.date));
      assert.equal(got.orderType, r.type === 'Gas Station' ? 'Fuel' : 'In-Warehouse');
      assert.equal(got.subTotal, r.sub, `subtotal ${r.id}`);
      assert.equal(got.tax, r.tax, `tax ${r.id}`);
      assert.equal(got.grandTotal, r.total, `total ${r.id}`);
      assert.equal(got.paymentMethods, `${r.tender} ••${r.last4}`);
      assert.equal(got.itemCount, r.count);
      assert.match(got.clubName, new RegExp(r.wh, 'i'));
    }
    const main = co['21136600300319120051006'];
    assert.deepEqual(main.items.map((i) => [i.itemNumber, i.name, i.quantity, i.unitPrice, i.itemTotal, i.savings]), [
      ['647465', 'AVOCADOS', 1, 5.29, 5.29, null],
      ['30669', 'BANANAS', 1, 1.49, 1.49, null],
      ['221177', 'KS SOCKEYE', 2, 44.99, 89.98, null],
      ['1982447', 'KS DISH PACS', 1, 12.99, 12.99, null],
      ['1218891', 'COCONUT WATR', 1, 21.49, 21.49, 5.8],
    ]);
    assert.equal(main.savings, 5.8);
    const gas = co['21136600300319120051005'].items[0];
    assert.deepEqual([gas.name, gas.quantity, gas.unitPrice, gas.itemTotal], ['REGULAR', 12.345, 2.429, 29.98]);
    console.log('costco receipts:', Object.keys(co).length, 'saved;', Object.values(co).filter((o) => o.items.length).length, 'with items');

    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[retailers error]', e.message));
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`chrome-extension://${extId}/pages/retailers.html`);
    await sleep(1200);
    const counts = await page.$$eval('.rcard[data-retailer]', (els) => els.map((e) => [e.dataset.retailer, e.querySelector('.v-orders').textContent]));
    assert.deepEqual(counts, [['samsclub', '6'], ['walmart', '5'], ['costco', '6']]);
    await page.screenshot({ path: path.join(shotDir, 'retailers.png'), fullPage: true });

    await sleep(800);
    await popup.screenshot({ path: path.join(shotDir, 'popup.png'), fullPage: true });
    console.log('E2E PASS — xlsx bytes:', xlsxBytes);
  } finally {
    await ctx.close();
    server.close();
  }
})().catch((e) => {
  console.error('\nE2E FAIL:', e);
  process.exit(1);
});
