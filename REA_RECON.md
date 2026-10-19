# Mapping a retailer's order pages with REA

The extension works out of the box with broad heuristics: it captures any same-origin JSON
on samsclub.com that mentions orders and lets the normalizer decide what's an order. That's
resilient, but you'll get faster scans and fewer missed fields once you know exactly which
requests carry your order history. REA (https://github.com/morluto/rea) is the tool for that.

**What REA is used for here:** observing how samsclub.com loads *your own* order data in
*your own* signed-in browser. It is not used to decompile OrderPro or any other paid
extension — this project is an independent implementation of the same publicly described
feature set.

REA's browser observation is passive and local: it attaches to a Chrome you launched,
records request URLs, JSON *shapes* (property paths and types, never values), and scripts.
Cookies and auth headers are never retained.

## 1. Install REA

```bash
npm install --global rea-agents   # Node 22.19+, 24.11+ or 26+
rea --help
```

Optional: `npx rea-agents setup` registers REA as an MCP server for Claude Code / Codex / Cursor
so you can just ask your agent to run the steps below.

## 2. Start a dedicated Chrome profile with a debugging port

Use a separate profile — CDP has deep access to whatever profile it's attached to.

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.rea-samsclub-profile" \
  https://www.samsclub.com/orders

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.rea-samsclub-profile" `
  https://www.samsclub.com/orders
```

Sign in to Sam's Club in that window yourself and open your order history.

## 3. Find the tab

```bash
rea list-browser-targets http://127.0.0.1:9222 --json
```

Copy the `target_id` of the samsclub.com orders tab.

## 4. Record the order-history traffic

Start an observation window, then in the browser scroll and click **Load more** /
open a couple of orders (online and in-club) while it runs:

```bash
rea observe-web-session http://127.0.0.1:9222 TARGET_ID --observation-ms 30000 --json > observe.json
```

Then capture the page with JSON response *shapes* (structure only, no values):

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 15000 --include-json-body-shapes --json > orders-page.json
```

Repeat the `inspect-web-page` step on an order **detail** page and on an **in-club receipt**
page (target IDs change per tab — re-run step 3).

Optional, to see how the site's own code builds the requests (endpoint candidates, GraphQL
operation names, route table):

```bash
rea analyze-web-bundle http://127.0.0.1:9222 TARGET_ID --json > bundle.json
```

### Alternative: a HAR file

If you'd rather not use CDP: open DevTools → Network on your order history, scroll through,
then right-click → **Save all as HAR (sanitized)**. Inspect it offline:

```bash
rea inspect-web-network-capture /absolute/path/samsclub.har har --json > har.json
```

Pass `--sensitive-value <your email>` (repeatable) to strip anything personal before sharing
the output with an agent or a teammate.

## 5. What to look for

In `orders-page.json` / `har.json`:

| You need | Look for | Put it in `src/retailers.js` |
|---|---|---|
| List endpoint | XHR/fetch URLs fired when you click Load more (e.g. `/orchestra/.../graphql/...PurchaseHistory...`) | `captureUrlPatterns` — narrow the regex to these paths |
| Detail endpoint | URL fired when an order detail page renders | add to `captureUrlPatterns` |
| Detail page URL | `href`s on the order cards | `orderLinkPatterns`, `orderDetailUrlTemplate` |
| Order id / date field names | JSON shape paths like `data.orderHistory.orders[].orderId` | `fieldHints.orderId`, `fieldHints.orderDate` |
| Load-more button text | accessibility names in the page capture (`--include-accessibility-text`) | `loadMoreButtonText` |

## 6. Verify

1. Reload the extension at `chrome://extensions`.
2. Open your order history, open the extension, choose **Last 30 days**, click **Scan orders**.
3. Export to Excel and spot-check three orders against the site (total, tax, item count).
4. If a field is consistently blank, find its JSON path in the REA shape output and add a
   key name to the relevant list in `src/lib/normalize.js` (e.g. `ORDER_DATE_KEYS`).

## Asking an agent to do it

With REA registered as an MCP server, a prompt like this works:

> Chrome is running on 127.0.0.1:9222 with my samsclub.com order history open and signed in.
> Use REA to find which requests load my order list, order details and in-club receipts,
> report their URL patterns and JSON shapes, and update that retailer's entry in `src/retailers.js` to
> match. Don't capture any values, only shapes.
