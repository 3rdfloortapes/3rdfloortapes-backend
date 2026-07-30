'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichProducts, priceToCents, selectVariant } = require('./saved-items-details');

test('priceToCents converts Shopify decimal strings to integer cents', () => {
  assert.equal(priceToCents('5.00'), 500);
  assert.equal(priceToCents('12.34'), 1234);
});

test('selectVariant prefers an available variant', () => {
  const selected = selectVariant([
    { id: 'sold', availableForSale: false },
    { id: 'available', availableForSale: true },
  ]);
  assert.equal(selected.id, 'available');
});

test('enrichProducts preserves saved-item order and emits frontend contract', () => {
  const rows = [{ item_id: '22' }, { item_id: '11' }];
  const nodes = [
    {
      id: 'gid://shopify/Product/11',
      title: 'Tape Eleven',
      handle: 'tape-eleven',
      featuredImage: { url: 'https://cdn/11.jpg' },
      variants: { nodes: [{ id: 'gid://shopify/ProductVariant/111', availableForSale: true, price: '5.00' }] },
    },
    {
      id: 'gid://shopify/Product/22',
      title: 'Tape Twenty-Two',
      handle: 'tape-twenty-two',
      featuredImage: null,
      variants: { nodes: [{ id: 'gid://shopify/ProductVariant/222', availableForSale: false, price: '7.50' }] },
    },
  ];

  assert.deepEqual(enrichProducts(rows, nodes), [
    {
      item_id: '22', variant_id: '222', title: 'Tape Twenty-Two',
      url: '/products/tape-twenty-two', image: null, price: 750, available: false,
    },
    {
      item_id: '11', variant_id: '111', title: 'Tape Eleven',
      url: '/products/tape-eleven', image: 'https://cdn/11.jpg', price: 500, available: true,
    },
  ]);
});
