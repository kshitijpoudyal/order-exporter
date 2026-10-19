# Order History Exporter

A Chrome extension that exports your order history from **Sam's Club**, **Walmart** and
**Costco** — online orders, pickup, delivery, in-store/in-club/in-warehouse receipts and gas
station purchases — to **Excel (.xlsx)** or **CSV**. Everything runs in your browser; no accounts, no servers, no passwords.

More stores are planned (see the Retailers page). Adding one is mostly configuration in
`src/retailers.js`.

## Install (unpacked)

1. Unzip, then open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension. Reload any Sam's Club / Walmart / Costco tabs that were already open.

## Use

1. Sign in and open your order history (the popup has a button for it).
2. Click the extension icon. The retailer is **picked automatically** from the site you're
   on; you can switch with the retailer chips.
3. Pick a date range and click **Scan orders**. It pages through your order list, then (with
   *Include details* on) opens each order in the background to collect items, prices, tax,
   fees, payment card and store.
4. Click **Excel** (one workbook, two sheets) or **CSV** (two files).

**Costco:** open *Account → Orders & Purchases*. The scan opens the In-Warehouse tab, steps
through the "Showing" 3-month periods that overlap your date range, and opens each
receipt to read its lines (item #, name, quantity, unit price, instant savings), subtotal,
tax, total, card and item count. Gas station receipts include gallons and price per gallon.
Online orders are early support: the scan also visits the Online tab and saves what it can
read there.

The **Retailers** page (button in the popup, or the extension's Options) shows every
supported store with saved-order counts, spend, tax and date range, with open / export /
clear actions per store, an **Export all retailers** workbook, and the stores coming next.

Saved data is kept per retailer; re-scanning merges new data in.

## What's exported

**Order Data** — Retailer, Order Type, Order ID, TC Number, Order Date, Status, Order URL, Invoice URL, Sub Total,
Shipping & Handling, Savings, Coupon, Gift Card, Total Before Tax, Tax, Grand Total,
Refund Total, Payment Methods (card type + last 4), Currency, Number of Items,
Number of Shipments, Store / Club, Item Names.

**Product Data** — Retailer, Order ID, Order Date, Order Type, Item Name, Item Number,
Quantity (or weight), Unit Price, Price Per (e.g. `lb` for weighed items), Item Total, Item Savings, Category, Status, Product URL, Image URL, Order URL.

Money columns are real numbers (currency-formatted in Excel). Text that starts with
`= + - @` is escaped in CSV to prevent spreadsheet formula injection.

## How it works

| File | Role |
|---|---|
| `src/retailers.js` | Retailer registry: hosts, order-history URLs, page selectors, detail-URL rules, storage keys, coming-soon list |
| `src/inject.js` | Runs in the page; copies JSON responses the site already loads for your orders |
| `src/content.js` | Reads order cards on the list page (Sam's Club and Walmart share Walmart's "Glass" platform), pages through "Next page"/"Load more", then reads each order's details page — item tiles (name, qty/weight, prices, item number) and the summary (date, subtotal, fees, tax, total, card, store) — in a hidden frame. Costco has its own flow (tabs, "Showing" periods, receipt popups) |
| `src/lib/normalize.js` | Finds order-shaped objects in any JSON, parses money/dates (incl. yearless "Tue, Dec 2"), merges data from several sources |
| `src/lib/export.js` | Builds the Order Data and Product Data reports; CSV and XLSX (SheetJS, vendored) |
| `src/lib/ui-shared.js` | Per-retailer storage, ranges and exports shared by popup and Retailers page |
| `popup/`, `pages/` | Popup (retailer picker, scan, export) and Retailers page |

### Adding a retailer

1. Add an entry to `SUPPORTED` in `src/retailers.js` (id, name, hosts, order-history URL,
   selectors). Walmart-platform sites can reuse `GLASS`.
2. Add its `https://www.<host>/*` to `host_permissions` and both `content_scripts.matches`
   in `manifest.json`.
3. Remove it from `COMING_SOON`, add a mock under `tests/e2e/`, and run the tests.

To work out a new site's page structure and data requests, see **[REA_RECON.md](REA_RECON.md)**
(uses https://github.com/morluto/rea against your own signed-in session).

## Tests

```bash
node --test tests/*.test.js     # normalizer + exporters against fixture payloads
node tests/e2e/run.js           # real Chromium + extension against mock samsclub.com, walmart.com and costco.com
```

The e2e test needs Playwright's Chromium and generates its own self-signed cert for the
mock hosts.

## Notes

- Only requests `storage`, `downloads` and `clipboardWrite` (debug report), and only runs on
  `https://www.samsclub.com/*`, `https://www.walmart.com/*` and `https://www.costco.com/*`.
- Online Walmart orders show only delivery status in the list; their order date comes from
  the details page, so keep *Include details* on.
- Detail backfill is throttled (`detailFetchDelayMs`, default 1.2 s/order) to stay gentle on the site.
- Independent project; not affiliated with Sam's Club, Walmart or any other retailer.
- SheetJS Community Edition is Apache-2.0 (`vendor/xlsx.LICENSE`).
