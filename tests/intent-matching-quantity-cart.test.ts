import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractShoppingIntent,
  normalizeBrand,
  normalizeQuantityAndPack,
  calculateBasketTotals,
  QuickCommerceItem,
  quickCommerceMcpManager,
  SwiggyMcpClient,
  ZeptoMcpClient,
  DeliveryLocation,
  orderValidator,
  autonomousCommerceRunner,
  authProvider,
  spendTracker,
  SUSHMITA_USER,
} from '../src/index.js';
import { MockMcpTransport } from '../src/mcp/transport.js';

describe('Autonomous Commerce Agent - Intent Analysis, Product Matching, Quantity Normalization & Cart Calculation', () => {
  const blrLocation: DeliveryLocation = {
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
    pincode: '560103',
    latitude: 12.9298,
    longitude: 77.6835,
  };

  const eggItem6Pack: QuickCommerceItem = {
    id: 'item_fresh_eggs_6',
    platform: 'zepto',
    merchantName: 'Zepto',
    name: 'Fresh White Eggs',
    category: 'Dairy & Eggs',
    priceCents: 4800, // ₹48.00
    currency: 'INR',
    inStock: true,
    unit: '1 pack (6 pcs)',
    packSize: '6 pcs',
    isPriceVerified: true,
    priceSource: 'mcp_live',
  };

  const milkItem1L: QuickCommerceItem = {
    id: 'item_milk_1l',
    platform: 'zepto',
    merchantName: 'Zepto',
    name: 'Nandini Pasteurized Toned Milk',
    brand: 'Nandini',
    category: 'Dairy & Milk',
    priceCents: 6500, // ₹65.00
    currency: 'INR',
    inStock: true,
    unit: '1 L',
    packSize: '1000 ml',
    isPriceVerified: true,
    priceSource: 'mcp_live',
  };

  const breadItem: QuickCommerceItem = {
    id: 'item_bread_400g',
    platform: 'zepto',
    merchantName: 'Zepto',
    name: 'Britannia 100% Whole Wheat Brown Bread',
    brand: 'Britannia',
    category: 'Bakery & Bread',
    priceCents: 5000, // ₹50.00
    currency: 'INR',
    inStock: true,
    unit: '400 g',
    isPriceVerified: true,
    priceSource: 'mcp_live',
  };

  const yippeeNoodlesItem: QuickCommerceItem = {
    id: 'item_yippee_noodles',
    platform: 'zepto',
    merchantName: 'Zepto',
    name: 'Sunfeast YiPPee! Magic Masala Instant Noodles',
    brand: 'Yippee',
    category: 'Instant Noodles & Pasta',
    priceCents: 2400, // ₹24.00
    currency: 'INR',
    inStock: true,
    unit: '4 pack (280 g)',
    isPriceVerified: true,
    priceSource: 'mcp_live',
  };

  beforeEach(() => {
    authProvider.reset();
    authProvider.seedVerifiedClerkProfiles();
    authProvider.seedUser({ ...SUSHMITA_USER });
    authProvider.setActiveUser(SUSHMITA_USER.id);
    spendTracker.clear();
  });

  // TEST 1: Input: 6 eggs -> Catalog: 6 eggs per pack, ₹48 -> Expected: 1 pack, total ₹48
  it('TEST 1: correctly interprets "6 eggs" with 6 pcs per pack as 1 pack, total ₹48 (NEVER 6 x ₹48)', () => {
    const intent = extractShoppingIntent('Order 6 eggs');
    expect(intent.items.length).toBe(1);
    expect(intent.items[0].requestedQuantity).toBe(6);
    expect(intent.items[0].requestedUnit).toBe('piece');

    const norm = normalizeQuantityAndPack(
      intent.items[0].requestedQuantity,
      intent.items[0].requestedUnit,
      eggItem6Pack
    );

    expect(norm.orderQuantity).toBe(1);
    expect(norm.unitPriceCents).toBe(4800);
    expect(norm.totalPriceCents).toBe(4800);
    expect(norm.actualSuppliedQuantity).toBe(6);
    expect(norm.totalPriceCents).not.toBe(6 * 4800); // Guarantees NEVER 6 x 48
  });

  // TEST 2: Input: 12 eggs -> Catalog: 6 eggs per pack, ₹48 -> Expected: 2 packs, total ₹96
  it('TEST 2: correctly interprets "12 eggs" with 6 pcs per pack as 2 packs, total ₹96', () => {
    const intent = extractShoppingIntent('Order 12 eggs');
    expect(intent.items[0].requestedQuantity).toBe(12);
    expect(intent.items[0].requestedUnit).toBe('piece');

    const norm = normalizeQuantityAndPack(
      intent.items[0].requestedQuantity,
      intent.items[0].requestedUnit,
      eggItem6Pack
    );

    expect(norm.orderQuantity).toBe(2);
    expect(norm.unitPriceCents).toBe(4800);
    expect(norm.totalPriceCents).toBe(9600); // ₹96
    expect(norm.actualSuppliedQuantity).toBe(12);
  });

  // TEST 3: Input: 2 packets of 1L milk -> Catalog: 1L per pack, ₹65 -> Expected: 2 packs, total ₹130
  it('TEST 3: correctly interprets "2 packets of 1L milk" as 2 packs, total ₹130', () => {
    const intent = extractShoppingIntent('Order 2 packets of 1L milk');
    expect(intent.items[0].requestedQuantity).toBe(2);
    expect(intent.items[0].requestedUnit).toBe('packet');
    expect(intent.items[0].packSizePreference?.value).toBe(1);
    expect(intent.items[0].packSizePreference?.unit).toBe('litre');

    const norm = normalizeQuantityAndPack(
      intent.items[0].requestedQuantity,
      intent.items[0].requestedUnit,
      milkItem1L
    );

    expect(norm.orderQuantity).toBe(2);
    expect(norm.unitPriceCents).toBe(6500);
    expect(norm.totalPriceCents).toBe(13000); // ₹130
  });

  // TEST 4: Input: 2 litres of milk -> Catalog: 1L per pack, ₹65 -> Expected: 2 packs, total ₹130
  it('TEST 4: correctly interprets "2 litres of milk" with 1L packs as 2 packs, total ₹130', () => {
    const intent = extractShoppingIntent('Order 2 litres of milk');
    expect(intent.items[0].requestedQuantity).toBe(2);
    expect(intent.items[0].requestedUnit).toBe('litre');

    const norm = normalizeQuantityAndPack(
      intent.items[0].requestedQuantity,
      intent.items[0].requestedUnit,
      milkItem1L
    );

    expect(norm.orderQuantity).toBe(2);
    expect(norm.unitPriceCents).toBe(6500);
    expect(norm.totalPriceCents).toBe(13000); // ₹130
    expect(norm.actualSuppliedQuantity).toBe(2);
    expect(norm.actualSuppliedUnit).toBe('L');
  });

  // TEST 5: Input: Bread and Maggi -> Expected: Two independent product requirements and separate MCP searches
  it('TEST 5: extracts "Bread and Maggi" as two independent product requirements with brand normalization', async () => {
    const intent = extractShoppingIntent('Order bread and maggie');
    expect(intent.items.length).toBe(2);

    expect(intent.items[0].product.toLowerCase()).toContain('bread');
    expect(intent.items[0].requestedQuantity).toBe(1);

    // Normalizes "maggie" -> brand: "Maggi", product: "Maggi noodles"
    expect(intent.items[1].brand).toBe('Maggi');
    expect(intent.items[1].product.toLowerCase()).toContain('noodles');

    // Verify independent searches are performed
    const swiggyTransport = new MockMcpTransport();
    const searchedQueries: string[] = [];
    swiggyTransport.registerToolHandler('swiggy_im_search_items', async (args: any) => {
      searchedQueries.push(String(args.query || ''));
      return { items: [breadItem] };
    });
    swiggyTransport.registerToolHandler('swiggy_im_delivery_estimate', async () => ({
      serviceable: true,
      platform: 'swiggy_instamart',
      pincode: '560103',
      etaMinutes: 14,
      deliveryFeeCents: 2500,
      freeDeliveryThresholdCents: 19900,
      surgeFeeCents: 0,
    }));
    swiggyTransport.registerToolHandler('swiggy_im_create_cart', async () => ({
      platform: 'swiggy_instamart',
      merchantName: 'Swiggy Instamart',
      items: [{ itemId: breadItem.id, quantity: 1, unitPriceCents: 5000 }],
      subtotalCents: 5000,
      deliveryFeeCents: 2500,
      taxCents: 250,
      totalAmountCents: 7750,
      currency: 'INR',
      etaMinutes: 14,
      isAvailable: true,
      cartId: 'swiggy_cart_test',
    }));
    swiggyTransport.initialize();

    const swiggyClient = new SwiggyMcpClient(swiggyTransport);
    quickCommerceMcpManager.setClients(swiggyClient, new ZeptoMcpClient(new MockMcpTransport()));

    await quickCommerceMcpManager.compareAndAssembleBasket(
      [
        { name: intent.items[0].product, quantity: 1 },
        { name: intent.items[1].product, brand: intent.items[1].brand || undefined, quantity: 1 },
      ],
      blrLocation,
      'swiggy'
    );

    // Two independent queries must have been sent
    expect(searchedQueries.length).toBe(2);
    expect(searchedQueries.some((q) => q.toLowerCase().includes('bread'))).toBe(true);
    expect(searchedQueries.some((q) => q.toLowerCase().includes('maggi'))).toBe(true);
  });

  // TEST 6: Input: Maggi Masala Noodles -> Catalog: Only another brand of instant noodles -> Expected: Alternative classification, not exact match
  it('TEST 6: classifies another brand of instant noodles as ALTERNATIVE (never EXACT_MATCH) when Maggi Masala Noodles is requested', () => {
    const match = quickCommerceMcpManager.matchEquivalentProduct(
      {
        name: 'Maggi Masala Noodles',
        brand: 'Maggi',
        quantity: 1,
        requestedQuantity: 1,
        requestedUnit: 'packet',
      },
      [yippeeNoodlesItem] // Catalog only has Sunfeast YiPPee!
    );

    expect(match.matchClassification).toBe('ALTERNATIVE');
    expect(match.isAlternative).toBe(true);
    expect(match.matchClassification).not.toBe('EXACT_MATCH');
    expect(match.brandMatch).toBe(false);
    expect(match.status).toBe('brand_mismatch');
    expect(match.alternativeReason).toContain('Requested brand "Maggi" is not available');
    expect(match.matchedItem?.name).toContain('YiPPee');
  });

  // TEST 7: Input: 6 eggs -> Catalog: Only 6-piece package available -> Expected: 1 package, not 6 packages
  it('TEST 7: orders exactly 1 package (not 6 packages) when user asks for 6 eggs and catalog has 6-piece pack', () => {
    const match = quickCommerceMcpManager.matchEquivalentProduct(
      {
        name: 'eggs',
        quantity: 6,
        requestedQuantity: 6,
        requestedUnit: 'piece',
      },
      [eggItem6Pack]
    );

    expect(match.orderQuantity).toBe(1);
    expect(match.orderQuantity).not.toBe(6); // Guarantees NOT 6 packages
    expect(match.totalPriceCents).toBe(4800);
    expect(match.matchClassification).toBe('COMPATIBLE_MATCH');
  });

  // TEST 8: Input: Order 2 packets of milk and 6 eggs -> Expected: Both products correctly extracted, quantities normalized and totals calculated
  it('TEST 8: extracts both products, normalizes quantities, and calculates correct basket total for "2 packets of milk and 6 eggs"', () => {
    const intent = extractShoppingIntent('Order 2 packets of milk and 6 eggs');
    expect(intent.items.length).toBe(2);

    // Item 1: 2 packets of milk
    expect(intent.items[0].product.toLowerCase()).toContain('milk');
    expect(intent.items[0].requestedQuantity).toBe(2);
    expect(intent.items[0].requestedUnit).toBe('packet');

    // Item 2: 6 eggs
    expect(intent.items[1].product.toLowerCase()).toContain('egg');
    expect(intent.items[1].requestedQuantity).toBe(6);
    expect(intent.items[1].requestedUnit).toBe('piece');

    const milkNorm = normalizeQuantityAndPack(intent.items[0].requestedQuantity, intent.items[0].requestedUnit, milkItem1L);
    const eggNorm = normalizeQuantityAndPack(intent.items[1].requestedQuantity, intent.items[1].requestedUnit, eggItem6Pack);

    // 2 packs milk @ ₹65 = ₹130
    expect(milkNorm.orderQuantity).toBe(2);
    expect(milkNorm.totalPriceCents).toBe(13000);

    // 1 pack eggs (6 pcs) @ ₹48 = ₹48
    expect(eggNorm.orderQuantity).toBe(1);
    expect(eggNorm.totalPriceCents).toBe(4800);

    // Basket Total: ₹130 + ₹48 = ₹178 subtotal
    const totals = calculateBasketTotals([
      { orderQuantity: milkNorm.orderQuantity, unitPriceCents: milkNorm.unitPriceCents },
      { orderQuantity: eggNorm.orderQuantity, unitPriceCents: eggNorm.unitPriceCents },
    ], { platform: 'zepto' });

    expect(totals.subtotalCents).toBe(17800); // ₹178.00
    expect(totals.taxCents).toBe(Math.round(17800 * 0.05)); // ₹8.90 = 890 paise
    // Free delivery on Zepto (₹178 >= ₹149 threshold)
    expect(totals.deliveryFeeCents).toBe(0);
    expect(totals.totalAmountCents).toBe(totals.subtotalCents + totals.taxCents);
  });

  // TEST 9: Input: Product basket under ₹300 -> Expected: Basket must not pass budget validation if actual total exceeds ₹300
  it('TEST 9: rejects order proposal when actual basket total exceeds the specified budget limit (e.g. ₹300)', () => {
    const expensiveProposal: any = {
      platform: 'zepto',
      merchantName: 'Zepto',
      items: [
        {
          itemId: 'item_1',
          name: 'Nandini Milk',
          quantity: 2,
          unitPriceCents: 6500,
          totalPriceCents: 13000,
          isPriceVerified: true,
        },
        {
          itemId: 'item_2',
          name: 'Imported Cheese Block',
          quantity: 1,
          unitPriceCents: 25000, // ₹250
          totalPriceCents: 25000,
          isPriceVerified: true,
        },
      ],
      subtotalCents: 38000,
      deliveryFeeCents: 0,
      handlingFeeCents: 0,
      taxCents: 1900,
      totalAmountCents: 39900, // ₹399.00 (Exceeds ₹300 budget)
      currency: 'INR',
      etaMinutes: 10,
      deliveryAddress: blrLocation,
      isAvailable: true,
      cartId: 'cart_test_expensive',
      isPriceVerified: true,
      budgetExceeded: true,
      excessAmountCents: 9900,
      orderStatus: 'REJECTED',
    };

    const validation = orderValidator.validatePrePurchase(
      SUSHMITA_USER.id,
      expensiveProposal,
      30000 // ₹300.00 daily spend limit
    );

    expect(validation.valid).toBe(false);
    expect(validation.budgetAllowed).toBe(false);
    expect(validation.errorMessage).toMatch(/budget|limit|allowance|exceeds/i);
  });

  // TEST 10: Input: Bread and Maggi, where Maggi is unavailable -> Expected: Partial fulfillment status, never claim complete basket is verified
  it('TEST 10: sets PARTIALLY_FULFILLED status when Bread is available but Maggi is unavailable, never claiming complete basket is verified', async () => {
    const swiggyTransport = new MockMcpTransport();
    swiggyTransport.registerToolHandler('swiggy_im_search_items', async (args: any) => {
      const q = String(args.query || '').toLowerCase();
      if (q.includes('bread')) {
        return { items: [breadItem] };
      }
      return { items: [] }; // Maggi is unavailable
    });
    swiggyTransport.registerToolHandler('swiggy_im_delivery_estimate', async () => ({
      serviceable: true,
      platform: 'swiggy_instamart',
      pincode: '560103',
      etaMinutes: 14,
      deliveryFeeCents: 2500,
      freeDeliveryThresholdCents: 19900,
      surgeFeeCents: 0,
    }));
    swiggyTransport.registerToolHandler('swiggy_im_create_cart', async (args: any) => ({
      platform: 'swiggy_instamart',
      merchantName: 'Swiggy Instamart',
      items: args.items.map((it: any) => ({ itemId: it.itemId, quantity: it.quantity, unitPriceCents: 5000 })),
      subtotalCents: 5000,
      deliveryFeeCents: 2500,
      taxCents: 250,
      totalAmountCents: 7750,
      currency: 'INR',
      etaMinutes: 14,
      isAvailable: false,
      cartId: 'swiggy_partial_cart',
    }));
    swiggyTransport.initialize();

    const swiggyClient = new SwiggyMcpClient(swiggyTransport);
    quickCommerceMcpManager.setClients(swiggyClient, new ZeptoMcpClient(new MockMcpTransport()));

    const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
      [
        { name: 'bread', quantity: 1 },
        { name: 'Maggi noodles', brand: 'Maggi', quantity: 1 },
      ],
      blrLocation,
      'swiggy'
    );

    expect(comparison.recommendedProposal.orderStatus).toBe('PARTIALLY_FULFILLED');
    expect(comparison.recommendedProposal.constraintValidation?.allPassed).toBe(false);
    expect(comparison.recommendedProposal.isAvailable).toBe(false);
    expect(comparison.recommendedProposal.unavailableItems).toBeDefined();
    expect(comparison.recommendedProposal.unavailableItems).toContain('Maggi noodles');
    expect(comparison.recommendationReason).toContain('Partially fulfilled');
  });

  // Additional Tests:
  // Edge Case A: Disclose actual quantity when user requests fewer pieces than pack size
  it('discloses actual supplied quantity when user requests 2 eggs but smallest pack is 6 eggs', () => {
    const norm = normalizeQuantityAndPack(2, 'piece', eggItem6Pack);
    expect(norm.orderQuantity).toBe(1);
    expect(norm.actualSuppliedQuantity).toBe(6);
    expect(norm.discloseSuppliedDiff).toBe(true);
    expect(norm.disclosureNote).toContain('Requested 2 eggs');
    expect(norm.totalPriceCents).toBe(4800);
  });

  // Edge Case B: Missing pack size fallback
  it('gracefully handles catalog items with missing pack-size metadata without throwing', () => {
    const itemWithoutPack: QuickCommerceItem = {
      id: 'item_generic',
      platform: 'zepto',
      merchantName: 'Zepto',
      name: 'Organic Honey',
      priceCents: 15000,
      currency: 'INR',
      inStock: true,
      isPriceVerified: true,
    };

    const norm = normalizeQuantityAndPack(2, 'packet', itemWithoutPack);
    expect(norm.orderQuantity).toBe(2);
    expect(norm.totalPriceCents).toBe(30000);
  });

  // Edge Case C: Out of stock product rejection
  it('rejects out of stock item and does not mark as verified match', () => {
    const oosItem: QuickCommerceItem = {
      ...eggItem6Pack,
      inStock: false,
    };
    const match = quickCommerceMcpManager.matchEquivalentProduct(
      { name: 'eggs', quantity: 6 },
      [oosItem]
    );
    expect(match.inStock).toBe(false);
    expect(match.status).toBe('out_of_stock');
    expect(match.matchClassification).toBe('NO_MATCH');
  });
});
