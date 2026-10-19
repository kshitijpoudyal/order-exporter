# Chrome Web Store listing — copy/paste answers

Everything the Developer Dashboard asks for, in the order it asks. Replace anything in
[BRACKETS].

---

## Store listing tab

**Name** (from manifest): Order History Exporter

**Summary** (≤132 chars, from manifest description):
Export your own order history from Amazon, Walmart, Costco and Sam's Club to Excel or CSV. Data stays in your browser.

**Category:** Tools  (alternative: Shopping)

**Language:** English (United States)

**Description:**

```
Export your own purchase history from Amazon, Walmart, Costco and Sam's Club to Excel or CSV — for budgeting, tax records, expense reports, returns or insurance inventories.

HOW IT WORKS
1. Sign in to the store as usual and open your order history.
2. Click the extension icon. It detects which store you're on.
3. Pick a date range and click Scan. The extension pages through your orders and opens each one to read the details.
4. Export to Excel (one workbook, two sheets) or CSV (two files).

WHAT YOU GET
• Orders sheet: retailer, order type, order/receipt number, date, store or warehouse, subtotal, fees, savings, tax, total, payment card type and last 4 digits, item count.
• Items sheet: every item with item number, quantity (or weight), unit price, line total and savings.
• Amazon: online and digital orders, with prices, sellers and invoice totals.
• Sam's Club: online, pickup, delivery, in-club, Scan & Go and fuel.
• Walmart: delivery, shipping, pickup and in-store purchases.
• Costco: in-warehouse and gas station receipts; online orders (early support).
• A Retailers page with totals per store and a combined export of all stores.

PRIVATE BY DESIGN
• Everything happens in your browser. No account, no server, no analytics, no tracking.
• Your data is never sent anywhere. It is stored only in this browser until you delete it.
• The extension never sees your password — you sign in to the store yourself.
• Nothing is read until you agree on the welcome screen.
• Runs only on amazon.com, walmart.com, costco.com and samsclub.com.

Not affiliated with, endorsed by, or sponsored by Amazon, Walmart, Costco or Sam's Club. Store names are used only to describe compatibility.
```

**Graphic assets** (in `store/assets/`):
- Store icon 128×128: `store-icon-128.png`
- Screenshots 1280×800: `screenshot-1-popup.png`, `screenshot-2-retailers.png`, `screenshot-3-privacy.png`
- Small promo tile 440×280: `promo-small-440x280.png`

**Official URL / Homepage URL:** [optional — your GitHub repo or site]
**Support URL / email:** [YOUR SUPPORT EMAIL or GitHub issues URL]

---

## Privacy practices tab

**Single purpose description:**
```
Lets the user export their own order and receipt history from Amazon, Walmart, Costco and Sam's Club websites into Excel or CSV files. The extension reads the user's purchase-history pages on those four sites when the user starts a scan, stores the results locally in the browser, and creates export files on request.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's scanned orders locally (chrome.storage.local) so they can be exported, filtered by date and combined across stores. Also stores the user's consent choice and last-used store. No data leaves the device. |
| Host permission `https://www.samsclub.com/*` | Needed to read the user's purchase-history and order-details pages on Sam's Club when the user scans, and to page through them. |
| Host permission `https://www.walmart.com/*` | Same as above for Walmart purchase history and order details. |
| Host permission `https://www.costco.com/*` | Same as above for Costco Orders & Purchases and warehouse receipts. |
| Host permission `https://www.amazon.com/*` | Same as above for Amazon Your Orders, order details and invoices (loaded with the user's own session when they scan). |

**Are you using remote code?** No, I am not using remote code. (All JavaScript, including the SheetJS spreadsheet library, is bundled in the package. No `eval`, no remotely loaded scripts.)

**Data usage — what user data do you collect?** Tick:
- ☑ **Financial and payment information** — purchase records: order totals, item prices, tax; payment card type and last 4 digits as shown on the user's receipts.
- ☑ **Website content** — the user's order-history pages on the four supported sites.
- Leave everything else unticked (no personally identifiable info is extracted beyond what is on a receipt; no health, authentication, personal communications, location, web history or user activity).

> If you prefer to be maximally conservative, also tick **Personally identifiable information** (receipts can show a store address). It does not change review requirements.

**Certifications** (tick all three — they are true for this extension):
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** [the public URL where you host `store/privacy-policy.html`]

---

## Distribution tab

- **Visibility:** start with **Unlisted** (only people with the link can install) to try it with real accounts, then switch to **Public**.
- **Regions:** United States (the supported stores are US sites) — or all regions.
- **Pricing:** Free.

---

## Test instructions for the reviewer (Dashboard → "Test instructions", if shown)

```
The extension only works on the user's own signed-in order history at amazon.com, walmart.com, costco.com and samsclub.com, so it needs a real customer account with past purchases to show data.
Without an account you can still verify: on install the Welcome page explains what is read and asks for consent; the popup shows a consent card until "I agree" is clicked; the Retailers page (popup → Retailers) lists supported stores; Privacy policy is linked from the popup footer.
The extension makes no network requests of its own and has no backend.
```
