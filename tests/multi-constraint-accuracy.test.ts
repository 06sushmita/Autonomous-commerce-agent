import { describe, it, expect, beforeEach } from 'vitest';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import { SwiggyMcpClient } from '../src/mcp/swiggy-mcp.js';
import { ZeptoMcpClient } from '../src/mcp/zepto-mcp.js';
import { AutonomousCommerceRunner } from '../src/agent/runner.js';
import { orderValidator } from '../src/agent/order-validator.js';
import { authProvider, SUSHMITA_USER } from '../src/auth/index.js';
import { spendTracker } from '../src/db/spend-tracker.js';
import {
  createTestSwiggyTransport,
  createTestZeptoTransport,
} from './fixtures/test-mcp-transports.js';
import { DeliveryLocation, QuickCommerceItem } from '../src/mcp/types.js';

describe('Multi-Constraint Product Fetching & Accuracy Suite', () => {
  const blrLocation: DeliveryLocation = {
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
    pincode: '560103',
    latitude: 12.9298,
    longitude: 77.6835,
  };

  let runner: AutonomousCommerceRunner;

  beforeEach(() => {
    authProvider.reset();
    authProvider.seedVerifiedClerkProfiles();
    authProvider.seedUser({ ...SUSHMITA_USER });
    authProvider.setActiveUser(SUSHMITA_USER.id);
    spendTracker.clear();
    quickCommerceMcpManager.setClients(
      new SwiggyMcpClient(createTestSwiggyTransport()),
      new ZeptoMcpClient(createTestZeptoTransport())
    );
    runner = new AutonomousCommerceRunner();
  });

  describe('1. Brand Constraint Enforcement (Fail-Closed on Brand Mismatch)', () => {
    it('accurately matches requested brand "Nandini" when available in catalog', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_amul_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Toned Milk',
          brand: 'Amul',
          priceCents: 4200,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
        {
          id: 'item_nandini_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Pasteurized Toned Milk',
          brand: 'Nandini',
          priceCents: 4200,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', quantity: 1 },
        items,
        10
      );

      expect(match.brandMatch).toBe(true);
      expect(match.status).toBe('verified_match');
      expect(match.matchedItem?.id).toBe('item_nandini_milk');
    });

    it('rejects candidate items when requested brand is not stocked (status: brand_mismatch)', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_amul_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Toned Milk',
          brand: 'Amul',
          priceCents: 4200,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', quantity: 1 },
        items,
        10
      );

      expect(match.brandMatch).toBe(false);
      expect(match.status).toBe('brand_mismatch');
      expect(match.rejectionReason).toContain('Requested brand "Nandini" is not available');
    });
  });

  describe('2. Cost Constraint Enforcement (Fail-Closed on Budget Exceeded)', () => {
    it('approves product when live verified price is within specified cost limit', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_nandini_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Toned Milk',
          brand: 'Nandini',
          priceCents: 4200, // ₹42.00
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', maxCostCents: 5000, quantity: 1 }, // max ₹50.00
        items,
        10
      );

      expect(match.costMatch).toBe(true);
      expect(match.status).toBe('verified_match');
      expect(match.unitPriceCents).toBe(4200);
    });

    it('rejects product when live verified price exceeds specified cost limit (status: cost_exceeded)', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_nandini_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Toned Milk',
          brand: 'Nandini',
          priceCents: 4200, // ₹42.00
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', maxCostCents: 3500, quantity: 1 }, // max ₹35.00
        items,
        10
      );

      expect(match.costMatch).toBe(false);
      expect(match.status).toBe('cost_exceeded');
      expect(match.rejectionReason).toContain('exceeds maximum budget limit');
    });
  });

  describe('3. Quantity, Live Price & Stock Verification (Zero Demo Data)', () => {
    it('rejects unverified prices and items without live merchant confirmation', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_unverified_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Milk (Fabricated Fallback)',
          brand: 'Nandini',
          priceCents: 4200,
          currency: 'INR',
          inStock: true,
          isPriceVerified: false, // UNVERIFIED DEMO/ESTIMATE
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', quantity: 1 },
        items,
        10
      );

      expect(match.isVerified).toBe(false);
      expect(match.status).toBe('unverified');
      expect(match.rejectionReason).toContain('unverified');
    });

    it('rejects candidate items when dark store is out of stock', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_oos_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Milk',
          brand: 'Nandini',
          priceCents: 4200,
          currency: 'INR',
          inStock: false, // OUT OF STOCK
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(
        { name: 'milk', brand: 'Nandini', quantity: 1 },
        items,
        10
      );

      expect(match.inStock).toBe(false);
      expect(match.status).toBe('out_of_stock');
      expect(match.rejectionReason).toContain('currently out of stock');
    });
  });

  describe('4. Time Constraint / Delivery SLA Enforcement & Automatic Routing', () => {
    it('automatically routes to Zepto (10 mins) and rejects Swiggy (14 mins) when user requires under 12 mins', async () => {
      // Swiggy transport returns ETA: 14 mins, Zepto transport returns ETA: 10 mins
      const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
        [
          {
            name: 'milk',
            brand: 'Nandini',
            quantity: 1,
            maxEtaMinutes: 12, // requires under 12 minutes
          },
        ],
        blrLocation
      );

      // Zepto must be chosen because 10 mins <= 12 mins
      expect(comparison.recommendedProposal.platform).toBe('zepto');
      expect(comparison.recommendedProposal.etaMinutes).toBe(10);
      expect(comparison.recommendedProposal.constraintValidation?.allPassed).toBe(true);
      const swiggyMatch = comparison.productMatches?.swiggy?.[0];
      expect(swiggyMatch).toBeDefined();
      expect(swiggyMatch?.etaMatch).toBe(false);
      expect(swiggyMatch?.status).toBe('eta_exceeded');
    });

    it('fails closed when delivery time constraint cannot be met by any merchant dark store', async () => {
      // Neither Swiggy (14 mins) nor Zepto (10 mins) can deliver in under 8 mins
      await expect(
        quickCommerceMcpManager.compareAndAssembleBasket(
          [
            {
              name: 'milk',
              brand: 'Nandini',
              quantity: 1,
              maxEtaMinutes: 8, // requires under 8 minutes
            },
          ],
          blrLocation
        )
      ).rejects.toThrow(/could not be fulfilled according to specified constraints/i);
    });
  });

  describe('5. Order Validator Multi-Constraint Gate', () => {
    it('blocks pre-purchase approval if constraintValidation.allPassed is false', () => {
      const mockProposal: any = {
        platform: 'zepto',
        merchantName: 'Zepto',
        items: [
          {
            itemId: 'item_1',
            name: 'Nandini Milk',
            quantity: 1,
            unitPriceCents: 4200,
            isPriceVerified: true,
          },
        ],
        totalAmountCents: 6200,
        currency: 'INR',
        etaMinutes: 10,
        deliveryAddress: blrLocation,
        isAvailable: true,
        cartId: 'cart_1',
        isPriceVerified: true,
        constraintValidation: {
          allPassed: false, // FAILED CONSTRAINT
          brandAccepted: false,
          costAccepted: true,
          quantityAccepted: true,
          etaAccepted: true,
          details: ['Brand constraint violated'],
        },
      };

      const result = orderValidator.validatePrePurchase('user_123', mockProposal, 500000, true);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('Constraint check failed');
    });
  });

  describe('6. End-to-End Natural Language Parsing & Session Runner', () => {
    it('correctly parses all 5 constraints from natural language prompt', () => {
      const parsed = runner.parseQueryToGroceryItems(
        'Find me Nandini milk under ₹50 and Amul butter under 65 rs in under 15 mins'
      );

      expect(parsed.length).toBe(2);

      // Item 1: Nandini milk
      expect(parsed[0].name.toLowerCase()).toContain('milk');
      expect(parsed[0].brand).toBe('Nandini');
      expect(parsed[0].maxCostCents).toBe(5000); // ₹50
      expect(parsed[0].maxEtaMinutes).toBe(15);
      expect(parsed[0].quantity).toBe(1);

      // Item 2: Amul butter
      expect(parsed[1].name.toLowerCase()).toContain('butter');
      expect(parsed[1].brand).toBe('Amul');
      expect(parsed[1].maxCostCents).toBe(6500); // ₹65
      expect(parsed[1].maxEtaMinutes).toBe(15);
      expect(parsed[1].quantity).toBe(1);
    });

    it('executes shopping turn successfully when all 5 constraints are acceptable', async () => {
      const session = await runner.initializeSession(SUSHMITA_USER.id);
      const turn = await runner.processShoppingTurn(
        session.sessionId,
        'Nandini milk under ₹50 in under 15 mins',
        { confirmed: true, override: blrLocation }
      );

      expect(turn.proposal).toBeDefined();
      expect(turn.proposal.constraintValidation?.allPassed).toBe(true);
      expect(turn.proposal.constraintValidation?.brandAccepted).toBe(true);
      expect(turn.proposal.constraintValidation?.costAccepted).toBe(true);
      expect(turn.proposal.constraintValidation?.etaAccepted).toBe(true);
      expect(turn.mandateBundle).toBeDefined();
      expect(turn.passkeyRequired).toBe(true);
    });

    it('fails closed when prompt specifies an unmeetable cost constraint (no mock fallback)', async () => {
      const session = await runner.initializeSession(SUSHMITA_USER.id);

      // Requesting milk under ₹20 (actual is ₹42.00)
      await expect(
        runner.processShoppingTurn(
          session.sessionId,
          'Nandini milk under ₹20 in under 15 mins',
          { confirmed: true, override: blrLocation }
        )
      ).rejects.toThrow(/could not be fulfilled according to specified constraints/i);
    });

    it('fails closed when prompt specifies an unmeetable time constraint (no mock fallback)', async () => {
      const session = await runner.initializeSession(SUSHMITA_USER.id);

      // Requesting milk within 5 mins (fastest dark store is 10 mins)
      await expect(
        runner.processShoppingTurn(
          session.sessionId,
          'Nandini milk in under 5 mins',
          { confirmed: true, override: blrLocation }
        )
      ).rejects.toThrow(/could not be fulfilled according to specified constraints/i);
    });
  });

  describe('7. Constraint Priority Hierarchy (Price, Quantity, Product, Brand) and Top 5 Limit', () => {
    it('limits catalog search results to strictly at most top 5 items', () => {
      const manyItems: QuickCommerceItem[] = Array.from({ length: 50 }, (_, i) => ({
        id: `item_${i}`,
        platform: 'zepto',
        merchantName: 'Zepto',
        name: `Dairy Milk Chocolate ${i}`,
        brand: 'Cadbury',
        priceCents: (i + 1) * 1000,
        currency: 'INR',
        inStock: true,
        unit: '1 pc',
        isPriceVerified: true,
      }));

      const top5 = quickCommerceMcpManager.rankTopItems(manyItems, { query: 'milk', limit: 5 });
      expect(top5.length).toBe(5);
    });

    it('prioritizes lowest verified price ("prize" #1 constraint) first among matching items', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_milk_expensive',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Organic Farm Fresh Milk 1L',
          priceCents: 8500, // ₹85
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
        {
          id: 'item_milk_cheapest',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Pasteurized Toned Milk 1L',
          priceCents: 4200, // ₹42
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
        {
          id: 'item_milk_medium',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Toned Milk 1L',
          priceCents: 5400, // ₹54
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const ranked = quickCommerceMcpManager.rankTopItems(items, { query: 'milk' });
      expect(ranked[0].id).toBe('item_milk_cheapest');
      expect(ranked[0].priceCents).toBe(4200);
      expect(ranked[1].id).toBe('item_milk_medium');
      expect(ranked[2].id).toBe('item_milk_expensive');
    });

    it('prioritizes quantity/inStock (#2 constraint) over cheaper out-of-stock items', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_milk_oos_cheap',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Super Cheap Toned Milk',
          priceCents: 2000, // ₹20 (very cheap but OUT OF STOCK)
          currency: 'INR',
          inStock: false,
          unit: '1 L',
          isPriceVerified: true,
        },
        {
          id: 'item_milk_in_stock',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Toned Milk',
          priceCents: 4200, // ₹42 (IN STOCK)
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const ranked = quickCommerceMcpManager.rankTopItems(items, { query: 'milk' });
      expect(ranked[0].id).toBe('item_milk_in_stock');
      expect(ranked[0].inStock).toBe(true);
    });

    it('prioritizes core product match (#3 constraint) over brand false-positives', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_lassi_cheap',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Mango Lassi', // Same brand, but NOT milk!
          brand: 'Nandini',
          category: 'Beverages',
          priceCents: 1500, // ₹15 (cheaper)
          currency: 'INR',
          inStock: true,
          unit: '200 ml',
          isPriceVerified: true,
        },
        {
          id: 'item_nandini_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Toned Fresh Milk',
          brand: 'Nandini',
          category: 'Dairy',
          priceCents: 2400, // ₹24
          currency: 'INR',
          inStock: true,
          unit: '500 ml',
          isPriceVerified: true,
        },
      ];

      const ranked = quickCommerceMcpManager.rankTopItems(items, { query: 'milk' });
      expect(ranked[0].id).toBe('item_nandini_milk');
      expect(ranked[0].name).toContain('Milk');
    });

    it('honors requested brand (#4 constraint) when target brand is specified', () => {
      const items: QuickCommerceItem[] = [
        {
          id: 'item_amul_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Milk',
          brand: 'Amul',
          category: 'Dairy',
          priceCents: 4000,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
        {
          id: 'item_nandini_milk',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Pasteurized Toned Milk',
          brand: 'Nandini',
          category: 'Dairy',
          priceCents: 4200,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          isPriceVerified: true,
        },
      ];

      const ranked = quickCommerceMcpManager.rankTopItems(items, { query: 'milk', targetBrand: 'Nandini' });
      expect(ranked[0].id).toBe('item_nandini_milk');
      expect(ranked[0].brand).toBe('Nandini');
    });

    it('searchAllMerchants returns at most 5 items per platform', async () => {
      const results = await quickCommerceMcpManager.searchAllMerchants('milk', blrLocation);
      expect(results.swiggyItems.length).toBeGreaterThan(0);
      expect(results.swiggyItems.length).toBeLessThanOrEqual(5);
      expect(results.zeptoItems.length).toBeGreaterThan(0);
      expect(results.zeptoItems.length).toBeLessThanOrEqual(5);
    });
  });
});
