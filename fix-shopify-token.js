const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, 'server.js');
const BACKUP_PATH = path.join(__dirname, 'server.js.pre-directtoken-backup');

let code = fs.readFileSync(SERVER_PATH, 'utf8');

if (code.includes('SHOPIFY_ACCESS_TOKEN')) {
  console.log('Already patched. Nothing changed.');
  process.exit(0);
}

fs.writeFileSync(BACKUP_PATH, code);
console.log('Backup saved as server.js.pre-directtoken-backup');

code = code.replace(
  'SHOPIFY_CLIENT_ID,\n  SHOPIFY_CLIENT_SECRET,',
  'SHOPIFY_CLIENT_ID,\n  SHOPIFY_CLIENT_SECRET,\n  SHOPIFY_ACCESS_TOKEN,'
);

code = code.replace(
  'async function getShopifyAccessToken() {\n  if (shopifyToken && Date.now() < shopifyTokenExpiry) {\n    return shopifyToken;\n  }',
  'async function getShopifyAccessToken() {\n  if (SHOPIFY_ACCESS_TOKEN) {\n    return SHOPIFY_ACCESS_TOKEN;\n  }\n  if (shopifyToken && Date.now() < shopifyTokenExpiry) {\n    return shopifyToken;\n  }'
);

fs.writeFileSync(SERVER_PATH, code);
console.log('server.js patched to use direct SHOPIFY_ACCESS_TOKEN when available.');
