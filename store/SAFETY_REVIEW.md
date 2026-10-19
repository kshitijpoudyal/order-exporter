# Safety review (v1.1.0)

What was checked before submission, and what changed.

**Data flow.** Order data goes: store page → content script → `chrome.storage.local` → export file
the user saves. The extension's own code makes no requests anywhere except the store site the
user is on (to open their own order/receipt pages). On Amazon it loads the user's own Your Orders,
order-details and invoice pages with same-site requests using the existing session; it never
stores shipping names or addresses shown on those pages. No backend, analytics, telemetry or remote config.

**Consent.** Nothing is read or saved until the user clicks "I agree" (Welcome page on install, or the
popup). The content script checks consent before saving anything and before starting a scan.
Withdrawing consent stops collection immediately. *Tested: with a store page already loaded, nothing
was saved before consent.*

**Permissions.** `storage` plus site access to www.amazon.com, www.walmart.com, www.costco.com and www.samsclub.com only.
Removed `downloads` (exports use a normal download link) and `clipboardWrite` (not needed for the
user-initiated copy). Minimum Chrome 111 (needed for the page-world script).

**Code.** No remote code, no `eval`/`new Function`, no inline scripts in extension pages (default MV3
CSP applies). All UI text from web pages is inserted with `textContent`, never as HTML.
SheetJS 0.18.5 is the official minified build; the extension only *writes* spreadsheets — it never
opens user-supplied files, which is where that library's known advisories apply.

**Page-world script (`src/inject.js`).** Copies JSON responses the store page itself loads, only for
same-origin requests, and only passes them to this extension's content script. It accepts its
configuration once (from our content script at page start) so the page can't change it later. For
Costco it forwards no response bodies at all.

**Debug report.** Contains page structure and field names only: digits masked, no values, and
button labels are limited to navigation words (no greetings/names).

**Branding.** Generic name, letter tiles instead of logos, "not affiliated" notice on the Welcome
page, privacy policy and listing.

**Test data.** Mock pages use fictional card digits; no personal data ships in the package (tests
are not included in the store zip).
