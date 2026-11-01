import { describe, expect, it } from 'vitest';
import { extractShoppingIntent } from '../src/agent/intent-extractor.js';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import type { QuickCommerceItem } from '../src/mcp/types.js';

const shoeCleaningWipes: QuickCommerceItem = {
  id: 'shoe-wipes',
  platform: 'swiggy_instamart',
  merchantName: 'Swiggy Instamart',
  name: 'Sneakare Portable Shoe Cleaning Wipes',
  priceCents: 5000,
  currency: 'INR',
  inStock: true,
  isPriceVerified: true,
};

const actualShoes: QuickCommerceItem = {
  id: 'walking-shoes',
  platform: 'swiggy_instamart',
  merchantName: 'Swiggy Instamart',
  name: 'Men\'s Walking Shoes',
  priceCents: 59900,
  currency: 'INR',
  inStock: true,
  isPriceVerified: true,
};

describe('footwear request constraints', () => {
  it('parses a bare INR limit in "shoes under 600"', () => {
    const intent = extractShoppingIntent('shoes under 600');

    expect(intent.items).toHaveLength(1);
    expect(intent.items[0].product).toBe('shoes');
    expect(intent.items[0].maxCostCents).toBe(60000);
  });

  it('never treats shoe-cleaning wipes as shoes', () => {
    const match = quickCommerceMcpManager.matchEquivalentProduct(
      { name: 'shoes', quantity: 1, maxCostCents: 60000 },
      [shoeCleaningWipes],
    );

    expect(match.matchClassification).toBe('NO_MATCH');
    expect(match.status).toBe('missing');
  });

  it('removes footwear accessories from product cards while retaining footwear', () => {
    const items = quickCommerceMcpManager.rankTopItems(
      [shoeCleaningWipes, actualShoes],
      { query: 'shoes under 600', maxCostCents: 60000 },
    );

    expect(items).toEqual([actualShoes]);
  });
});
