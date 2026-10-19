// Mock of costco.com "Orders & Purchases" (/myaccount/#/app/<id>/ordersandpurchases),
// modelled on the real page: Online / In-Warehouse tabs (automation-id), a "Showing"
// <select> of 3-month periods, receipt cards id="viewRecieptBtn_<barcode>", and a
// "View Receipt" popup (role=dialog) whose table holds the receipt lines.
const RECEIPTS = [
  {
    id: '21136600300319120051005', period: 0, type: 'Gas Station', date: '10/05/2026', time: '02:59pm', wh: 'Ridgeland',
    lines: [['qty', '12.345 GAL @ 2.429'], ['', '1', 'REGULAR', '29.98 N']], sub: 29.98, tax: 0, total: 29.98, tender: 'COSTCO VISA', last4: '3796', count: 1,
  },
  {
    id: '21136600300319120051006', period: 0, type: 'In-Warehouse', date: '10/05/2026', time: '02:47pm', wh: 'RIDGELAND',
    lines: [
      ['E', '647465', 'AVOCADOS', '5.29 2'],
      ['E', '30669', 'BANANAS', '1.49 2'],
      ['qty', '2 @ 44.99'],
      ['E', '221177', 'KS SOCKEYE', '89.98 2'],
      ['', '1982447', 'KS DISH PACS', '12.99 Y'],
      ['E', '1218891', 'COCONUT WATR', '21.49 2'],
      ['', '390140', '/1218891', '5.80-'],
    ],
    sub: 125.44, tax: 1.97, total: 127.41, tender: 'COSTCO VISA', last4: '3796', count: 6, savings: 5.8,
  },
  {
    id: '21136600300319120051007', period: 0, type: 'In-Warehouse', date: '08/19/2026', time: '10:41am', wh: 'SOUTHLAKE',
    lines: [['E', '12345', 'KS WATER 40PK', '4.99 2'], ['', '67890', 'PAPER TOWEL', '24.99 Y']], sub: 29.98, tax: 2.4, total: 32.38, tender: 'DEBIT', last4: '1111', count: 2,
  },
  { id: '21136600300319120051008', period: 1, type: 'In-Warehouse', date: '06/02/2026', time: '11:00am', wh: 'RIDGELAND', lines: [['E', '11111', 'ROTISSERIE CHKN', '4.99 2']], sub: 4.99, tax: 0, total: 4.99, tender: 'COSTCO VISA', last4: '3796', count: 1 },
  { id: '21136600300319120051009', period: 2, type: 'In-Warehouse', date: '03/03/2026', time: '09:15am', wh: 'RIDGELAND', lines: [['', '22222', 'TV 65IN', '499.99 Y']], sub: 499.99, tax: 40.0, total: 539.99, tender: 'COSTCO VISA', last4: '3796', count: 1 },
  { id: '21136600300319120051010', period: 3, type: 'In-Warehouse', date: '12/20/2025', time: '05:30pm', wh: 'RIDGELAND', lines: [['E', '33333', 'HAM', '30.00 2']], sub: 30, tax: 0, total: 30, tender: 'COSTCO VISA', last4: '3796', count: 1 },
  { id: '21136600300319120051011', period: 4, type: 'In-Warehouse', date: '09/01/2025', time: '05:30pm', wh: 'RIDGELAND', lines: [['E', '44444', 'MILK', '3.00 2']], sub: 3, tax: 0, total: 3, tender: 'COSTCO VISA', last4: '3796', count: 1 },
];
const PERIODS = ['Last 3 Months', '2026 May - July', '2026 February - April', '2026 November - January', '2025 August - October', '2025 May - July'];

const page = `<!doctype html><html lang="en-US"><head><title>Orders &amp; Purchases | Costco</title></head>
<body><main><div id="app">Loading…</div></main>
<script>
const RECEIPTS = ${JSON.stringify(RECEIPTS)};
const PERIODS = ${JSON.stringify(PERIODS)};
const app = document.getElementById('app');
let tab = 'online';
let period = 0;
function render() {
  app.innerHTML =
    '<div role="tablist"><button role="tab" automation-id="myOnlineOrdersTab" aria-selected="' + (tab === 'online') + '">Online</button>' +
    '<button role="tab" automation-id="myWarehouseOrdersTab" aria-selected="' + (tab === 'warehouse') + '">In-Warehouse</button>' +
    '<button role="tab" automation-id="homeImprovementTab" aria-selected="false">Home Improvement</button></div><div id="panel"></div>';
  app.querySelector('[automation-id="myOnlineOrdersTab"]').onclick = () => { tab = 'online'; render(); };
  app.querySelector('[automation-id="myWarehouseOrdersTab"]').onclick = () => { tab = 'warehouse'; render(); };
  const panel = document.getElementById('panel');
  if (tab === 'online') { panel.innerHTML = '<p>You have no online orders in this period.</p>'; return; }
  panel.innerHTML = '<div>Your receipts will appear within 24 hours of the transaction.</div><label for="Showing">Showing</label>' +
    '<select id="Showing" name="Showing">' + PERIODS.map((p, i) => '<option' + (i === period ? ' selected' : '') + '>' + p + '</option>').join('') + '</select><div id="cards">Loading…</div>';
  const sel = document.getElementById('Showing');
  sel.addEventListener('change', () => { period = sel.selectedIndex; loadCards(); });
  loadCards();
}
async function loadCards() {
  const box = document.getElementById('cards');
  box.textContent = 'Loading…';
  await new Promise((r) => setTimeout(r, 300)); // like the real data request
  const list = RECEIPTS.filter((r) => r.period === period);
  box.innerHTML = list.map((r) =>
    '<div id="viewRecieptBtn_' + r.id + '"><div><div automation-id="In-Warehouse"><div>' + r.type + '</div><div>' + r.date + ' - ' + r.time + '</div><div>' + r.wh + '</div></div>' +
    '<div><span automation-id="totalText">Total</span><span automation-id="totalPrice">$' + r.total.toFixed(2) + '</span></div>' +
    '<button automation-id="ViewInWareHouseReciept">View Receipt</button></div></div>').join('') || '<p>No receipts.</p>';
  box.querySelectorAll('[automation-id="ViewInWareHouseReciept"]').forEach((b) => (b.onclick = () => openReceipt(b.closest('[id^="viewRecieptBtn_"]').id.slice(15))));
}
function td(t, attrs) { return '<td' + (attrs || '') + '>' + t + '</td>'; }
function openReceipt(id) {
  const r = RECEIPTS.find((x) => x.id === id);
  const rows = r.lines.map((l) => l[0] === 'qty' ? '<tr>' + td(l[1], ' colspan="2"') + '</tr>' : '<tr>' + td(l[0]) + td(l[1]) + td(l[2]) + td(l[3]) + '</tr>').join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = '<div role="dialog" aria-labelledby="alert-dialog-title"><div><button aria-label="Close">×</button></div>' +
    '<h2 id="alert-dialog-title" automation-id="modalTitle">' + (r.type === 'Gas Station' ? 'Gas Station' : 'In-Warehouse') + ' Receipt</h2>' +
    '<div data-private="true"><div>' + r.wh + ' #1366</div><div>700 HIGHLAND COLONY PKWY</div><div>RIDGELAND, MS 39157</div><div>' + r.id + '</div></div>' +
    '<table aria-label="spanning table"><thead><tr><th colspan="4">Member #</th></tr></thead><tbody>' + rows +
    '<tr>' + td('', ' colspan="2"') + td('SUBTOTAL') + td(r.sub.toFixed(2)) + '</tr>' +
    '<tr>' + td('', ' colspan="2"') + td('TAX') + td('<span>' + r.tax.toFixed(2) + '</span>') + '</tr>' +
    '<tr>' + td('') + td('****') + td('Total') + td(r.total.toFixed(2)) + '</tr>' +
    '<tr>' + td('XXXXXXXXXXXXX' + r.last4, ' colspan="3"') + td('CHIP read') + '</tr>' +
    '<tr>' + td('APPROVED - PURCHASE', ' colspan="3"') + td('') + '</tr>' +
    '<tr>' + td('<span class="date">' + r.date + '</span><span class="time">14:47</span>', ' colspan="5"') + '</tr>' +
    '<tr>' + td(r.tender, ' class="visa" colspan="3"') + td(r.total.toFixed(2), ' class="visano"') + '</tr>' +
    '<tr>' + td('Change', ' class="visa"') + td('0', ' colspan="3"') + '</tr>' +
    '<tr>' + td('') + td('TOTAL TAX', ' colspan="2"') + td(r.tax.toFixed(2)) + '</tr>' +
    '<tr>' + td('TOTAL NUMBER OF ITEMS SOLD = ' + r.count, ' colspan="5"') + '</tr>' +
    (r.savings ? '<tr>' + td('INSTANT SAVINGS', ' colspan="3"') + td('$' + r.savings.toFixed(2)) + '</tr>' : '') +
    '</tbody></table></div>';
  document.body.appendChild(wrap);
  wrap.querySelector('button[aria-label="Close"]').onclick = () => wrap.remove();
}
render();
</script></body></html>`;

function handle(u, req, body, send) {
  if (u.pathname === '/myaccount/' || u.pathname === '/myaccount') return send(200, 'text/html', page), true;
  return false;
}
module.exports = { handle, RECEIPTS, PERIODS };
