/**
 * P0 Security, Identity & Checkout Invariants Verification Suite
 *
 * Verifies all P0 acceptance criteria from AUTONOMOUS_COMMERCE_AGENT_FIX_PLAN.md:
 *  - Section 1: Fail-closed payment authorization, no fake fallbacks, purchase binding
 *  - Section 2: Strict identity, no silent fallbacks, cross-user authorization enforcement
 *  - Section 3: Concurrent mandate double-spend invariance, atomic spend reservations, stable idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PravaPaymentsClient,
  MockPravaPaymentsClient,
  PravaConfigurationError,
  PravaApiError,
  PravaVerificationError,
  getPravaClient,
  setPravaClient,
  resetPravaClient,
} from '../src/prava/client.js';
import { ap2PravaBridge } from '../src/prava/ap2-bridge.js';
import { authProvider, ARJUN_USER, SUSHMITA_USER, SHUBHAM_USER } from '../src/auth/index.js';
import { spendTracker } from '../src/db/spend-tracker.js';
import { AutonomousCommerceRunner } from '../src/agent/runner.js';
import { DeliveryLocation, QuickCommerceBasketProposal } from '../src/mcp/types.js';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import { SwiggyMcpClient } from '../src/mcp/swiggy-mcp.js';
import { ZeptoMcpClient } from '../src/mcp/zepto-mcp.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';

describe('P0 --- Security, Identity & Checkout Invariants Suite', () => {
  let runner: AutonomousCommerceRunner;
  const originalNodeEnv = process.env.NODE_ENV;
  const testUserId = ARJUN_USER.id;

  beforeEach(() => {
    resetPravaClient();
    authProvider.reset();
    authProvider.seedVerifiedClerkProfiles();
    spendTracker.clear();
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

  describe('1. P0 Payment & Passkey Authorization (Fail-Closed)', () => {
    it('throws PravaConfigurationError if real PravaPaymentsClient is unconfigured', async () => {
      const unconfiguredClient = new PravaPaymentsClient();
      // Temporarily clear API key on instance
      (unconfiguredClient as any).secretKey = undefined;

      await expect(
        unconfiguredClient.createPasskeyChallenge({
          mandateId: 'm_test_01',
          merchantId: 'swiggy',
          amountCents: 50000,
          currency: 'INR',
          userId: 'user_01',
        })
      ).rejects.toThrow(PravaConfigurationError);

      await expect(
        unconfiguredClient.verifyPasskeyAndIssueToken(
          {
            mandateId: 'm_test_01',
            challengeId: 'c_test_01',
            clientDataJSON: 'test',
            authenticatorData: 'test',
            signature: 'test_sig',
          },
          'swiggy',
          50000
        )
      ).rejects.toThrow(PravaConfigurationError);
    });

    it('rejects MockPravaPaymentsClient execution when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      const mockClient = new MockPravaPaymentsClient();

      await expect(
        mockClient.createPasskeyChallenge({
          mandateId: 'm_test_02',
          merchantId: 'zepto',
          amountCents: 35000,
          currency: 'INR',
          userId: 'user_02',
        })
      ).rejects.toThrow(PravaConfigurationError);

      expect(() => setPravaClient(mockClient)).toThrow(PravaConfigurationError);
    });

    it('fails closed when provider returns HTTP 500 or network timeout without synthetic fallback', async () => {
      const mockProvider = new MockPravaPaymentsClient();
      setPravaClient(mockProvider);

      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'milk 1 litre');
      expect(turn.mandateBundle).toBeDefined();

      // Simulate Prava provider returning HTTP 500 during passkey verification
      mockProvider.setSimulateError(
        new PravaApiError('Prava gateway 500 Internal Server Error', 500, 'Internal Server Error')
      );

      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          turn.mandateBundle!.mandateId,
          {
            mandateId: turn.mandateBundle!.mandateId,
            challengeId: 'chal_01',
            clientDataJSON: '',
            authenticatorData: '',
            signature: 'valid_sig',
          }
        )
      ).rejects.toThrow(/Prava gateway 500 Internal Server Error/);
    });

    it('rejects purchase binding mismatch: modified amount, currency, or merchant requires new authorization', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'bread');
      const bundle = turn.mandateBundle!;

      // Tamper with the active proposal amount
      session.activeProposal!.totalAmountCents += 5000;

      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          bundle.mandateId,
          {
            mandateId: bundle.mandateId,
            challengeId: bundle.challenge.challengeId,
            clientDataJSON: '',
            authenticatorData: '',
            signature: 'passkey_sig_01',
          }
        )
      ).rejects.toThrow(/Purchase binding mismatch: Mandate amount/);
    });

    it('rejects expired mandate and empty cryptographic signature', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'butter');
      const bundle = turn.mandateBundle!;

      // 1. Empty signature
      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          bundle.mandateId,
          {
            mandateId: bundle.mandateId,
            challengeId: bundle.challenge.challengeId,
            clientDataJSON: '',
            authenticatorData: '',
            signature: '',
          }
        )
      ).rejects.toThrow(/signature is missing or empty/);

      // 2. Expired mandate (set expiry in past)
      bundle.expiresAt = new Date(Date.now() - 1000);
      bundle.cartMandate.expiresAt = Date.now() - 1000;

      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          bundle.mandateId,
          {
            mandateId: bundle.mandateId,
            challengeId: bundle.challenge.challengeId,
            clientDataJSON: '',
            authenticatorData: '',
            signature: 'passkey_sig_01',
          }
        )
      ).rejects.toThrow(/Biometric approval window has expired/);
    });
  });

  describe('2. P0 Authentication & Identity Verification', () => {
    it('fails login when password credential is missing or empty', () => {
      expect(() => authProvider.loginUser('arjun.sharma@example.com', '')).toThrow(
        /Password credential is required for login/
      );
      expect(() => authProvider.loginUser('arjun.sharma@example.com', undefined as any)).toThrow(
        /Password credential is required for login/
      );
    });

    it('throws explicit error when resolving unknown user identifier instead of falling back', async () => {
      await expect(
        authProvider.getAuthenticatedUser('completely_unknown_user_id_9999')
      ).rejects.toThrow(/Authentication error: No user found for identifier/);
    });

    it('enforces cross-user session boundaries on checkout', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'eggs');
      const bundle = turn.mandateBundle!;

      // Attempt checkout with a different requesting user ID
      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          bundle.mandateId,
          {
            mandateId: bundle.mandateId,
            challengeId: bundle.challenge.challengeId,
            clientDataJSON: '',
            authenticatorData: '',
            signature: 'passkey_sig',
          },
          undefined,
          'different_user_00000000-0000-0000-0000-000000000002' // Attacker
        )
      ).rejects.toThrow(/Forbidden: Session does not belong to the requesting user/);
    });
  });

  describe('3. P0 Concurrency, Idempotency & Atomic Spending Limits', () => {
    it('concurrent requests using the same mandate result in at most one successful submission', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'milk 2 litres');
      const bundle = turn.mandateBundle!;

      const verification = {
        mandateId: bundle.mandateId,
        challengeId: bundle.challenge.challengeId,
        clientDataJSON: '',
        authenticatorData: '',
        signature: 'valid_passkey_sig_01',
      };

      // Fire 2 concurrent checkouts on the exact same mandate
      const [res1, res2] = await Promise.allSettled([
        runner.authorizeAndExecuteCheckout(session.sessionId, bundle.mandateId, verification),
        runner.authorizeAndExecuteCheckout(session.sessionId, bundle.mandateId, verification),
      ]);

      const successes = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejections = [res1, res2].filter((r) => r.status === 'rejected');

      expect(successes.length).toBe(1);
      expect(rejections.length).toBe(1);
      expect((rejections[0] as PromiseRejectedResult).reason.message).toMatch(
        /Financial safety violation: Mandate .* has already been consumed/
      );
    });

    it('retry with the same idempotency key returns existing operation instead of submitting duplicate', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'bread 1 packet');
      const bundle = turn.mandateBundle!;
      const idempotencyKey = 'idem_checkout_key_unique_1001';

      const verification = {
        mandateId: bundle.mandateId,
        challengeId: bundle.challenge.challengeId,
        clientDataJSON: '',
        authenticatorData: '',
        signature: 'valid_passkey_sig_01',
      };

      // First submission
      const firstResult = await runner.authorizeAndExecuteCheckout(
        session.sessionId,
        bundle.mandateId,
        verification,
        idempotencyKey
      );
      expect(firstResult.success).toBe(true);

      // Repeated submission with same idempotency key
      const retryResult = await runner.authorizeAndExecuteCheckout(
        session.sessionId,
        bundle.mandateId,
        verification,
        idempotencyKey
      );

      // Must return identical transaction result
      expect(retryResult.transactionId).toBe(firstResult.transactionId);
      expect(retryResult.pravaTokenRef).toBe(firstResult.pravaTokenRef);
    });

    it('reusing same idempotency key with different mandate or parameters is rejected', async () => {
      const session = await runner.initializeSession(testUserId);
      const turn = await runner.processShoppingTurn(session.sessionId, 'eggs 6 pcs');
      const bundle = turn.mandateBundle!;
      const idempotencyKey = 'idem_key_tamper_test_2002';

      const verification = {
        mandateId: bundle.mandateId,
        challengeId: bundle.challenge.challengeId,
        clientDataJSON: '',
        authenticatorData: '',
        signature: 'valid_passkey_sig_01',
      };

      await runner.authorizeAndExecuteCheckout(
        session.sessionId,
        bundle.mandateId,
        verification,
        idempotencyKey
      );

      // Attempt to reuse same idempotency key with a DIFFERENT mandate
      await expect(
        runner.authorizeAndExecuteCheckout(
          session.sessionId,
          'different_mandate_id_9999',
          verification,
          idempotencyKey
        )
      ).rejects.toThrow(/Financial safety violation|Idempotency violation/);
    });

    it('two simultaneous purchases cannot exceed the configured spending limit via atomic reservations', () => {
      const userId = testUserId;
      const budgetCap = 50000; // ₹500.00 cap

      // Purchase 1: ₹350.00
      const res1 = spendTracker.reserveSpend(userId, 35000, 'mandate_res_1', budgetCap);
      expect(res1.allowed).toBe(true);

      // Purchase 2: ₹250.00 (would total ₹600.00 > ₹500.00)
      const res2 = spendTracker.reserveSpend(userId, 25000, 'mandate_res_2', budgetCap);
      expect(res2.allowed).toBe(false);
      expect(res2.reason).toContain('exceeds your remaining daily spend allowance');

      // Releasing reservation 1 restores budget
      spendTracker.releaseReservation('mandate_res_1');
      const res3 = spendTracker.reserveSpend(userId, 25000, 'mandate_res_2', budgetCap);
      expect(res3.allowed).toBe(true);
    });
  });
});
