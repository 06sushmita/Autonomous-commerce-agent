/**
 * Autonomous Commerce Agent Session Runner
 *
 * Integrates:
 *  - @agorio/sdk ShoppingAgent
 *  - @agorio/plugin-spending-controls
 *  - @agorio/plugin-approval-workflow
 *  - @agorio/plugin-audit-trail
 *  - QuickCommerceMcpManager (Swiggy MCP & Zepto MCP)
 *  - Ap2PravaBridge (AP2 + FIDO WebAuthn passkey)
 *  - OrderValidator (spend limits, dark-store stock & location confirmation)
 */

import {
  ShoppingAgent,
  GeminiAdapter,
} from '@agorio/sdk';
import { createSpendingControlsPlugin } from '@agorio/plugin-spending-controls';
import { createApprovalWorkflowPlugin } from '@agorio/plugin-approval-workflow';
import { createAuditTrailPlugin, AuditEntry } from '@agorio/plugin-audit-trail';

import { DeliveryLocation, QuickCommerceBasketProposal, OrderCheckoutResult } from '../mcp/types.js';
import { quickCommerceMcpManager } from '../mcp/mcp-manager.js';
import { ap2PravaBridge, PendingMandateBundle } from '../prava/ap2-bridge.js';
import { pravaClient, PasskeyVerificationRequest } from '../prava/client.js';
import { orderValidator } from './order-validator.js';
import { authProvider, AuthUser } from '../auth/index.js';
import { spendTracker } from '../db/spend-tracker.js';

export interface AgentSessionState {
  sessionId: string;
  user: AuthUser;
  activeDeliveryLocation: DeliveryLocation;
  isLocationConfirmed: boolean;
  activeProposal?: QuickCommerceBasketProposal;
  pendingMandate?: PendingMandateBundle;
  consumedMandateId?: string;
  auditTrail: AuditEntry[];
}

export interface TurnProposalResult {
  sessionId: string;
  proposal: QuickCommerceBasketProposal;
  recommendationReason: string;
  locationConfirmed: boolean;
  deliveryLocation: DeliveryLocation;
  passkeyRequired: boolean;
  mandateBundle?: PendingMandateBundle;
  error?: string;
}

export interface CheckoutExecutionResult {
  success: boolean;
  order: OrderCheckoutResult;
  mandateId: string;
  transactionId: string;
  pravaTokenRef: string;
}

export class AutonomousCommerceRunner {
  private sessions: Map<string, AgentSessionState> = new Map();
  private auditLogRecords: AuditEntry[] = [];
  // Store consumed mandate IDs in memory to enforce single-use guarantee
  private consumedMandates: Set<string> = new Set();
  // Store recorded transactions to enforce unique mandate_id constraint
  private transactionLedger: Map<string, { transactionId: string; mandateId: string; order: OrderCheckoutResult }> = new Map();

  /**
   * Initialize a new conversational shopping session
   */
  public async initializeSession(
    userId?: string,
    locationOverride?: Partial<DeliveryLocation>
  ): Promise<AgentSessionState> {
    const user = await authProvider.getAuthenticatedUser(userId);
    const sessionId = `sess_${crypto.randomUUID()}`;

    const defaultLocation: DeliveryLocation = {
      address: user.defaultAddress,
      pincode: user.defaultPincode,
      latitude: user.defaultLatitude,
      longitude: user.defaultLongitude,
    };

    const locationCheck = orderValidator.validateLocation(defaultLocation, locationOverride);

    const session: AgentSessionState = {
      sessionId,
      user,
      activeDeliveryLocation: locationCheck.location,
      isLocationConfirmed: locationCheck.confirmed,
      auditTrail: [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Create an instantiated agorio ShoppingAgent configured with enterprise governance plugins
   */
  public createAgentForSession(session: AgentSessionState): ShoppingAgent {
    const remainingSpendCents = spendTracker.getUserSpendProfile(
      session.user.id,
      session.user.dailySpendLimitCents
    ).remainingDailySpendCents;

    return new ShoppingAgent({
      llm: new GeminiAdapter({
        apiKey: process.env.GEMINI_API_KEY || 'mock_gemini_api_key',
      }),
      plugins: [
        ...quickCommerceMcpManager.getShoppingAgentPlugins(),
        createSpendingControlsPlugin({
          perTransactionLimit: session.user.dailySpendLimitCents / 100,
          dailyLimit: remainingSpendCents / 100,
          currency: 'INR',
        }),
        createApprovalWorkflowPlugin({
          requireApprovalAbove: 0, // Biometric passkey gate required for all financial commitments
          currency: 'INR',
        }),
        createAuditTrailPlugin({
          output: 'callback',
          callback: (entry: AuditEntry) => {
            session.auditTrail.push(entry);
            this.auditLogRecords.push(entry);
          },
        }),
      ],
    });
  }

  /**
   * Process a natural language shopping turn
   */
  public async processShoppingTurn(
    sessionId: string,
    userQuery: string,
    locationConfirmation?: { confirmed: boolean; override?: Partial<DeliveryLocation> },
    merchantPreference?: 'swiggy' | 'zepto'
  ): Promise<TurnProposalResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 1. Handle location confirmation or update
    if (locationConfirmation) {
      const locCheck = orderValidator.validateLocation(
        session.activeDeliveryLocation,
        locationConfirmation.override
      );
      session.activeDeliveryLocation = locCheck.location;
      session.isLocationConfirmed = locationConfirmation.confirmed;
    }

    // 2. Parse natural language shopping query into grocery items
    const parsedItems = this.parseQueryToGroceryItems(userQuery);

    // Detect explicit merchant choice (e.g. "order from zepto", or explicit merchant parameter)
    const lowerQuery = userQuery.toLowerCase();
    const explicitMerchant =
      merchantPreference ||
      (lowerQuery.includes('zepto')
        ? 'zepto'
        : lowerQuery.includes('swiggy')
        ? 'swiggy'
        : undefined);

    // 3. Query Quick-Commerce MCP servers (Swiggy MCP & Zepto MCP)
    await quickCommerceMcpManager.initialize();
    const comparison = await quickCommerceMcpManager.compareAndAssembleBasket(
      parsedItems,
      session.activeDeliveryLocation,
      explicitMerchant
    );

    const bestProposal = comparison.recommendedProposal;
    session.activeProposal = bestProposal;

    // 4. Validate order stock, location, and spending limits
    const validation = orderValidator.validatePrePurchase(
      session.user.id,
      bestProposal,
      session.user.dailySpendLimitCents,
      session.isLocationConfirmed
    );

    if (!validation.valid) {
      return {
        sessionId,
        proposal: bestProposal,
        recommendationReason: comparison.recommendationReason,
        locationConfirmed: session.isLocationConfirmed,
        deliveryLocation: session.activeDeliveryLocation,
        passkeyRequired: false,
        error: validation.errorMessage,
      };
    }

    // 5. Generate AP2 CartMandate and request Prava Passkey challenge
    const mandateBundle = await ap2PravaBridge.createBasketMandate(
      bestProposal,
      session.user.id
    );
    session.pendingMandate = mandateBundle;

    return {
      sessionId,
      proposal: bestProposal,
      recommendationReason: comparison.recommendationReason,
      locationConfirmed: session.isLocationConfirmed,
      deliveryLocation: session.activeDeliveryLocation,
      passkeyRequired: true,
      mandateBundle,
    };
  }

  /**
   * Authorize mandate via biometric passkey signature and execute autonomous checkout
   */
  public async authorizeAndExecuteCheckout(
    sessionId: string,
    mandateId: string,
    verification: PasskeyVerificationRequest
  ): Promise<CheckoutExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 1. Double-spend prevention check (enforces single-use mandate guarantee)
    if (this.consumedMandates.has(mandateId) || this.transactionLedger.has(mandateId)) {
      throw new Error(`Financial safety violation: Mandate ${mandateId} has already been consumed and cannot be reused.`);
    }

    const bundle = session.pendingMandate;
    if (!bundle || bundle.mandateId !== mandateId) {
      throw new Error(`Invalid or missing mandate: ${mandateId}`);
    }

    // 2. Expiration check (10-minute window)
    if (new Date() > bundle.expiresAt) {
      throw new Error('Biometric approval window has expired (10-minute limit). Please request a fresh proposal.');
    }

    // 3. Cryptographically shape-check the signed mandate
    ap2PravaBridge.buildAndVerifySignedMandate(bundle.cartMandate, verification.signature);

    // 4. Verify passkey signature via Prava and retrieve single-use payment token reference
    const tokenResponse = await pravaClient.verifyPasskeyAndIssueToken(
      verification,
      bundle.merchantId,
      bundle.amountCents,
      bundle.currency
    );

    if (!tokenResponse.success || !tokenResponse.pravaTokenRef) {
      throw new Error('Biometric passkey signature verification failed with Prava payments.');
    }

    // 4. Autonomous checkout via Quick-Commerce MCP
    const platform = bundle.merchantId === 'swiggy' ? 'swiggy_instamart' : 'zepto';
    const checkoutResult = await quickCommerceMcpManager.executePlatformCheckout(
      platform,
      session.activeProposal!.cartId,
      tokenResponse.pravaTokenRef
    );

    if (!checkoutResult.success) {
      throw new Error(`Checkout failed at merchant ${platform}`);
    }

    // 5. Atomic transaction settlement
    const transactionId = `tx_${crypto.randomUUID()}`;
    this.consumedMandates.add(mandateId);
    this.transactionLedger.set(mandateId, {
      transactionId,
      mandateId,
      order: checkoutResult,
    });

    // Record completed transaction for rolling 24h spend calculation
    spendTracker.recordCompletedTransaction(session.user.id, bundle.amountCents);

    session.consumedMandateId = mandateId;
    session.pendingMandate = undefined;

    return {
      success: true,
      order: checkoutResult,
      mandateId,
      transactionId,
      pravaTokenRef: tokenResponse.pravaTokenRef,
    };
  }

  /**
   * Helper to parse natural language shopping prompt into grocery items
   */
  private parseQueryToGroceryItems(query: string): Array<{ name: string; quantity: number }> {
    const items: Array<{ name: string; quantity: number }> = [];
    const lower = query.toLowerCase();

    if (lower.includes('milk')) {
      const match = lower.match(/(\d+)\s*(l|litre|packet|can)?\s*milk/);
      items.push({ name: 'milk', quantity: match ? parseInt(match[1], 10) : 1 });
    }
    if (lower.includes('bread')) {
      items.push({ name: 'bread', quantity: 1 });
    }
    if (lower.includes('egg') || lower.includes('eggs')) {
      items.push({ name: 'eggs', quantity: 1 });
    }
    if (lower.includes('butter')) {
      items.push({ name: 'butter', quantity: 1 });
    }

    // If none of the specific preset keywords matched, parse the real requested product
    if (items.length === 0) {
      let clean = query
        .replace(/^(?:find|search|get|order|buy|show|look for|fetch|i want|please get me|bring me)\s+(?:me\s+)?/i, '')
        .replace(/\s+(?:in under \d+ mins?|in \d+ mins?|fast|urgent|quickly|asap|from swiggy|from zepto|near me)$/i, '')
        .trim();

      const qtyMatch = clean.match(/^(\d+)\s*(?:packets?|pcs?|pieces?|bottles?|cans?|packs?|boxes?)?\s*(?:of\s+)?(.+)$/i);
      if (qtyMatch) {
        const qty = parseInt(qtyMatch[1], 10);
        const name = qtyMatch[2].trim();
        items.push({ name: name || clean, quantity: isNaN(qty) || qty <= 0 ? 1 : qty });
      } else if (clean.length > 0) {
        items.push({ name: clean, quantity: 1 });
      } else {
        items.push({ name: 'groceries', quantity: 1 });
      }
    }

    return items;
  }

  public getSession(sessionId: string): AgentSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  public getAuditTrail(): AuditEntry[] {
    return [...this.auditLogRecords];
  }
}

export const autonomousCommerceRunner = new AutonomousCommerceRunner();
