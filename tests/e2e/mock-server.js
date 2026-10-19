// Mock www.samsclub.com for end-to-end tests. Serves an order-history page that loads
// orders over fetch with a "Load more" button, an SSR detail page (__NEXT_DATA__) and a
// client-rendered detail page (forces the extension's iframe fallback).
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const fx = (f) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');
const pages = {
  1: fx('online-orders.json'),
  2: JSON.stringify({
    data: {
      receipts: JSON.parse(fx('club-receipts.json')).payload.receipts,
      orders: [{ orderId: '2000555000111', orderDate: '2026-08-20T12:00:00Z', type: 'SHIPPING', priceDetails: { grandTotal: { value: 64.99 } }, itemCount: 1 }],
    },
  }),
  3: JSON.stringify({ data: { orders: [] } }),
};

const listHtml = `<!doctype html><html><head><title>Purchase history</title></head><body>
<h1>Purchase history</h1><ul id="list"></ul><button id="more">Load more</button>
<script>
let page = 1;
async function load() {
  const r = await fetch('/orchestra/cph/graphql/PurchaseHistory?page=' + page, { headers: { accept: 'application/json' } });
  const j = await r.json();
  const ids = JSON.stringify(j).match(/"(orderId|tcNumber)":"(\\d+)"/g) || [];
  if (!ids.length) document.getElementById('more').remove();
  for (const m of ids) {
    const id = m.split(':')[1].replace(/"/g, '');
    const li = document.createElement('li');
    li.innerHTML = '<a href="/orders/' + id + '">Order ' + id + '</a>';
    document.getElementById('list').appendChild(li);
  }
  page++;
}
document.getElementById('more').onclick = load;
load();
</script></body></html>`;

const clientDetailHtml = (id) => `<!doctype html><html><body><div id="app">Loading…</div>
<script>
fetch('/orchestra/api/order-details?orderId=${id}').then(r => r.json()).then(j => { document.getElementById('app').textContent = 'Order ' + j.order.orderId; });
</script></body></html>`;

const glass = require('./glass-mock.js');
const walmart = require('./walmart-mock.js');
const costco = require('./costco-mock.js');

const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem')) }, (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => route(req, res, body));
});

function route(req, res, body) {
  const u = new URL(req.url, 'https://www.samsclub.com');
  const send = (code, type, b) => {
    res.writeHead(code, { 'content-type': type });
    res.end(b);
  };
  if (/costco\.com/.test(req.headers.host || '')) {
    if (!costco.handle(u, req, body, send)) send(404, 'text/plain', 'not found');
    return;
  }
  if (/walmart\.com/.test(req.headers.host || '')) {
    if (!walmart.handle(u, req, body, send)) send(404, 'text/plain', 'not found');
    return;
  }
  if (glass.handle(u, req, body, send)) return;
  if (u.pathname === '/orders') return send(200, 'text/html', listHtml);
  // Scenario 2: server-rendered pages, plain `id` fields, list cards without totals, "Next" link navigation.
  if (u.pathname === '/history') {
    const page = Number(u.searchParams.get('page') || 1);
    const dates = { 1: ['2026-10-01', '2026-07-15'], 2: ['2026-05-02', '2026-02-20'], 3: ['2025-11-30', '2025-06-01'] }[page] || [];
    const orders = dates.map((d, i) => ({ id: `P${page}00${i}123456`, date: d, fulfillment: 'Shipping' }));
    const data = { props: { pageProps: { purchaseHistory: { orders } } } };
    const next = page < 3 ? `<a href="/history?page=${page + 1}" aria-label="Next page">›</a>` : '';
    return send(200, 'text/html', `<!doctype html><html><body><ul>${orders.map((o) => `<li><a href="/orders/${o.id}">Order</a></li>`).join('')}</ul><nav>${next}</nav>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`);
  }
  if (u.pathname === '/orchestra/cph/graphql/PurchaseHistory') return send(200, 'application/json', pages[u.searchParams.get('page')] || pages[3]);
  if (u.pathname === '/orders/2000987654321') return send(200, 'text/html', fx('detail-page.html'));
  if (u.pathname === '/orders/2000555000111') return send(200, 'text/html', clientDetailHtml('2000555000111'));
  if (u.pathname === '/orchestra/api/order-details') {
    return send(200, 'application/json', JSON.stringify({
      order: {
        orderId: u.searchParams.get('orderId'), orderDate: '2026-08-20T12:00:00Z', type: 'SHIPPING',
        priceDetails: { subTotal: { value: 59.99 }, shippingTotal: { value: 0 }, taxTotal: { value: 5.0 }, grandTotal: { value: 64.99 } },
        items: [{ name: 'Member’s Mark Office Chair', quantity: 1, priceInfo: { linePrice: { value: 59.99 } }, itemNumber: '777' }],
      },
    }));
  }
  // order detail pages for orders that already have full data
  if (u.pathname.startsWith('/orders/')) return send(200, 'text/html', '<html><body>detail</body></html>');
  send(404, 'text/plain', 'not found');
}
server.listen(8443, '127.0.0.1', () => console.log('mock samsclub + walmart on 8443'));
module.exports = server;
