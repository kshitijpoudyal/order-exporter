# Publishing to the Chrome Web Store

## 0. Before you start

- Test the build once more with your real accounts: load `order-exporter/` unpacked, agree on the
  Welcome page, scan a month on each store, open the Excel file.
- Decide on a **support email** and put it in the privacy policy (replace `[YOUR SUPPORT EMAIL]`
  in `store/privacy-policy.html`, `store/PRIVACY.md` and `pages/privacy.html`). A separate address
  is a good idea — it is shown publicly.

## 1. Host the privacy policy (public URL required)

Easiest free option — GitHub Pages:
1. Create a public GitHub repo, e.g. `order-history-exporter-privacy`.
2. Upload `store/privacy-policy.html` and rename it to `index.html`.
3. Repo **Settings → Pages → Deploy from branch → main / root → Save**.
4. After a minute your URL is `https://<your-username>.github.io/order-history-exporter-privacy/`.

(Google Sites or any personal site works too — it just has to be public and match what the
extension does.)

## 2. Register as a Chrome Web Store developer

1. Go to the **Chrome Web Store Developer Dashboard**: https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account that will own the listing (2-Step Verification must be on).
3. Accept the developer agreement and pay the **one-time $5 registration fee**.
4. Fill in the publisher name and verify the contact email.

## 3. Build the upload zip

```bash
cd order-exporter
bash scripts/build-store.sh     # → dist/order-history-exporter-<version>.zip
```

The zip contains only what the extension needs (manifest, icons, popup, pages, src, vendor).
Tests, mocks and developer notes are left out. A ready-made copy is provided alongside this kit.

## 4. Create the item

1. Dashboard → **Add new item** → upload the zip.
2. **Store listing** tab — paste from `store/STORE_LISTING.md`, upload images from `store/assets/`.
3. **Privacy practices** tab — single purpose, permission justifications, "no remote code",
   data usage boxes and the three certifications, privacy policy URL (all in STORE_LISTING.md).
4. **Distribution** — start **Unlisted**, free, United States.
5. **Submit for review.**

Review usually takes from a few days up to a few weeks. Extensions with site access to
specific shopping sites can get an "in-depth review" — the narrow permissions, consent screen
and no-network design are there to make that straightforward.

## 5. After approval

- Install from your own listing link and run one scan per store to confirm.
- Switch Visibility to **Public** when you're happy.

## 6. Updating

1. Bump `"version"` in `manifest.json` (e.g. 1.0.1). The store rejects re-used versions.
2. `bash scripts/build-store.sh`, then Dashboard → your item → **Package → Upload new package** → Submit.
3. If an update reads new kinds of data, update the privacy policy and the Welcome page
   first, and bump the consent key (`consent:v1` → `consent:v2` in `src/content.js` and
   `src/lib/ui-shared.js`) so users agree again.

## Common rejection reasons and how this build handles them

| Reason | Status |
|---|---|
| Requests more permissions than it uses | Only `storage` + four specific sites. `downloads`/`clipboardWrite` were removed. |
| Collects data without prominent disclosure/consent | Welcome page on install + consent card in popup; nothing is read before "I agree". |
| No / inaccurate privacy policy | Policy matches behavior exactly; linked in popup, Welcome page and dashboard. |
| Remote code / obfuscation | None; SheetJS is the official minified build, bundled. |
| Implies retailer endorsement | Generic name, no logos (letter tiles only), "not affiliated" notice. |
| Single purpose unclear | Description and single-purpose text both say: export your own order history. |
| Missing functionality for reviewer | Test instructions explain it needs a real account and what can be checked without one. |

## One thing outside the store's rules to be aware of

Retailers' terms of use generally restrict automated access to their sites. This extension
only works on the signed-in user's own order history, at a slow pace, and only when the
user starts a scan — the same pages the user could open by hand — which keeps it low-risk,
but the stores could still change their sites or object. Keep the "not affiliated" wording,
and if a retailer contacts you, take that seriously.
