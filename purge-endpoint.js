#!/usr/bin/env node
'use strict';

/**
 * Temporary purge endpoint for saved_items (wishlist + cart tracking rows).
 *
 *   node purge-endpoint.js add      -> inserts the guarded route
 *   node purge-endpoint.js remove   -> takes it back out
 *
 * The route is guarded by a random secret and is meant to exist for a few
 * minutes only. Add it, push, call it once, then remove it and push again.
 *
 * NOTE: this deletes ALL rows in saved_items for ALL users. It does not touch
 * orders, offers, customers, or anything else.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const SECRET = '60d79834a35baf7f4c0a80b5a691c9ace449bf7a27f320a1';

const START = '// ===== TEMP PURGE ENDPOINT - REMOVE AFTER USE =====';
const END = '// ===== END TEMP PURGE ENDPOINT =====';

const BLOCK = `
${START}
app.post('/admin-purge-saved-items', async (req, res) => {
  if (req.query.secret !== '${SECRET}') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const database = await getDb();
    const before = database.exec('SELECT COUNT(*) FROM saved_items');
    const total = before.length > 0 ? before[0].values[0][0] : 0;
    database.run('DELETE FROM saved_items');
    saveDb();
    const after = database.exec('SELECT COUNT(*) FROM saved_items');
    const remaining = after.length > 0 ? after[0].values[0][0] : 0;
    console.log('[purge] deleted ' + total + ' saved_items rows');
    res.json({ purged: total, remaining });
  } catch (e) {
    console.error('[purge] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});
${END}
`;

const mode = process.argv[2];
let src = fs.readFileSync(FILE, 'utf8');

if (mode === 'add') {
  if (src.includes(START)) {
    console.log('Purge endpoint is already present.');
    process.exit(0);
  }
  fs.writeFileSync(FILE, src + BLOCK);
  console.log('Added purge endpoint.\n');
  console.log('Push, wait for Render, then run:\n');
  console.log(`curl -s -X POST "https://threerdfloortapes-backend.onrender.com/admin-purge-saved-items?secret=${SECRET}"\n`);
  console.log('Then: node purge-endpoint.js remove');
} else if (mode === 'remove') {
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    console.log('Purge endpoint not found - nothing to remove.');
    process.exit(0);
  }
  src = src.slice(0, startIdx) + src.slice(endIdx + END.length);
  fs.writeFileSync(FILE, src.replace(/\n{3,}$/, '\n'));
  console.log('Removed purge endpoint. Commit and push.');
} else {
  console.log('Usage: node purge-endpoint.js add | remove');
  process.exit(1);
}
