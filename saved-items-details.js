'use strict';

/**
 * Dream Stack enriched saved-items endpoint.
 *
 * Register with:
 *   registerSavedItemsDetailsRoute({
 *     app,
 *     requireShopifyCustomer,
 *     loadSavedItems,
 *     shopifyGraphql,
 *   });
 *
 * Required adapters:
 * - requireShopifyCustomer(req, res, next)
 *   Must set req.shopifyCustomerId (or provide getCustomerId below).
 * - loadSavedItems({ customerId, state })
 *   Returns rows containing item_id (Shopify product ID).
 * - shopifyGraphql(query, variables)
 *   Returns the GraphQL data object, or { data }.
 */

const DETAILS_QUERY = `#graphql
  query SavedItemDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        onlineStoreUrl
        featuredImage { url altText }
        variants(first: 25) {
          nodes {
            id
            availableForSale
            price
          }
        }
      }
    }
  }
`;

function numericId(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d+)$/);
  return match ? match[1] : null;
}

function productGid(value) {
  const raw = String(value || '');
  return raw.startsWith('gid://') ? raw : `gid://shopify/Product/${raw}`;
}

function priceToCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function selectVariant(variants) {
  const list = Array.isArray(variants) ? variants : [];
  return list.find((variant) => variant && variant.availableForSale) || list[0] || null;
}

function enrichProducts(savedRows, nodes) {
  const byProductId = new Map();

  for (const product of Array.isArray(nodes) ? nodes : []) {
    if (!product || !product.id) continue;
    byProductId.set(numericId(product.id), product);
  }

  return savedRows.flatMap((row) => {
    const rawId = row.item_id || row.product_id || row.id;
    const itemId = numericId(rawId);
    const product = byProductId.get(itemId);

    // Product was deleted, unpublished to the app, or otherwise not resolvable.
    // Omit it rather than returning a broken card.
    if (!itemId || !product) return [];

    const variants = product.variants && product.variants.nodes;
    const variant = selectVariant(variants);
    const available = Boolean(variant && variant.availableForSale);

    return [{
      // Echo the RAW stored id, not the normalized one. The client sends this
      // back on DELETE / state-change, and it must match the DB row exactly.
      // (App rows store full GIDs; storefront rows store bare numeric ids.)
      item_id: rawId,
      variant_id: variant ? numericId(variant.id) : null,
      title: product.title || 'Untitled',
      url: product.onlineStoreUrl || (product.handle ? `/products/${product.handle}` : '#'),
      image: product.featuredImage ? product.featuredImage.url : null,
      price: variant ? priceToCents(variant.price) : null,
      available,
    }];
  });
}

function defaultGetCustomerId(req) {
  return req.shopifyCustomerId ||
    (req.shopifyCustomer && req.shopifyCustomer.id) ||
    (req.customer && req.customer.id) ||
    null;
}

function registerSavedItemsDetailsRoute(options) {
  const {
    app,
    requireShopifyCustomer,
    loadSavedItems,
    shopifyGraphql,
    getCustomerId = defaultGetCustomerId,
    route = '/apps/einstein/saved-items/details',
    logger = console,
  } = options || {};

  if (!app || typeof app.get !== 'function') throw new TypeError('app.get is required');
  if (typeof requireShopifyCustomer !== 'function') throw new TypeError('requireShopifyCustomer is required');
  if (typeof loadSavedItems !== 'function') throw new TypeError('loadSavedItems is required');
  if (typeof shopifyGraphql !== 'function') throw new TypeError('shopifyGraphql is required');

  app.get(route, requireShopifyCustomer, async (req, res) => {
    try {
      const customerId = getCustomerId(req);
      if (!customerId) return res.status(401).json({ error: 'Shopify customer required' });

      const state = String(req.query.state || 'wishlist');
      if (!['wishlist', 'cart'].includes(state)) {
        return res.status(400).json({ error: 'state must be wishlist or cart' });
      }

      const rows = await loadSavedItems({ customerId: String(customerId), state });
      const savedRows = Array.isArray(rows) ? rows : [];
      if (!savedRows.length) return res.json({ items: [] });

      const ids = [...new Set(savedRows
        .map((row) => numericId(row.item_id || row.product_id || row.id))
        .filter(Boolean)
        .map(productGid))];

      const result = await shopifyGraphql(DETAILS_QUERY, { ids });
      const data = result && result.data ? result.data : result;
      const items = enrichProducts(savedRows, data && data.nodes);

      res.set('Cache-Control', 'private, no-store');
      return res.json({ items });
    } catch (error) {
      logger.error('[saved-items/details] failed', error);
      return res.status(500).json({ error: 'Could not load saved item details' });
    }
  });
}

module.exports = {
  DETAILS_QUERY,
  enrichProducts,
  numericId,
  priceToCents,
  registerSavedItemsDetailsRoute,
  selectVariant,
};
