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
import { getPravaClient, PasskeyVerificationRequest } from '../prava/client.js';
import { orderValidator } from './order-validator.js';
import { authProvider, AuthUser } from '../auth/index.js';
import { spendTracker } from '../db/spend-tracker.js';
import { getDb } from '../db/client.js';
import { mandates as schemaMandates, transactions as schemaTransactions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

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

interface IdempotencyRecord {
  userId: string;
  mandateId: string;
  merchantId: string;
  amountCents: number;
  result: CheckoutExecutionResult;
}

export class AutonomousCommerceRunner {
  private sessions: Map<string, AgentSessionState> = new Map();
  private auditLogRecords: AuditEntry[] = [];
  // Store consumed mandate IDs in memory to enforce single-use guarantee
  private consumedMandates: Set<string> = new Set();
  // In-flight claims to prevent race conditions during concurrent checkouts
  private inFlightClaims: Set<string> = new Set();
  // Store recorded transactions to enforce unique mandate_id constraint
  private transactionLedger: Map<string, CheckoutExecutionResult> = new Map();
  // Idempotency ledger mapping stable key to immutable execution parameters and result
  private idempotencyLedger: Map<string, IdempotencyRecord> = new Map();

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
    verification: PasskeyVerificationRequest,
    idempotencyKey?: string,
    requestingUserId?: string
  ): Promise<CheckoutExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 0a. Authentication invariant: User cannot order before signing up
    if (!session.user || session.user.id === 'guest' || session.user.id === 'unauthenticated') {
      throw new Error('Authentication Required: User must be signed up and authenticated to execute checkout.');
    }

    // 0b. Cross-user authorization check
    if (requestingUserId && session.user.id !== requestingUserId && session.user.clerkUserId !== requestingUserId) {
      throw new Error('Forbidden: Session does not belong to the requesting user.');
    }

    // 0b. Idempotency Check & Payload Invariance Validation
    if (idempotencyKey) {
      const existing = this.idempotencyLedger.get(idempotencyKey);
      if (existing) {
        if (
          existing.userId !== session.user.id ||
          existing.mandateId !== mandateId
        ) {
          throw new Error(
            `Idempotency violation: Idempotency key "${idempotencyKey}" was previously submitted with different checkout parameters.`
          );
        }
        return existing.result;
      }
    }

    // 0c. Double-spend prevention and race-condition check (Enforces mandate single-use guarantee)
    if (
      this.consumedMandates.has(mandateId) ||
      this.inFlightClaims.has(mandateId) ||
      this.transactionLedger.has(mandateId)
    ) {
      throw new Error(
        `Financial safety violation: Mandate ${mandateId} has already been consumed and cannot be reused.`
      );
    }

    // Synchronously lock mandate in-flight before any async yields
    this.inFlightClaims.add(mandateId);

    const db = getDb();
    if (db) {
      try {
        const dbMandate = await db.query.mandates.findFirst({
          where: eq(schemaMandates.mandateId, mandateId),
        });
        if (dbMandate && dbMandate.status === 'consumed') {
          this.consumedMandates.add(mandateId);
          this.inFlightClaims.delete(mandateId);
          throw new Error(
            `Financial safety violation: Mandate ${mandateId} has already been consumed and cannot be reused.`
          );
        }
      } catch (err: any) {
        if (err.message.includes('Financial safety violation')) throw err;
      }
    }

    const bundle = session.pendingMandate;
    if (!bundle || bundle.mandateId !== mandateId) {
      this.inFlightClaims.delete(mandateId);
      throw new Error(`Invalid or missing mandate: ${mandateId}`);
    }

    // 1a. User identity binding verification
    if (bundle.userId && bundle.userId !== session.user.id) {
      throw new Error('Authorization violation: Mandate was issued to a different user.');
    }

    // 1b. Purchase facts binding verification
    if (session.activeProposal) {
      const proposalMerchant = session.activeProposal.platform === 'swiggy_instamart' ? 'swiggy' : 'zepto';
      if (bundle.merchantId !== proposalMerchant) {
        throw new Error(
          `Purchase binding mismatch: Mandate merchant (${bundle.merchantId}) does not match cart merchant (${proposalMerchant}). Fresh authorization required.`
        );
      }
      if (bundle.amountCents !== session.activeProposal.totalAmountCents) {
        throw new Error(
          `Purchase binding mismatch: Mandate amount (${bundle.amountCents}) does not match cart total (${session.activeProposal.totalAmountCents}). Fresh authorization required.`
        );
      }
      if (bundle.currency !== session.activeProposal.currency) {
        throw new Error(
          `Purchase binding mismatch: Mandate currency (${bundle.currency}) does not match cart currency (${session.activeProposal.currency}). Fresh authorization required.`
        );
      }
    }

    // 3. Expiration check (10-minute window)
    if (new Date() > bundle.expiresAt) {
      throw new Error('Biometric approval window has expired (10-minute limit). Please request a fresh proposal.');
    }

    // 4. Reserve budget atomically before any external calls
    const spendReservation = spendTracker.reserveSpend(
      session.user.id,
      bundle.amountCents,
      mandateId,
      session.user.dailySpendLimitCents
    );
    if (!spendReservation.allowed) {
      throw new Error(spendReservation.reason || 'Daily spend limit exceeded.');
    }

    // Mark mandate in-flight
    this.inFlightClaims.add(mandateId);

    let tokenResponse: any;
    try {
      // 5. Cryptographically verify the signed mandate
      ap2PravaBridge.buildAndVerifySignedMandate(bundle.cartMandate, verification.signature);

      // 6. Verify passkey signature via Prava and retrieve single-use payment token reference
      tokenResponse = await getPravaClient().verifyPasskeyAndIssueToken(
        verification,
        bundle.merchantId,
        bundle.amountCents,
        bundle.currency
      );

      if (!tokenResponse.success || !tokenResponse.pravaTokenRef) {
        throw new Error('Biometric passkey signature verification failed with Prava payments.');
      }
    } catch (authErr: any) {
      this.inFlightClaims.delete(mandateId);
      spendTracker.releaseReservation(mandateId);
      throw authErr;
    }

    // 7. Autonomous checkout via Quick-Commerce MCP
    const platform = bundle.merchantId === 'swiggy' ? 'swiggy_instamart' : 'zepto';
    let checkoutResult: any;
    try {
      checkoutResult = await quickCommerceMcpManager.executePlatformCheckout(
        platform,
        session.activeProposal!.cartId,
        tokenResponse.pravaTokenRef
      );
    } catch (checkoutErr: any) {
      this.inFlightClaims.delete(mandateId);
      spendTracker.releaseReservation(mandateId);
      throw checkoutErr;
    }

    if (!checkoutResult.success) {
      this.inFlightClaims.delete(mandateId);
      spendTracker.releaseReservation(mandateId);
      throw new Error(`Checkout failed at merchant ${platform}`);
    }

    // 8. Atomic transaction settlement
    const transactionId = `tx_${crypto.randomUUID()}`;
    this.consumedMandates.add(mandateId);
    this.inFlightClaims.delete(mandateId);

    const result: CheckoutExecutionResult = {
      success: true,
      order: checkoutResult,
      mandateId,
      transactionId,
      pravaTokenRef: tokenResponse.pravaTokenRef,
    };

    this.transactionLedger.set(mandateId, result);
    if (idempotencyKey) {
      this.transactionLedger.set(idempotencyKey, result);
      this.idempotencyLedger.set(idempotencyKey, {
        userId: session.user.id,
        mandateId,
        merchantId: bundle.merchantId,
        amountCents: bundle.amountCents,
        result,
      });
    }

    // Commit spend reservation permanently
    spendTracker.commitReservation(mandateId, session.user.id, bundle.amountCents);

    // Persist consumption to database if available
    if (db) {
      db.update(schemaMandates)
        .set({ status: 'consumed', consumedAt: new Date() })
        .where(eq(schemaMandates.mandateId, mandateId))
        .catch((dbErr) => console.warn('DB mandate update note:', dbErr.message));
    }

    session.consumedMandateId = mandateId;
    session.pendingMandate = undefined;

    return result;
  }

  /**
   * Helper to parse natural language shopping prompt into grocery items
   */
  private parseQueryToGroceryItems(query: string): Array<{ name: string; quantity: number }> {
    const items: Array<{ name: string; quantity: number }> = [];

    // 1. Strip conversational lead-ins and trailing delivery/time/merchant constraints
    let clean = query
      .replace(/^(?:find|search|get|order|buy|show|look for|fetch|i want|please get me|bring me)\s+(?:me\s+)?/i, '')
      .replace(/\s+(?:in under \d+ mins?|in \d+ mins?|under \d+ mins?|fast|urgent|quickly|asap|from swiggy|from zepto|near me)\.?$/i, '')
      .trim();

    // 2. Split multiple items by "and", "&", "+", or comma (handling Oxford commas like "milk, bread, and eggs")
    const rawSegments = clean
      .split(/(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const segment of rawSegments) {
      let seg = segment;
      let qty = 1;

      // Handle leading quantity with packaging word, e.g. "2 packets of milk", "1 packet milk", "6 pcs eggs"
      const leadingPacketMatch = seg.match(/^(\d+)\s*(?:packets?|pcs?|pieces?|bottles?|cans?|packs?|boxes?|cartons?|loaf|loaves)\s*(?:of\s+)?(.+)$/i);
      if (leadingPacketMatch) {
        qty = parseInt(leadingPacketMatch[1], 10) || 1;
        seg = leadingPacketMatch[2].trim();
      } else {
        // Handle trailing quantity/packaging, e.g. "eggs 6 pcs", "eggs 6", "milk 2 packets"
        const trailingQtyMatch = seg.match(/^(.+?)\s+(\d+)\s*(?:packets?|pcs?|pieces?|bottles?|cans?|packs?|boxes?|cartons?|loaf|loaves)?$/i);
        if (trailingQtyMatch && !/^\d+\s*(?:l|litre|liter|ml|g|kg|oz)\b/i.test(trailingQtyMatch[2])) {
          qty = parseInt(trailingQtyMatch[2], 10) || 1;
          seg = trailingQtyMatch[1].trim();
        } else {
          // Handle leading plain number, e.g. "2 milk" (but not volume like "1L milk")
          const countMatch = seg.match(/^(\d+)\s+([a-zA-Z].+)$/);
          if (countMatch && !/^\d+\s*(?:l|litre|liter|ml|g|kg|oz)\b/i.test(seg)) {
            qty = parseInt(countMatch[1], 10) || 1;
            seg = countMatch[2].trim();
          }
        }
      }

      // If segment matches "milk 1 litre", "1l milk", etc., standardize generic milk
      if (/^(?:milk\s+(\d+)\s*(?:l|litre|liter)|(\d+)\s*(?:l|litre|liter)\s+milk)$/i.test(seg)) {
        const m = seg.match(/(\d+)/);
        qty = m ? parseInt(m[1], 10) : 1;
        seg = 'milk';
      }

      if (seg.length > 0) {
        items.push({ name: seg, quantity: qty });
      }
    }

    if (items.length === 0) {
      items.push({ name: 'groceries', quantity: 1 });
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
