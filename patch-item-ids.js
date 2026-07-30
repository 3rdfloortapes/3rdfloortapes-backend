#!/usr/bin/env node
'use strict';

/**
 * One-time patch: normalize saved_items.item_id to bare numeric IDs.
 *
 * Problem:
 *   - The React Native app writes item_id as 'gid://shopify/Product/123'
 *   - The Shopify storefront heart writes item_id as '123'
 *   - UNIQUE(user_id, item_id) treats these as DIFFERENT rows, so the same
 *     tape can occupy two rows (breaking cart/wishlist exclusivity and
 *     double-counting Fire Department).
 *   - Fire Department passes item_id straight into GraphQL $ids: [ID!]!,
 *     and bare numeric IDs are INVALID there -> whole query 500s.
 *
 * Fix:
 *   - Canonical storage form is BARE NUMERIC.
 *   - Convert to a GID only at the GraphQL boundary.
 *   - Migrate existing GID rows, dropping duplicates.
 *
 * Run:  node patch-item-ids.js
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
let src = fs.readFileSync(FILE, 'utf8');
const original = src;

if (src.includes('function toNumericId(')) {
  console.log('Already patched. Nothing to do.');
  process.exit(0);
}

const edits = [
  {
    name: 'POST /saved-items writes numeric id',
    from: '    [req.userId, item_id, state, now, state, now]',
    to: '    [req.userId, toNumericId(item_id), state, now, state, now]',
  },
  {
    name: 'DELETE /saved-items matches numeric id',
    from: "database.run('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?', [req.userId, req.params.item_id]);",
    to: "database.run('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?', [req.userId, toNumericId(req.params.item_id)]);",
  },
  {
    name: 'counts/:item_id matches numeric id',
    from: "    'SELECT state, COUNT(*) as count FROM saved_items WHERE item_id = ? GROUP BY state',\n    [req.params.item_id]",
    to: "    'SELECT state, COUNT(*) as count FROM saved_items WHERE item_id = ? GROUP BY state',\n    [toNumericId(req.params.item_id)]",
  },
  {
    name: 'fire-department runs migration',
    from: '    expireOldCartItems(database);\n    saveDb();\n    const limit = parseInt(req.query.limit, 10) || 8;',
    to: '    expireOldCartItems(database);\n    normalizeSavedItemIds(database);\n    saveDb();\n    const limit = parseInt(req.query.limit, 10) || 8;',
  },
  {
    name: 'fire-department sends valid GIDs to GraphQL',
    from: '    const gids = popular.map((p) => p.item_id);',
    to: '    const gids = popular.map((p) => toProductGid(p.item_id));',
  },
  {
    name: 'fire-department matches results back by GID',
    from: '        const product = byId[p.item_id];',
    to: '        const product = byId[toProductGid(p.item_id)];',
  },
];

let failed = false;
for (const edit of edits) {
  const count = src.split(edit.from).length - 1;
  if (count !== 1) {
    console.error(`FAILED: "${edit.name}" matched ${count} times (expected exactly 1)`);
    failed = true;
    continue;
  }
  src = src.replace(edit.from, edit.to);
  console.log(`ok: ${edit.name}`);
}

if (failed) {
  console.error('\nNo changes written. server.js does not match the expected text.');
  process.exit(1);
}

src += `

// ---------------------------------------------------------------------------
// ITEM ID NORMALIZATION
// Canonical storage form for saved_items.item_id is a BARE NUMERIC string.
// Shopify GraphQL requires a full GID, so convert only at that boundary.
// (Function declarations hoist, so these are usable above.)
// ---------------------------------------------------------------------------
function toNumericId(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/(\\d+)$/);
  return match ? match[1] : null;
}

function toProductGid(value) {
  const raw = String(value == null ? '' : value);
  if (raw.startsWith('gid://')) return raw;
  return 'gid://shopify/Product/' + raw;
}

let savedItemIdsNormalized = false;
function normalizeSavedItemIds(database) {
  if (savedItemIdsNormalized) return;

  const check = database.exec(
    "SELECT COUNT(*) FROM saved_items WHERE item_id LIKE 'gid://%'"
  );
  const pending = check.length > 0 ? check[0].values[0][0] : 0;
  if (!pending) {
    savedItemIdsNormalized = true;
    return;
  }

  console.log('[normalize] converting ' + pending + ' GID rows to numeric');

  // Drop the GID row when a numeric row already exists for the same
  // user + product. Keeps the storefront row, which is the newer format.
  database.run(\`
    DELETE FROM saved_items
     WHERE item_id LIKE 'gid://shopify/Product/%'
       AND EXISTS (
         SELECT 1 FROM saved_items other
          WHERE other.user_id = saved_items.user_id
            AND other.item_id = replace(saved_items.item_id, 'gid://shopify/Product/', '')
       )
  \`);

  database.run(\`
    UPDATE saved_items
       SET item_id = replace(item_id, 'gid://shopify/Product/', '')
     WHERE item_id LIKE 'gid://shopify/Product/%'
  \`);

  saveDb();
  savedItemIdsNormalized = true;
  console.log('[normalize] done');
}
`;

fs.writeFileSync(FILE + '.backup', original);
fs.writeFileSync(FILE, src);
console.log('\nPatched server.js (backup saved as server.js.backup)');
