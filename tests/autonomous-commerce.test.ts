import { describe, it, expect, beforeEach } from 'vitest';
import {
  autonomousCommerceRunner,
  orderValidator,
  spendTracker,
  authProvider,
  quickCommerceMcpManager,
  ap2PravaBridge,
  SwiggyMcpClient,
  ZeptoMcpClient,
} from '../src/index.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';

describe('Autonomous Commerce Agent with Swiggy & Zepto MCP', () => {
  const mockUserId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    spendTracker.clear();
    quickCommerceMcpManager.setClients(
      new SwiggyMcpClient(createTestSwiggyTransport()),
      new ZeptoMcpClient(createTestZeptoTransport())
    );
  });

  describe('1. Delivery Location & Geofencing Context', () => {
    it('initializes session with default delivery address and 6-digit pincode', async () => {
      const session = await autonomousCommerceRunner.initializeSession(mockUserId);
      expect(session.activeDeliveryLocation.address).toContain('Bellandur, Bengaluru');
      expect(session.activeDeliveryLocation.pincode).toBe('560103');
      expect(session.isLocationConfirmed).toBe(true);
    });

    it('validates 6-digit Indian postal pincode correctly', () => {
      const valid = orderValidator.validateLocation({
        address: '100 Feet Rd, Indiranagar, Bengaluru',
        pincode: '560038',
      });
      expect(valid.valid).toBe(true);
      expect(valid.confirmed).toBe(true);

      const invalidPincode = orderValidator.validateLocation({
        address: '100 Feet Rd, Indiranagar, Bengaluru',
        pincode: '5600', // Invalid short pincode
      });
      expect(invalidPincode.valid).toBe(false);
      expect(invalidPincode.message).toContain('6-digit');
    });

    it('allows updating delivery location during shopping turn', async () => {
      const session = await autonomousCommerceRunner.initializeSession(mockUserId);
      const turn = await autonomousCommerceRunner.processShoppingTurn(
        session.sessionId,
        'Order 1L milk and brown bread',
        {
          confirmed: true,
          override: {
            address: '12th Main Road, HAL 2nd Stage, Indiranagar',
            pincode: '560038',
          },
        }
      );
      expect(turn.deliveryLocation.address).toBe('12th Main Road, HAL 2nd Stage, Indiranagar');
      expect(turn.deliveryLocation.pincode).toBe('560038');
    });
  });

  describe('2. Quick-Commerce MCP Discovery & Multi-Store Comparison', () => {
    it('searches Swiggy and Zepto MCP catalogs in parallel', async () => {
      const { swiggyItems, zeptoItems } = await quickCommerceMcpManager.searchAllMerchants('milk');
      expect(swiggyItems.length).toBeGreaterThan(0);
      expect(zeptoItems.length).toBeGreaterThan(0);
      expect(swiggyItems[0].platform).toBe('swiggy_instamart');
      expect(zeptoItems[0].platform).toBe('zepto');
      expect(swiggyItems[0].currency).toBe('INR');
      expect(zeptoItems[0].priceCents).toBeGreaterThan(0);
    });

    it('compares baskets across Swiggy and Zepto to recommend the optimal basket', async () => {
      const location = { address: 'Indiranagar, Bengaluru', pincode: '560038' };
      const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
        [
          { name: 'milk', quantity: 1 },
          { name: 'bread', quantity: 1 },
        ],
        location
      );

      expect(comparison.swiggyProposal).toBeDefined();
      expect(comparison.zeptoProposal).toBeDefined();
      expect(comparison.recommendedProposal).toBeDefined();
      expect(['swiggy_instamart', 'zepto']).toContain(comparison.recommendedProposal.platform);
      expect(comparison.recommendationReason).toBeTruthy();
    });
  });

  describe('3. Spending Limits & Pre-Purchase Validation', () => {
    it('approves orders within the daily spend limit (₹5,000 cap)', () => {
      const proposal = {
        platform: 'zepto' as const,
        merchantName: 'Zepto',
        items: [{ itemId: 'item_1', name: 'Milk', quantity: 1, unitPriceCents: 4200 }],
        subtotalCents: 4200,
        deliveryFeeCents: 2000,
        taxCents: 210,
        totalAmountCents: 6410, // ₹64.10
        currency: 'INR' as const,
        etaMinutes: 10,
        deliveryAddress: { address: 'Indiranagar', pincode: '560038' },
        isAvailable: true,
        cartId: 'cart_1',
      };

      const result = orderValidator.validatePrePurchase(mockUserId, proposal, 500000);
      expect(result.valid).toBe(true);
      expect(result.budgetAllowed).toBe(true);
      expect(result.stockAvailable).toBe(true);
    });

    it('rejects an order if it exceeds remaining rolling 24-hour spend allowance', () => {
      // Simulate user already spent ₹4,800.00 today (480,000 paise out of 500,000 paise limit)
      spendTracker.recordCompletedTransaction(mockUserId, 480000);

      const expensiveProposal = {
        platform: 'swiggy_instamart' as const,
        merchantName: 'Swiggy Instamart',
        items: [{ itemId: 'item_1', name: 'Premium Groceries', quantity: 1, unitPriceCents: 25000 }],
        subtotalCents: 25000,
        deliveryFeeCents: 0,
        taxCents: 1250,
        totalAmountCents: 26250, // ₹262.50 (Remaining allowance is only ₹200.00)
        currency: 'INR' as const,
        etaMinutes: 14,
        deliveryAddress: { address: 'Indiranagar', pincode: '560038' },
        isAvailable: true,
        cartId: 'cart_2',
      };

      const result = orderValidator.validatePrePurchase(mockUserId, expensiveProposal, 500000);
      expect(result.valid).toBe(false);
      expect(result.budgetAllowed).toBe(false);
      expect(result.errorMessage).toContain('exceeds your remaining daily spend allowance');
    });
  });

  describe('4. AP2 Mandate & Prava Biometric Passkey Gate', () => {
    it('creates a scoped AP2 CartMandate with 10-minute expiry and Prava challenge', async () => {
      const proposal = {
        platform: 'swiggy_instamart' as const,
        merchantName: 'Swiggy Instamart',
        items: [{ itemId: 'item_1', name: 'Nandini Milk', quantity: 1, unitPriceCents: 4200 }],
        subtotalCents: 4200,
        deliveryFeeCents: 2500,
        taxCents: 210,
        totalAmountCents: 6910,
        currency: 'INR' as const,
        etaMinutes: 14,
        deliveryAddress: { address: 'Bellandur', pincode: '560103' },
        isAvailable: true,
        cartId: 'cart_ap2_1',
      };

      const bundle = await ap2PravaBridge.createBasketMandate(proposal, mockUserId);
      expect(bundle.mandateId).toBeTruthy();
      expect(bundle.merchantId).toBe('swiggy');
      expect(bundle.amountCents).toBe(6910);
      expect(bundle.currency).toBe('INR');
      expect(bundle.challenge).toBeDefined();
      expect(bundle.challenge.challenge).toBeTruthy();
      // Expiration must be approximately 10 minutes in the future
      const now = Date.now();
      expect(bundle.expiresAt.getTime()).toBeGreaterThan(now + 9 * 60 * 1000);
      expect(bundle.expiresAt.getTime()).toBeLessThanOrEqual(now + 10 * 60 * 1000 + 1000);
    });
  });

  describe('5. End-to-End Autonomous Purchasing & Double-Spend Invariance', () => {
    it('completes the full flow: Natural Language Turn -> Proposal -> Passkey -> Checkout -> Receipt', async () => {
      const session = await autonomousCommerceRunner.initializeSession(mockUserId);

      // Step 1: User gives natural language shopping intent
      const turnResult = await autonomousCommerceRunner.processShoppingTurn(
        session.sessionId,
        'Find me 1L milk, bread, and eggs in under 15 mins'
      );

      expect(turnResult.passkeyRequired).toBe(true);
      expect(turnResult.mandateBundle).toBeDefined();
      expect(turnResult.proposal.items.length).toBeGreaterThanOrEqual(2);

      const mandateId = turnResult.mandateBundle!.mandateId;

      // Step 2: User biometrically authorizes with passkey (Touch ID / Face ID)
      const checkoutResult = await autonomousCommerceRunner.authorizeAndExecuteCheckout(
        session.sessionId,
        mandateId,
        {
          mandateId,
          challengeId: turnResult.mandateBundle!.challenge.challengeId,
          clientDataJSON: Buffer.from('mock_client_data').toString('base64url'),
          authenticatorData: Buffer.from('mock_auth_data').toString('base64url'),
          signature: 'mock_passkey_signature_fido2',
        }
      );

      expect(checkoutResult.success).toBe(true);
      expect(checkoutResult.order.orderId).toBeTruthy();
      expect(checkoutResult.pravaTokenRef).toContain('prv_tok_');
      expect(checkoutResult.transactionId).toContain('tx_');

      // Step 3: Verify Double-Spend Invariance
      // Attempting to reuse the exact same mandateId MUST fail
      await expect(
        autonomousCommerceRunner.authorizeAndExecuteCheckout(
          session.sessionId,
          mandateId,
          {
            mandateId,
            challengeId: 'attempt_replay',
            clientDataJSON: '',
            authenticatorData: '',
            signature: '',
          }
        )
      ).rejects.toThrow(/already been consumed and cannot be reused/);
    });
  });
});
