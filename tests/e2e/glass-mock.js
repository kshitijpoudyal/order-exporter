// Mock of Sam's Club's current purchase-history UI (Walmart "Glass"), modelled on a real
// page's structure: order cards as [data-testid="orderGroup-N"], "See details" buttons
// (no links), yearless "Purchased on Tue, Dec 2" dates, "Next page" button, SPA routing,
// and data loaded by GraphQL after the page renders. Detail ids differ from list ids.
const ORDERS = [
  // page 1 (newest first). Today in the test is whatever the clock says; dates are yearless.
  { id: '18943552592676515443', type: 'In club', date: null, status: 'Refund issued', n: 1 },
  { id: '04769673780265790079', type: 'Fuel', date: 'Tue, Dec 2', n: 1 },
  { id: '415142608087938010742', type: 'Scan & Go', date: 'Tue, Dec 2', n: 6 },
  { id: '03396973429304401526', type: 'In club', date: 'Mon, Nov 3', n: 12 },
  // page 2
  { id: '374565115982487959295', type: 'Scan & Go', date: 'Wed, Oct 15', n: 5 },
  { id: '76131867156895306611', type: 'Fuel', date: 'Mon, Oct 6', n: 1 },
];
const PAGE_SIZE = 4;

const shell = `<!doctype html><html lang="en-US"><head><meta name="pageContext" content="yourOrders">
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"bootstrapData":{}}},"runtimeConfig":{}}</script></head>
<body><main id="maincontent"><h1>Purchase history</h1><div id="root">Loading…</div></main>
<script>
const root = document.getElementById('root');
async function gql(op, vars) {
  const r = await fetch('/orchestra/cph/graphql/' + op + '/abc123', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variables: vars }) });
  return r.json();
}
async function renderList(page) {
  const j = await gql('PurchaseHistoryV2', { page });
  const groups = j.data.orderHistoryV2.orderGroups;
  root.innerHTML = groups.map((g, i) => \`
    <div data-testid="orderGroup-\${i}"><div><h2><span>TC \${g.tcDisplay}</span></h2>
      <button type="button" data-automation-id="view-order-details-link-\${g.orderId}" aria-label="View details for order number \${g.orderId}">See details</button></div>
      <section><div class="f6" id="caption-\${g.orderId}-x">\${g.caption}</div><div>TC \${g.tcDisplay}</div>
      \${g.dateText ? '<h3>Purchased on ' + g.dateText + '</h3>' : ''}\${g.statusText ? '<div>' + g.statusText + '</div>' : ''}
      <div data-testid="collapsedItemList"><span>\${g.itemCount} item\${g.itemCount > 1 ? 's' : ''}</span>
      <ul>\${g.items.map((it) => '<li><img alt="' + it.name + '" src="data:,"></li>').join('')}</ul></div></section></div>\`).join('') +
    \`<nav><button type="button" data-automation-id="previous-pages-button" aria-label="Previous page" \${page <= 1 ? 'disabled' : ''}>‹</button>
     <button type="button" data-automation-id="next-pages-button" aria-label="Next page" \${j.data.orderHistoryV2.pageInfo.hasNext ? '' : 'disabled'}>›</button></nav>\`;
  root.querySelectorAll('[data-automation-id^="view-order-details-link-"]').forEach((b) => b.onclick = () => {
    const id = b.getAttribute('data-automation-id').replace('view-order-details-link-', '');
    history.pushState({}, '', '/en/orders/' + id + '?storePurchase=true'); route();
  });
  const next = root.querySelector('[data-automation-id="next-pages-button"]');
  next.onclick = () => { history.pushState({}, '', '/en/orders?page=' + (page + 1)); route(); };
}
async function renderDetail(id) {
  const j = await gql('getOrder', { orderId: id });
  const o = j.data.order;
  // Item tiles, structured like the real details page (prices only here, not in the data).
  const tile = (it, k) => {
    const weighted = k === 2;
    const unit = weighted ? '$1.38/lb' : '$10.00';
    const line = weighted ? ['3', '10'] : ['10', '00'];
    return '<div data-testid="itemtile-stack"><div data-testid="product-image"><a href=""><img data-testid="productTileImage" alt="" src="https://scene7.samsclub.com/is/image/samsclub/000' + k + '_A"></a></div>' +
      '<div><a href="" aria-label="' + it.productInfo.name + '"><div data-testid="productName"><span>' + it.productInfo.name + '</span></div></a>' +
      '<div data-testid="productDescription"><div>' + unit + '</div></div><div>Qty ' + it.quantity + '</div>' +
      '<div data-testid="line-price"><span aria-hidden="false"><span></span><span>$</span><span>' + line[0] + '</span><span>' + line[1] + '</span></span></div></div></div>';
  };
  root.innerHTML = '<h2>Order ' + o.displayId + '</h2><button onclick="history.back()">Back</button>' +
    '<div data-testid="orderInfoCard"><div>Scan &amp; Go</div><div>Store location</div><div>Monroe Sam&#39;s Club</div></div>' +
    '<button data-automation-id="items-toggle-link" aria-expanded="false"></button>' +
    '<div data-testid="category-accordion-" id="tiles" style="display:none">' + o.groups[0].items.map(tile).join('') + '</div>';
  const tog = root.querySelector('[data-automation-id="items-toggle-link"]');
  tog.onclick = () => { tog.setAttribute('aria-expanded', 'true'); document.getElementById('tiles').style.display = 'block'; };
}
function route() {
  const m = location.pathname.match(/^\\/en\\/orders\\/(\\w+)/);
  if (m) renderDetail(m[1]); else renderList(Number(new URLSearchParams(location.search).get('page') || 1));
}
window.onpopstate = route;
route();
</script></body></html>`;

function handle(u, req, body, send) {
  if (u.pathname === '/en/orders' || /^\/en\/orders\/\w+$/.test(u.pathname)) return send(200, 'text/html', shell), true;
  if (u.pathname.startsWith('/orchestra/cph/graphql/PurchaseHistoryV2')) {
    const page = JSON.parse(body || '{}').variables?.page || 1;
    const slice = ORDERS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return send(200, 'application/json', JSON.stringify({
      data: { orderHistoryV2: {
        pageInfo: { hasNext: page * PAGE_SIZE < ORDERS.length },
        // list entries: id + items, no machine-readable date, no totals
        orderGroups: slice.map((o) => ({
          orderId: o.id, caption: o.type, tcDisplay: o.id.replace(/(\d{4})/g, '$1 ').trim(), dateText: o.date, statusText: o.status || '',
          itemCount: o.n, items: Array.from({ length: Math.min(o.n, 3) }, (_, k) => ({ name: `Product ${k + 1}`, quantity: 1 })),
        })),
      } },
    })), true;
  }
  if (u.pathname.startsWith('/orchestra/cph/graphql/getOrder')) {
    const id = JSON.parse(body || '{}').variables?.orderId;
    const o = ORDERS.find((x) => x.id === id) || ORDERS[0];
    return send(200, 'application/json', JSON.stringify({
      data: { order: {
        id: 'D' + id.slice(0, 12), displayId: 'D' + id.slice(0, 12), type: 'IN_STORE',
        orderDate: null,
        priceDetails: { subTotal: { value: 10 * o.n }, taxTotal: { value: 0.8 * o.n }, grandTotal: { value: 10.8 * o.n } },
        paymentMethods: [{ displayName: 'Visa', lastFour: '1111' }],
        // Like the real site: the background data has items but no usable per-item prices.
        groups: [{ items: Array.from({ length: Math.min(o.n, 3) }, (_, k) => ({ productInfo: { name: `Product ${k + 1}`, usItemId: `98000${k}` }, quantity: 1 })) }],
      } },
    })), true;
  }
  return false;
}
module.exports = { handle, ORDERS };
