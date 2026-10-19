// Mock of amazon.com Your Orders, modelled on the real pages (fictional data):
// - list: /your-orders/orders?timeFilter=year-YYYY[&page=N], 10 ".order-card js-order-card"
//   per page with "Order placed / <date> / Total / $x / Ship to / … / Order # / <id>",
//   "View order details" + "View invoice" links, product titles linking /dp/<ASIN>,
//   a timeFilter <select>, and ".a-pagination .a-last a" for Next.
// - details: /your-orders/order-details?orderID= with data-component blocks
//   (orderDate, chargeSummary, purchasedItems > itemTitle / quantity / unitPrice).
// - invoice: /gp/css/summary/print.html?orderID= with the payment card.
const mk = (n, date, items, ship = 0, taxRate = 0.11) => {
  const sub = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  const tax = Math.round(sub * taxRate * 100) / 100;
  return { id: `1${String(n).padStart(2, '0')}-1234567-76543${String(n).padStart(2, '0')}`, date, items, sub, ship, tax, total: Math.round((sub + ship + tax) * 100) / 100 };
};
const it = (name, asin, price, qty = 1) => ({ name, asin, price, qty });
const ORDERS = [
  mk(1, 'October 18, 2026', [it('Poker Chip Set with Travel Case', 'B0B2449PWP', 44.99)]),
  mk(2, 'October 15, 2026', [it('USB-C Cable 2-Pack', 'B0C1111111', 9.99, 2)]),
  mk(3, 'October 13, 2026', [it('Desk Lamp', 'B0C2222222', 39.99), it('LED Bulbs 4pk', 'B0C3333333', 12.49)], 5.99),
  mk(4, 'October 3, 2026', [it('Notebook', 'B0C4444444', 6.5)]),
  mk(5, 'September 28, 2026', [it('Coffee Beans 2lb', 'B0C5555555', 18.0)]),
  mk(6, 'September 20, 2026', [it('Phone Stand', 'B0C6666666', 14.99)]),
  mk(7, 'September 2, 2026', [it('Batteries AA 24pk', 'B0C7777777', 15.49)]),
  mk(8, 'August 30, 2026', [it('Water Filter', 'B0C8888888', 29.99)]),
  mk(9, 'August 11, 2026', [it('Yoga Mat', 'B0C9999999', 25.0)]),
  mk(10, 'July 4, 2026', [it('Sunscreen', 'B0CAAAAAAA', 11.97)]),
  mk(11, 'March 1, 2026', [it('Rain Jacket', 'B0CBBBBBBB', 59.99)]),
  mk(12, 'January 9, 2026', [it('Calendar 2026', 'B0CCCCCCCC', 13.5)]),
  mk(13, 'December 20, 2025', [it('Gift Wrap', 'B0CDDDDDDD', 8.99)]),
  mk(14, 'June 6, 2025', [it('Garden Hose', 'B0CEEEEEEE', 34.99)]),
];
const yearOf = (o) => o.date.slice(-4);
const money = (n) => '$' + n.toFixed(2);

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>
<header><span>Hello, Test User</span></header><main>${body}</main></body></html>`;

function listPage(year, pageNo) {
  const all = ORDERS.filter((o) => yearOf(o) === String(year));
  const slice = all.slice(pageNo * 10, pageNo * 10 + 10);
  const cards = slice.map((o) => `
  <div class="order-card js-order-card"><div class="order-header"><ul class="order-header__header-list">
    <li class="order-header__header-list-item"><span class="a-text-caps">Order placed</span><span>${o.date}</span></li>
    <li class="order-header__header-list-item"><span class="a-text-caps">Total</span><span>${money(o.total)}</span></li>
    <li class="order-header__header-list-item"><div class="yohtmlc-recipient"><span>Ship to</span><span>Test User</span><div>1 Main St</div></div></li>
    <li class="order-header__header-list-item"><div class="yohtmlc-order-id"><span class="a-text-caps">Order #</span> <span dir="ltr">${o.id}</span></div>
      <a href="/your-orders/order-details?orderID=${o.id}&amp;ref=ppx_yo2ov_dt_b_fed_order_details"> View order details </a>
      <a href="/gp/css/summary/print.html?orderID=${o.id}&amp;ref=ppx_yo2ov_dt_b_fed_invoice_pos"> View invoice </a></li></ul></div>
    <div class="yohtmlc-shipment-status-primaryText">Delivered ${o.date.replace(/, \d{4}$/, '')}</div>
    ${o.items.map((i) => `<div class="item-box"><a href="/dp/${i.asin}?ref_=x"><img alt="${i.name}"></a><div class="yohtmlc-product-title"><a href="/dp/${i.asin}?ref_=y">${i.name}</a></div><a>Buy it again</a></div>`).join('')}
  </div>`).join('');
  const hasNext = (pageNo + 1) * 10 < all.length;
  const select = `<form class="js-time-filter-form"><select name="timeFilter" id="time-filter"><option value="last30">past 30 days</option><option value="months-3">past 3 months</option><option value="year-2026"${year == 2026 ? ' selected' : ''}>2026</option><option value="year-2025"${year == 2025 ? ' selected' : ''}>2025</option></select></form>`;
  const pag = `<ul class="a-pagination"><li class="a-normal"><a href="/your-orders/orders?page=0">1</a></li>${hasNext ? `<li class="a-last"><a href="/your-orders/orders?page=${pageNo + 1}&amp;ref_=ppx_pagination">Next<span>→</span></a></li>` : '<li class="a-disabled a-last">Next<span>→</span></li>'}</ul>`;
  return page('Your Orders', `<div class="your-orders-content-container">${select}${cards}${pag}</div>`);
}

function detailsPage(o) {
  const items = o.items.map((i) => `
  <div data-component="purchasedItems"><div data-component="itemImage"><a href="/dp/${i.asin}?ref_=img"><img alt="${i.name}" src="data:," data-a-hires="https://m.media-amazon.com/images/I/${i.asin}.jpg"></a></div>
    <div data-component="itemTitle"><div class="a-row"><a class="a-link-normal" href="/dp/${i.asin}?ref_=title">${i.name}</a></div></div>
    <div data-component="orderedMerchant"><span>Sold by: <a href="/gp/aag/main?seller=X">Test Seller</a></span></div>
    <div data-component="quantity"><span class="a-size-small">${i.qty > 1 ? i.qty : ''}</span></div>
    <div data-component="unitPrice"><span class="a-price"><span class="a-offscreen">${money(i.price)}</span><span aria-hidden="true">${money(i.price)}</span></span></div>
  </div>`).join('');
  return page('Order Details', `<div data-component="orderDate"><span>${o.date}</span></div>
  <div data-component="orderId"><span>${o.id}</span></div>
  <div data-component="shippingAddress"><div>Ship to</div><div>Test User</div></div>
  <h5>Payment method</h5><div id="upx-nextjs-scripts"></div>
  <div data-component="chargeSummary"><div>Order Summary</div>
    <div class="od-line-item-row"><span>Item(s) Subtotal:</span><span>${money(o.sub)}</span></div>
    <div class="od-line-item-row"><span>Shipping &amp; Handling:</span><span>${money(o.ship)}</span></div>
    <div class="od-line-item-row"><span>Total before tax:</span><span>${money(o.sub + o.ship)}</span></div>
    <div class="od-line-item-row"><span>Estimated tax to be collected:</span><span>${money(o.tax)}</span></div>
    <div class="od-line-item-row"><span>Grand Total:</span><span>${money(o.total)}</span></div></div>
  <div data-component="shipments"><div data-component="shipmentStatus">Delivered</div>${items}</div>`);
}

function invoicePage(o) {
  return page('Amazon.com - Order ' + o.id, `<b>Final Details for Order #${o.id}</b>
  <table><tr><td>Order Placed: ${o.date}</td></tr><tr><td>Amazon.com order number: ${o.id}</td></tr>
  <tr><td>Order Total: ${money(o.total)}</td></tr></table>
  <table><tr><td><b>Payment Method:</b></td></tr><tr><td>Visa | Last digits: 4242</td></tr>
  <tr><td>Item(s) Subtotal: ${money(o.sub)}</td></tr><tr><td>Grand Total: ${money(o.total)}</td></tr></table>`);
}

function handle(u, req, body, send) {
  if (u.pathname === '/your-orders/orders') {
    const tf = u.searchParams.get('timeFilter') || 'year-2026';
    const year = (tf.match(/year-(\d{4})/) || [, '2026'])[1];
    return send(200, 'text/html', listPage(year, Number(u.searchParams.get('page') || 0))), true;
  }
  const o = ORDERS.find((x) => x.id === u.searchParams.get('orderID'));
  if (u.pathname === '/your-orders/order-details' && o) return send(200, 'text/html', detailsPage(o)), true;
  if (u.pathname === '/gp/css/summary/print.html' && o) return send(200, 'text/html', invoicePage(o)), true;
  return false;
}
module.exports = { handle, ORDERS };
