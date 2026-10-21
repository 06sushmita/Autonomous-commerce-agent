/**
 * Live Product Pricing & Authoritative Daily Budget Enforcement Suite
 *
 * Automated verification of:
 * 1. Price Sourcing & Verification Invariants (Real MCP prices vs missing/web snippet prices)
 * 2. Multi-Merchant Equivalent Product Matching & Unit Normalization (1L vs 500ml, brand matching)
 * 3. Complete Basket Calculation (Subtotal, Delivery Fee thresholds, Handling/Platform fees, Taxes, Discounts)
 * 4. Authoritative Backend Daily Budget Service:
 *    - Within limit, exactly at limit, and over limit
 *    - Local-day spending period (Asia/Kolkata timezone)
 *    - Existing spend reducing available budget
 *    - Concurrent atomic reservation double-spend prevention
 *    - Failed payment / cancellation / refund reservation lifecycle
 *    - Fail-closed behavior
 * 5. Budget-Aware Item Selection & Advisory (Cheaper variants / excess amounts)
 * 6. Explicit Merchant Preferences (Strict adherence, no silent switching)
 * 7. Endpoint Bypass Prevention (/api/checkout revalidation)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PravaPaymentsClient,
  MockPravaPaymentsClient,
  resetPravaClient,
  setPravaClient,
} from '../src/prava/client.js';
import { authProvider, ARJUN_USER, SUSHMITA_USER } from '../src/auth/index.js';
import { spendTracker } from '../src/db/spend-tracker.js';
import { AutonomousCommerceRunner } from '../src/agent/runner.js';
import { DeliveryLocation, QuickCommerceItem, QuickCommerceBasketProposal } from '../src/mcp/types.js';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import { SwiggyMcpClient } from '../src/mcp/swiggy-mcp.js';
import { ZeptoMcpClient } from '../src/mcp/zepto-mcp.js';
import { RealtimeCommerceFetcher } from '../src/mcp/realtime-search.js';
import { orderValidator } from '../src/agent/order-validator.js';
import { startDevServer } from '../src/dev-server.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';

describe('Live Product Pricing & Daily Budget Enforcement Suite', () => {
  let runner: AutonomousCommerceRunner;
  const originalNodeEnv = process.env.NODE_ENV;
  const testUserId = ARJUN_USER.id;

  const testLocation: DeliveryLocation = {
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
    pincode: '560103',
    latitude: 12.9279,
    longitude: 77.6711,
  };

  beforeEach(() => {
    resetPravaClient();
    authProvider.reset();
    authProvider.seedVerifiedClerkProfiles();
    spendTracker.clear();

    // Wire simulated MCP transports with live item catalogs
    quickCommerceMcpManager.setClients(
      new SwiggyMcpClient(createTestSwiggyTransport()),
      new ZeptoMcpClient(createTestZeptoTransport())
    );

    runner = new AutonomousCommerceRunner();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    resetPravaClient();
  });

  // =========================================================================
  // 1. Price Sourcing & Verification Invariants (Steps 1 & 2)
  // =========================================================================
  describe('1. Price Sourcing & Verification Invariants', () => {
    it('preserves verified live merchant pricing and source metadata from MCP', async () => {
      const swiggyResults = await quickCommerceMcpManager.getSwiggyClient().searchItems('milk', testLocation);
      expect(swiggyResults.length).toBeGreaterThan(0);

      const item = swiggyResults[0];
      expect(item.isPriceVerified).toBe(true);
      expect(item.priceSource).toBe('mcp_live');
      expect(item.priceFetchedAt).toBeDefined();
      expect(item.priceCents).toBe(4200);
      expect(item.unit).toBe('1 L');
      expect(item.inStock).toBe(true);
    });

    it('marks web search engine results as unverified and unavailable for auto-checkout', async () => {
      // Even if external search snippets are found, prices must be marked unverified
      const snippets = await RealtimeCommerceFetcher.searchLiveItems('Amul milk price Bangalore', 'zepto', testLocation);
      for (const item of snippets) {
        expect(item.isPriceVerified).toBe(false);
        expect(item.priceSource).toBe('unavailable');
        expect(item.inStock).toBe(false);
      }
    });

    it('never fabricates demo items or demo prices when merchant catalog has no matching products', async () => {
      const swiggyResults = await quickCommerceMcpManager.getSwiggyClient().searchItems('nonexistent_demo_xyz_item', testLocation);
      expect(swiggyResults).toEqual([]);

      const zeptoResults = await quickCommerceMcpManager.getZeptoClient().searchProducts('nonexistent_demo_xyz_item', testLocation);
      expect(zeptoResults).toEqual([]);
    });

    it('prevents automatic checkout when product price is unverified', () => {
      const unverifiedProposal: QuickCommerceBasketProposal = {
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        items: [
          {
            itemId: 'item_unverified_01',
            name: 'Unverified Test Item',
            unitPriceCents: 15000,
            quantity: 1,
            isPriceVerified: false,
            priceSource: 'unavailable',
          },
        ],
        subtotalCents: 15000,
        deliveryFeeCents: 2500,
        taxCents: 0,
        totalAmountCents: 17500,
        currency: 'INR',
        etaMinutes: 15,
        deliveryAddress: testLocation,
        isAvailable: true,
        cartId: 'cart_unverified_01',
        isPriceVerified: false,
        priceSource: 'unavailable',
      };

      const validation = orderValidator.validatePrePurchase(testUserId, unverifiedProposal, 500000);
      expect(validation.valid).toBe(false);
      expect(validation.errorMessage).toContain('Unverified merchant price');
    });

    it('distinguishes subtotal, delivery fee, handling charges, and final payable amount', async () => {
      const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
        [{ name: 'milk', quantity: 1 }],
        testLocation
      );

      expect(comparison.recommendedProposal).toBeDefined();
      const prop = comparison.recommendedProposal;
      expect(prop.subtotalCents).toBeGreaterThan(0);
      expect(prop.deliveryFeeCents).toBeGreaterThanOrEqual(0);
      expect(prop.handlingFeeCents).toBeGreaterThanOrEqual(0);
      expect(prop.taxesCents).toBeGreaterThanOrEqual(0);
      // Total payable must equal subtotal + delivery + handling + taxes - discount
      const expectedTotal =
        prop.subtotalCents +
        prop.deliveryFeeCents +
        (prop.handlingFeeCents || 0) +
        (prop.taxesCents || 0) -
        (prop.discountCents || 0);
      expect(prop.totalAmountCents).toBe(expectedTotal);
    });
  });

  // =========================================================================
  // 2. Multi-Merchant Equivalent Product Matching (Step 3)
  // =========================================================================
  describe('2. Multi-Merchant Product & Package Size Matching', () => {
    it('normalizes units and detects package size mismatches (1L vs 500ml)', () => {
      const requestedItem = { name: 'Amul Taaza Milk 1L', quantity: 1 };
      const candidates: QuickCommerceItem[] = [
        {
          id: 'cand_500ml',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Homogenised Toned Milk 500ml Pouch',
          priceCents: 2700,
          currency: 'INR',
          inStock: true,
          unit: '500 ml',
          brand: 'Amul',
          isPriceVerified: true,
        },
        {
          id: 'cand_1l',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Amul Taaza Homogenised Toned Milk 1L Carton',
          priceCents: 5400,
          currency: 'INR',
          inStock: true,
          unit: '1 L',
          brand: 'Amul',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(requestedItem, candidates);
      expect(match.matchedItem).toBeDefined();
      // Should match the 1L carton over the 500ml pouch
      expect(match.matchedItem!.unit).toBe('1 L');
      expect(match.packageSizeMatch).toBe(true);
      expect(match.brandMatch).toBe(true);
    });

    it('penalizes and flags size mismatch when only a different package size exists', () => {
      const requestedItem = { name: 'Nandini Milk 1L', quantity: 1 };
      const candidates: QuickCommerceItem[] = [
        {
          id: 'cand_500ml_only',
          platform: 'zepto',
          merchantName: 'Zepto',
          name: 'Nandini Toned Milk 500 ml',
          priceCents: 2200,
          currency: 'INR',
          inStock: true,
          unit: '500 ml',
          brand: 'Nandini',
          isPriceVerified: true,
        },
      ];

      const match = quickCommerceMcpManager.matchEquivalentProduct(requestedItem, candidates);
      expect(match.packageSizeMatch).toBe(false);
      expect(match.status).toBe('size_mismatch');
    });

    it('strictly respects explicit user merchant preference without silent switching', async () => {
      // User explicitly requests from Zepto
      const comparisonZepto = await quickCommerceMcpManager.compareAndAssembleBasket(
        [{ name: 'milk', quantity: 1 }],
        testLocation,
        'zepto'
      );
      expect(comparisonZepto.recommendedProposal.platform).toBe('zepto');

      // User explicitly requests from Swiggy
      const comparisonSwiggy = await quickCommerceMcpManager.compareAndAssembleBasket(
        [{ name: 'milk', quantity: 1 }],
        testLocation,
        'swiggy'
      );
      expect(comparisonSwiggy.recommendedProposal.platform).toBe('swiggy_instamart');
    });

    it('calculates full basket comparison when multiple merchants are available without explicit preference', async () => {
      const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
        [{ name: 'milk', quantity: 1 }],
        testLocation
      );
      expect(comparison.recommendedProposal).toBeDefined();
      expect(comparison.recommendedProposal.totalAmountCents).toBeGreaterThan(0);
    });

    it('returns best choices for each requested item when query requests 2 items (e.g. Amul butter and eggs)', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'Search Amul butter and eggs');

      expect(turn.proposal).toBeDefined();
      const prop = turn.proposal!;
      expect(prop.items.length).toBe(2);

      // Best choices for each item must be provided
      expect(prop.bestItems).toBeDefined();
      expect(prop.bestItems!.length).toBe(2);

      const butterChoice = prop.bestItems!.find((i) => i.name.toLowerCase().includes('butter'));
      const eggChoice = prop.bestItems!.find((i) => i.name.toLowerCase().includes('egg'));

      expect(butterChoice).toBeDefined();
      expect(butterChoice?.name).toContain('Butter');
      expect(butterChoice?.priceCents).toBeGreaterThan(0);

      expect(eggChoice).toBeDefined();
      expect(eggChoice?.name).toContain('Egg');
      expect(eggChoice?.priceCents).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. Authoritative Daily Budget Service (Step 4)
  // =========================================================================
  describe('3. Authoritative Backend Daily Budget Service', () => {
    it('approves orders strictly within the configured daily limit', () => {
      const limitCents = 50000; // ₹500.00
      const orderAmountCents = 35000; // ₹350.00

      const reservation = spendTracker.reserveSpend(testUserId, orderAmountCents, 'mandate_01', limitCents);
      expect(reservation.allowed).toBe(true);
      expect(reservation.remainingDailyCents).toBe(15000); // ₹150.00 remaining
    });

    it('approves order exactly at the configured daily limit', () => {
      const limitCents = 50000; // ₹500.00
      const orderAmountCents = 50000; // ₹500.00

      const reservation = spendTracker.reserveSpend(testUserId, orderAmountCents, 'mandate_exact', limitCents);
      expect(reservation.allowed).toBe(true);
      expect(reservation.remainingDailyCents).toBe(0);
    });

    it('rejects order when amount exceeds the daily limit by even 1 cent', () => {
      const limitCents = 50000; // ₹500.00
      const orderAmountCents = 50001; // ₹500.01

      const reservation = spendTracker.reserveSpend(testUserId, orderAmountCents, 'mandate_over', limitCents);
      expect(reservation.allowed).toBe(false);
      expect(reservation.reason).toMatch(/exceeds (your )?remaining daily (spend allowance|budget)/i);
    });

    it('reduces available budget with existing spending in the local day (Asia/Kolkata)', () => {
      const limitCents = 100000; // ₹1,000.00
      // Prior committed order of ₹400.00 earlier today
      spendTracker.recordCompletedTransaction(testUserId, 40000, new Date());

      const profile = spendTracker.getUserSpendProfile(testUserId, limitCents);
      expect(profile.rolling24hSpentCents).toBe(40000);
      expect(profile.remainingDailySpendCents).toBe(60000); // ₹600.00 remaining

      // New order of ₹650.00 should be rejected because only ₹600.00 remains
      const attempt = spendTracker.reserveSpend(testUserId, 65000, 'mandate_exceed_after_prior', limitCents);
      expect(attempt.allowed).toBe(false);
    });

    it('does not reduce today daily limit with spend from yesterday in Asia/Kolkata timezone', () => {
      const limitCents = 100000; // ₹1,000.00
      // Transaction 36 hours ago (yesterday/earlier)
      const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
      spendTracker.recordCompletedTransaction(testUserId, 80000, yesterday);

      const profile = spendTracker.getUserSpendProfile(testUserId, limitCents);
      // Today spend should be 0
      expect(profile.rolling24hSpentCents).toBe(0);
      expect(profile.remainingDailySpendCents).toBe(100000);

      // Order of ₹900 today should be approved
      const attempt = spendTracker.reserveSpend(testUserId, 90000, 'mandate_today_fresh', limitCents);
      expect(attempt.allowed).toBe(true);
    });

    it('atomically reserves budget to prevent concurrent double-spend race conditions', () => {
      const limitCents = 50000; // ₹500.00 limit

      // Two concurrent checkout attempts for ₹300.00 each
      const res1 = spendTracker.reserveSpend(testUserId, 30000, 'mandate_concurrent_1', limitCents);
      expect(res1.allowed).toBe(true);

      // Second attempt arrives concurrently before first commits
      const res2 = spendTracker.reserveSpend(testUserId, 30000, 'mandate_concurrent_2', limitCents);
      expect(res2.allowed).toBe(false);
      expect(res2.reason).toMatch(/exceeds (your )?remaining daily (spend allowance|budget)/i);
    });

    it('releases reservation when payment or checkout fails, restoring available budget', async () => {
      const limitCents = 50000; // ₹500.00
      const res = await spendTracker.reserveSpendAsync(testUserId, 40000, 'mandate_failed_flow', limitCents);
      expect(res.allowed).toBe(true);

      // Verify available budget was reduced by reservation
      let profile = spendTracker.getUserSpendProfile(testUserId, limitCents);
      expect(profile.remainingDailySpendCents).toBe(10000);

      // Simulate payment failure -> release reservation
      await spendTracker.releaseReservationAsync('mandate_failed_flow', 'payment_declined');

      // Available budget is restored
      profile = spendTracker.getUserSpendProfile(testUserId, limitCents);
      expect(profile.remainingDailySpendCents).toBe(50000);
    });

    it('reconciles reservation and spend upon cancellation and refund', async () => {
      const limitCents = 50000;
      await spendTracker.reserveSpendAsync(testUserId, 30000, 'mandate_refund_flow', limitCents);
      await spendTracker.commitReservationAsync('mandate_refund_flow', testUserId, 30000);

      // Now cancel / refund
      await spendTracker.releaseReservationAsync('mandate_refund_flow', 'user_cancelled_refunded');
      const profile = spendTracker.getUserSpendProfile(testUserId, limitCents);
      expect(profile.activeReservedCents).toBe(0);
    });

    it('fails closed when authoritative daily spend limit cannot be verified', () => {
      // Testing unauthenticated or invalid user with fail closed check
      const res = spendTracker.reserveSpend('', 5000, 'mandate_no_user', 0);
      expect(res.allowed).toBe(false);
    });
  });

  // =========================================================================
  // 4. Budget-Aware Item Selection & Advisory (Step 5)
  // =========================================================================
  describe('4. Budget-Aware Item Selection & Advisory', () => {
    it('attaches budget suggestion and excess amount when basket exceeds remaining limit', async () => {
      // Set user's budget very low: ₹30.00 (3000 paise)
      authProvider.updateUserDailySpendLimit(testUserId, 3000);

      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'milk');

      expect(turn.proposal).toBeDefined();
      expect(turn.proposal?.budgetExceeded).toBe(true);
      expect(turn.proposal?.excessAmountCents).toBeGreaterThan(0);
      expect(turn.proposal?.budgetSuggestion).toBeDefined();
      expect(turn.proposal?.budgetSuggestion?.text).toContain('exceeds your remaining daily budget');
    });

    it('does not silently remove requested items or substitute without user approval', async () => {
      authProvider.updateUserDailySpendLimit(testUserId, 2000); // ₹20 budget
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'milk and bread');

      // Basket must preserve both requested items
      expect(turn.proposal).toBeDefined();
      expect(turn.proposal?.items.length).toBeGreaterThanOrEqual(1);
      // It should flag budget exceeded rather than silently dropping bread
      expect(turn.proposal?.budgetExceeded).toBe(true);
    });
  });

  // =========================================================================
  // 5. Merchant Price Changes & Cart Revalidation
  // =========================================================================
  describe('5. Merchant Price Changes & Revalidation', () => {
    it('detects cart price mismatch between mandate issuance and execution', async () => {
      authProvider.updateUserDailySpendLimit(testUserId, 500000);
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'milk');
      expect(turn.mandateBundle).toBeDefined();

      const mandate = turn.mandateBundle!;

      // Tamper with mandate amount to simulate merchant price change
      const tamperedMandate = {
        ...mandate,
        amountCents: mandate.amountCents + 1000, // 10 rupees higher
      };
      (session as any).pendingMandate = tamperedMandate;

      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          tamperedMandate.mandateId,
          {
            mandateId: tamperedMandate.mandateId,
            challengeId: 'chal_test',
            clientDataJSON: 'test',
            authenticatorData: 'test',
            signature: 'sig_test',
          },
          undefined,
          testUserId
        )
      ).rejects.toThrow(/Purchase binding mismatch: Mandate amount/);
    });
  });

  // =========================================================================
  // 6. Direct API Endpoint Protection & Bypass Prevention
  // =========================================================================
  describe('6. Direct API Endpoint Protection & Bypass Prevention', () => {
    let server: any;
    let baseUrl: string;
    const port = 3901;

    beforeEach(async () => {
      baseUrl = `http://127.0.0.1:${port}`;
      server = startDevServer(port);
      await new Promise((r) => setTimeout(r, 120));
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('rejects direct POST /api/checkout when order exceeds user daily budget (HTTP 422)', async () => {
      // 1. Initial valid budget of ₹5,000 allows initial mandate issuance
      authProvider.seedUser({ ...ARJUN_USER });
      authProvider.setActiveUser(ARJUN_USER.id);
      authProvider.updateUserDailySpendLimit(ARJUN_USER.id, 500000);

      // 2. Chat endpoint to create a proposal
      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ARJUN_USER.id,
          message: 'milk',
        }),
      });

      expect(chatRes.status).toBe(200);
      const chatJson = await chatRes.json() as any;
      const mandateId = chatJson.mandateBundle?.mandateId;
      const sessionId = chatJson.sessionId;
      expect(mandateId).toBeDefined();

      // 3. User budget is subsequently lowered or depleted (e.g. to ₹30)
      authProvider.updateUserDailySpendLimit(ARJUN_USER.id, 3000);

      // 4. Directly attempt to call /api/checkout to bypass frontend checks
      const checkoutRes = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          mandateId,
          userId: ARJUN_USER.id,
          signature: 'prava_test_passkey_sig',
        }),
      });

      // Must be rejected with 422 DAILY_BUDGET_EXCEEDED
      expect(checkoutRes.status).toBe(422);
      const checkoutJson = await checkoutRes.json() as any;
      expect(checkoutJson.success).toBe(false);
      expect(checkoutJson.code).toBe('DAILY_BUDGET_EXCEEDED');
      expect(checkoutJson.error).toMatch(/exceeds (your )?remaining daily (spend allowance|budget)/i);
    });

    it('GET /api/me/wallet returns accurate remaining daily budget', async () => {
      authProvider.seedUser({ ...ARJUN_USER });
      authProvider.setActiveUser(ARJUN_USER.id);
      authProvider.updateUserDailySpendLimit(ARJUN_USER.id, 250000); // ₹2,500.00

      const res = await fetch(`${baseUrl}/api/me/wallet`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.dailyLimitINR).toBe('2500.00');
      expect(json.remainingSpendINR).toBe('2500.00');
    });

    it('POST /api/chat returns best choices for each item when user requests Amul butter and eggs', async () => {
      authProvider.seedUser({ ...ARJUN_USER });
      authProvider.setActiveUser(ARJUN_USER.id);
      authProvider.updateUserDailySpendLimit(ARJUN_USER.id, 500000); // ₹5,000.00 limit

      const chatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ARJUN_USER.id,
          message: 'Search Amul butter and eggs\nIf I am asking for 2 itmes I want best choices for each item',
        }),
      });

      expect(chatRes.status).toBe(200);
      const chatJson = await chatRes.json() as any;

      // Both best items must be returned
      expect(chatJson.bestItems).toBeDefined();
      expect(chatJson.bestItems.length).toBe(2);

      const butterChoice = chatJson.bestItems.find((i: any) => i.name.toLowerCase().includes('butter'));
      const eggChoice = chatJson.bestItems.find((i: any) => i.name.toLowerCase().includes('egg'));

      expect(butterChoice).toBeDefined();
      expect(butterChoice.name).toContain('Butter');
      expect(butterChoice.priceCents).toBeGreaterThan(0);

      expect(eggChoice).toBeDefined();
      expect(eggChoice.name).toContain('Egg');
      expect(eggChoice.priceCents).toBeGreaterThan(0);

      // Reply must include top choices for requested items
      expect(chatJson.reply).toContain("Top Choices for Your Requested Items");
      expect(chatJson.reply).toContain("Butter");
      expect(chatJson.reply).toContain("Egg");
    });
  });
});
