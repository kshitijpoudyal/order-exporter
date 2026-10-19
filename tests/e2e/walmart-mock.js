// Mock of walmart.com purchase history + order details, modelled on the real pages:
// - list: data-testid="order-N" cards wrapping orderGroup-N, caption id "caption-<id>-<Type>",
//   online orders show only delivery status, store purchases show "Oct 11, 2026 purchase",
//   "Order total $X", the card itself is clickable (no links), "Next page" button, SPA.
// - details: item tiles with a plain "$5.92" line price, "Qty 1" or "Wt 1.68 lb", /ip/ links,
//   items collapsed behind a toggle, and a text summary (Subtotal, Taxes, Total, card, store).
// - the background data has nothing usable, so everything must come from the page itself.
const ORDERS = [
  { id: '200014445550001', type: 'Delivery', status: 'Delivered Fri, Oct 16, 1:10pm', orderDate: 'Oct 14, 2026', items: [['Spatula Set of 2', 1, 9.8, '111111']], fee: 0, tax: 0.0 },
  { id: '200014445550002', type: 'Shipping', status: 'Now arrives tomorrow by 8pm', orderDate: 'Oct 12, 2026', items: [['Phone Case', 1, 12.0, '222222'], ['Screen Protector', 2, 7.5, '333333']], fee: 5.99, tax: 1.85 },
  { id: '78769202983749920343', type: 'Store_purchase', purchase: 'Oct 11, 2026', items: [['Fresh Turnip Greens, Bunch', 1, 1.57, '444444'], ['Fresh Roma Tomato, Each', null, 1.63, '555555', 1.68], ['Vital Farms Brown Eggs, 12 Ct', 1, 6.57, '666666']], fee: null, tax: 0.64 },
  // page 2
  { id: '40031234567890123420', type: 'Store_purchase', purchase: 'Oct 08, 2026', items: [['Rotisserie Chicken, 2.25 lb', 1, 5.97, '777777']], fee: null, tax: 0.0 },
  { id: '200014445550003', type: 'Pickup', status: 'Picked up Sep 20', orderDate: 'Sep 19, 2026', items: [['Paper Towels, 12 Rolls', 1, 18.97, '888888']], fee: 0, tax: 1.52 },
];
const PAGE_SIZE = 3;
const sub = (o) => Math.round(o.items.reduce((s, it) => s + it[2], 0) * 100) / 100;
const total = (o) => Math.round((sub(o) + (o.fee || 0) + o.tax) * 100) / 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const shell = (data) => `<!doctype html><html lang="en-US"><head><meta name="pageContext" content="yourOrders">
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"runtimeConfig":{}}</script></head>
<body><main data-testid="maincontent"><div id="root">Loading…</div></main>
<script>
const DATA = ${JSON.stringify(data)};
const root = document.getElementById('root');
const money = (n) => '$' + n.toFixed(2);
function card(o, i) {
  const date = o.purchase ? '<h2>' + o.purchase + ' purchase</h2>' : '<h2>' + o.status + '</h2>';
  const n = o.items.length;
  return '<div data-testid="order-' + i + '"><div data-testid="orderGroup-0"><section><span link-identifier="reviewDetails">' +
    '<div role="button" aria-label="' + o.type.replace('_', ' ') + ', ' + (o.status || o.purchase) + ', ' + n + ' item' + (n > 1 ? 's' : '') + '" data-oid="' + o.id + '">' +
    '<div aria-hidden="true"><div id="caption-' + o.id + '-' + o.type + '">' + o.type.replace('_', ' ') + '</div>' + date + '</div></div>' +
    '<div data-testid="collapsedItemList"><ul>' + o.items.map((it) => '<li><img alt="' + it[0] + '" src="data:,"></li>').join('') + '</ul></div>' +
    '</span></section></div><div>Order total ' + money(o.total) + '</div></div>';
}
async function renderList(page) {
  await fetch('/orchestra/cph/graphql/PurchaseHistoryV2/abc?page=' + page, { method: 'POST', body: '{}' });
  const slice = DATA.orders.slice((page - 1) * ${PAGE_SIZE}, page * ${PAGE_SIZE});
  const hasNext = page * ${PAGE_SIZE} < DATA.orders.length;
  root.innerHTML = '<h1>Purchase history</h1><div data-testid="ph-orders-results-section">' + slice.map(card).join('') + '</div>' +
    '<nav><button type="button" data-automation-id="previous-pages-button" aria-label="Previous page"' + (page <= 1 ? ' disabled' : '') + '>‹</button>' +
    '<button type="button" data-automation-id="next-pages-button" aria-label="Next page"' + (hasNext ? '' : ' disabled') + '>›</button></nav>';
  root.querySelectorAll('[role="button"][data-oid]').forEach((b) => (b.onclick = () => {
    const o = DATA.orders.find((x) => x.id === b.dataset.oid);
    history.pushState({}, '', '/orders/' + o.id + (o.purchase ? '?groupId=0&storePurchase=true' : '')); route();
  }));
  root.querySelector('[data-automation-id="next-pages-button"]').onclick = () => { history.pushState({}, '', '/orders?page=' + (page + 1)); route(); };
}
function tile(it) {
  const wt = it[4];
  return '<div data-testid="itemtile-stack"><div data-testid="product-image"><a href="/ip/' + it[0].replace(/\\W+/g, '-') + '/' + it[3] + '"><img data-testid="productTileImage" alt="" src="https://i5.walmartimages.com/asr/' + it[3] + '.jpeg"></a></div>' +
    '<div><a href="/ip/' + it[0].replace(/\\W+/g, '-') + '/' + it[3] + '" aria-label="' + it[0] + '"><div data-testid="productName"><span>' + it[0] + '</span></div></a>' +
    '<div data-testid="productDescription"></div><div> Shopped</div><div>' + (wt ? 'Wt ' + wt + ' lb' : 'Qty ' + it[1]) + '</div>' +
    '<div data-testid="line-price"><span aria-hidden="false">' + money(it[2]) + ' </span></div></div></div>';
}
async function renderDetail(id) {
  await fetch('/orchestra/cph/graphql/getOrder/abc', { method: 'POST', body: '{}' });
  const o = DATA.orders.find((x) => x.id === id);
  const n = o.items.length;
  const head = o.purchase ? o.purchase + ' purchase' : o.orderDate + ' order';
  root.innerHTML = '<div>Invoice</div><h1>' + head + '</h1>' + (o.purchase ? '<div>TC# ' + o.id.replace(/(\\d{4})/g, '$1-').replace(/-$/, '') + '</div>' : '<div>Order# ' + o.id + '</div>') +
    '<div data-testid="orderInfoCard"><div>' + o.type.replace('_', ' ') + '</div><div>' + head + '</div><div>' + n + '  items</div>' +
    '<button data-automation-id="items-toggle-link" aria-label="Show items" aria-expanded="false"></button>' +
    '<div data-testid="category-accordion-" id="tiles" style="display:none">' + o.items.map(tile).join('') + '</div></div>' +
    (o.purchase ? '<div>Store location</div><div>Ruston N Service Rd E Supercenter</div><div>1201 N SERVICE RD E, RUSTON, LA 71270</div>' : '') +
    '<div>Payment method</div><div>Payment method</div><div>Amex ending in 1006</div><div>Amex ending in 1006</div>' +
    '<div>Subtotal (' + n + ' items)</div><div>' + money(o.sub) + '</div>' +
    (o.fee !== null ? '<div>Delivery fee</div><div>' + (o.fee ? money(o.fee) : 'Free') + '</div>' : '') +
    '<div>Taxes</div><div>Taxes</div><div>' + money(o.tax) + '</div><div>Total</div><div>' + money(o.total) + '</div>';
  const tog = root.querySelector('[data-automation-id="items-toggle-link"]');
  tog.onclick = () => { tog.setAttribute('aria-expanded', 'true'); document.getElementById('tiles').style.display = 'block'; };
}
function route() {
  const m = location.pathname.match(/^\\/orders\\/(\\w+)/);
  if (m) renderDetail(m[1]); else renderList(Number(new URLSearchParams(location.search).get('page') || 1));
}
window.onpopstate = route;
route();
</script></body></html>`;

function handle(u, req, body, send) {
  if (u.pathname === '/orders' || /^\/orders\/\w+$/.test(u.pathname)) {
    const data = { orders: ORDERS.map((o) => ({ ...o, sub: sub(o), total: total(o) })) };
    return send(200, 'text/html', shell(data)), true;
  }
  if (u.pathname.startsWith('/orchestra/')) {
    // Background data with nothing order-shaped (prices only exist on the page).
    return send(200, 'application/json', JSON.stringify({ data: { header: { ok: true }, orderCount: ORDERS.length } })), true;
  }
  return false;
}
module.exports = { handle, ORDERS, sub, total };
