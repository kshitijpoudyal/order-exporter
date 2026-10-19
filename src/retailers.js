/*
 * Retailer registry. Everything store-specific lives here; the content script, popup and
 * Retailers page read from it. To add a store: add an entry to SUPPORTED (and its host to
 * manifest.json host_permissions + content_scripts.matches), then move it out of COMING_SOON.
 *
 * Both Sam's Club and Walmart run on Walmart's "Glass" web platform, so they share the
 * order-card / item-tile selectors in GLASS and only override what differs.
 */
(function (root) {
  'use strict';

  // Defaults every retailer starts from.
  const BASE = {
    // Network responses to capture: every same-origin JSON response; the body filter +
    // normalizer decide what's an order.
    captureBodyPattern: /order/i,
    maxBodyChars: 8_000_000,
    // Links that lead to an order's detail page. First capture group = order id.
    orderLinkPatterns: [
      /\/(?:orders?|purchase-?history|receipts?|order-details|orderdetails)\/(?:details\/)?((?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{6,64})(?:[/?#]|$)/i,
      /[?&](?:orderId|orderNumber|receiptId|tcNumber)=((?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{6,64})/i,
    ],
    loadMoreButtonText: /^(load|show|view|see) more( orders| purchases)?$|^more orders$|^older orders$/i,
    actionDelayMs: 1500,
    detailFetchDelayMs: 1200,
    fieldHints: { orderId: [], orderDate: [] },
  };

  // Shared by Walmart-platform sites.
  const GLASS = {
    // Order card on the purchase-history list: data-testid matching this regex.
    orderCardTestId: /^orderGroup-\d+$/,
    // "See details" button whose automation id ends with the order id (Sam's Club).
    orderDetailButtonSelector: '[data-automation-id^="view-order-details-link-"]',
    orderDetailButtonIdPrefix: 'view-order-details-link-',
    // Order details page.
    itemTileSelector: '[data-testid="itemtile-stack"]',
    itemsToggleSelector: '[data-automation-id="items-toggle-link"], [data-automation-id="show-all-items"]',
    orderInfoCardSelector: '[data-testid="orderInfoCard"]',
    detailMainSelector: '[data-testid="maincontent"], main',
    // Product links like /ip/Some-Product-Name/123456789 carry the item number.
    itemNumberFromUrl: /\/ip\/(?:[^/]+\/)?(\d{5,})/,
  };

  const SUPPORTED = [
    {
      ...BASE,
      ...GLASS,
      id: 'samsclub',
      name: "Sam's Club",
      short: 'SC',
      color: '#0067a0',
      hosts: /(^|\.)samsclub\.com$/i,
      homeUrl: 'https://www.samsclub.com',
      orderHistoryUrls: ['https://www.samsclub.com/en/orders', 'https://www.samsclub.com/orders'],
      captureUrlPatterns: [/samsclub\.com\//i],
      // Detail URLs are learned by clicking one "See details" button (they carry extra
      // query parameters that differ per account), with this as a last resort.
      orderDetailUrlTemplate: 'https://www.samsclub.com/orders/{orderId}',
      orderTypes: 'Online, pickup, delivery, in-club, Scan & Go and fuel',
    },
    {
      ...BASE,
      ...GLASS,
      id: 'walmart',
      name: 'Walmart',
      short: 'W',
      color: '#0071dc',
      hosts: /(^|\.)walmart\.com$/i,
      homeUrl: 'https://www.walmart.com',
      orderHistoryUrls: ['https://www.walmart.com/orders'],
      captureUrlPatterns: [/walmart\.com\//i],
      // Each order is data-testid="order-N"; its shipments are orderGroup-N inside it.
      orderCardTestId: /^order-\d+$/,
      orderDetailUrlTemplate: 'https://www.walmart.com/orders/{orderId}',
      // Store purchases open with these query parameters; online orders don't need them.
      detailUrlFor(o) {
        const base = 'https://www.walmart.com/orders/' + encodeURIComponent(o.orderId);
        return o.orderType === 'In-Store' ? base + '?groupId=0&storePurchase=true' : base;
      },
      orderTypes: 'Delivery, shipping, pickup and in-store purchases',
    },
    {
      ...BASE,
      id: 'costco',
      name: 'Costco',
      short: 'C',
      color: '#e31837',
      hosts: /^www\.costco\.com$/i,
      homeUrl: 'https://www.costco.com',
      orderHistoryUrls: [
        'https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/ordersandpurchases',
        'https://www.costco.com/OrderStatusCmd',
      ],
      captureUrlPatterns: [/costco\.com\//i],
      // Receipts are read from the page (cards + the receipt popup), which is reliable and
      // keeps one id per receipt; background JSON is only used for the debug report.
      captureJson: false,
      // Costco has its own scan flow: tabs, 3-month "Showing" periods, receipt popups.
      scanStrategy: 'costco',
      cardSelector: '[id^="viewRecieptBtn_"]',
      cardIdPrefix: 'viewRecieptBtn_',
      viewReceiptSelector: '[automation-id="ViewInWareHouseReciept"]',
      warehouseTabSelector: '[automation-id="myWarehouseOrdersTab"]',
      onlineTabSelector: '[automation-id="myOnlineOrdersTab"]',
      periodSelectSelector: 'select#Showing',
      receiptDialogSelector: '[role="dialog"][aria-labelledby="alert-dialog-title"]',
      orderDetailUrlTemplate: 'https://www.costco.com/OrderStatusDetailsView?orderId={orderId}',
      orderTypes: 'In-warehouse and gas station receipts; online orders (early support)',
    },
  ];

  // Shown on the Retailers page so it's clear what's next. Not active yet.
  const COMING_SOON = [
    { id: 'target', name: 'Target', short: 'T', color: '#cc0000' },
    { id: 'amazon', name: 'Amazon', short: 'A', color: '#232f3e' },
    { id: 'bjs', name: "BJ's Wholesale", short: 'BJ', color: '#d6001c' },
    { id: 'kroger', name: 'Kroger', short: 'K', color: '#21409a' },
    { id: 'homedepot', name: 'The Home Depot', short: 'HD', color: '#f96302' },
    { id: 'lowes', name: "Lowe's", short: 'L', color: '#004990' },
    { id: 'bestbuy', name: 'Best Buy', short: 'BB', color: '#0046be' },
  ];

  const byId = (id) => SUPPORTED.find((r) => r.id === id) || null;

  function forHost(hostname) {
    return SUPPORTED.find((r) => r.hosts.test(hostname || '')) || null;
  }

  function forUrl(url) {
    try {
      return forHost(new URL(url).hostname);
    } catch (_) {
      return null;
    }
  }

  // Per-retailer storage keys.
  const keys = (id) => ({
    orders: `orders:${id}`,
    updatedAt: `updatedAt:${id}`,
    job: `scanJob:${id}`,
    template: `detailTemplate:${id}`,
  });

  /** One-time move of v0.4 single-store data (Sam's Club only) to per-retailer keys. */
  async function migrate(storage) {
    const old = await storage.get(['orders', 'detailTemplate', 'updatedAt', 'scanJob']);
    if (!old.orders && !old.detailTemplate) return;
    const k = keys('samsclub');
    const cur = await storage.get([k.orders, k.template]);
    const set = {};
    // Merge, never overwrite: the content script may already have saved newer data.
    if (old.orders) set[k.orders] = { ...old.orders, ...(cur[k.orders] || {}) };
    if (old.detailTemplate && !cur[k.template]) set[k.template] = old.detailTemplate;
    if (old.updatedAt) set[k.updatedAt] = old.updatedAt;
    if (Object.keys(set).length) await storage.set(set);
    await storage.remove(['orders', 'detailTemplate', 'updatedAt', 'scanJob']);
  }

  root.SCX_RETAILERS = { SUPPORTED, COMING_SOON, byId, forHost, forUrl, keys, migrate };
  // The content script works with the retailer of the page it runs on.
  if (typeof location !== 'undefined' && location.protocol && location.protocol.startsWith('http')) {
    root.SCX_CONFIG = forHost(location.hostname);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCX_RETAILERS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
