// ---------------------------------------------------------------------------
// DREAM STACK - enriched saved items
// GET /saved-items/details?state=wishlist
//
// Paste this into server.js ABOVE the final app.get('/health', ...) line.
// Requires: const { registerSavedItemsDetailsRoute } = require('./saved-items-details');
//           at the top of the file with the other requires.
// ---------------------------------------------------------------------------
registerSavedItemsDetailsRoute({
  app,
  requireShopifyCustomer,

  // NOTE: route is '/saved-items/details', NOT '/apps/einstein/...'.
  // The Shopify App Proxy strips the /apps/einstein prefix before forwarding,
  // which is why every existing route here is registered bare.
  route: '/saved-items/details',

  // Existing saved-items routes key off req.userId (set by requireShopifyCustomer),
  // so this must match them exactly.
  getCustomerId: (req) => req.userId,

  // sql.js: database.exec(sql, params) -> [{ columns, values }]
  loadSavedItems: async ({ customerId, state }) => {
    const database = await getDb();
    expireOldCartItems(database);
    saveDb();
    const result = database.exec(
      `SELECT item_id
         FROM saved_items
        WHERE user_id = ?
          AND state = ?
        ORDER BY updated_at DESC`,
      [customerId, state]
    );
    const rows = result.length > 0 ? result[0].values : [];
    return rows.map(([item_id]) => ({ item_id }));
  },

  // Same authenticated Admin GraphQL call Fire Department uses.
  shopifyGraphql: async (query, variables) => {
    const token = await getShopifyAccessToken();
    const response = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
      }
    );
    const data = await response.json();
    if (data.errors) {
      console.error('Dream Stack Admin API error:', data.errors);
      throw new Error('Shopify Admin API error');
    }
    return data.data;
  },
});
