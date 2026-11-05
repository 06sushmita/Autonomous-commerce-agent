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

import { DeliveryLocation, QuickCommerceBasketProposal, OrderCheckoutResult, ConstrainedGroceryItem } from '../mcp/types.js';
import { extractShoppingIntent } from './intent-extractor.js';
import { quickCommerceMcpManager, MultiPlatformComparison } from '../mcp/mcp-manager.js';
import { ap2PravaBridge, PendingMandateBundle } from '../prava/ap2-bridge.js';
import { getPravaClient, PasskeyVerificationRequest } from '../prava/client.js';
import { orderValidator } from './order-validator.js';
import { authProvider, AuthUser } from '../auth/index.js';
import { spendTracker } from '../db/spend-tracker.js';
import { getDb } from '../db/client.js';
import {
  agentSessions,
  auditLog,
  candidateOptions,
  intents,
  mandates as schemaMandates,
  transactions as schemaTransactions,
} from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface AgentSessionState {
  sessionId: string;
  /** UUID of the durable Neon session record. The public sessionId remains browser-safe. */
  databaseSessionId?: string;
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
  comparison?: MultiPlatformComparison;
  swiggyProposal?: QuickCommerceBasketProposal;
  zeptoProposal?: QuickCommerceBasketProposal;
  swiggyMandateBundle?: PendingMandateBundle;
  zeptoMandateBundle?: PendingMandateBundle;
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

  private isUuid(value: string | undefined): value is string {
    return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  }

  /**
   * Persist a structured audit event without allowing observability failures to
   * interrupt a shopper's order flow.
   */
  private async persistAuditEvent(
    session: AgentSessionState,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!session.databaseSessionId || !this.isUuid(session.user.id)) return;

    const db = getDb();
    if (!db) return;

    try {
      await db.insert(auditLog).values({
        sessionId: session.databaseSessionId,
        userId: session.user.id,
        eventType,
        metadata,
      });
    } catch (err: any) {
      console.warn(`DB audit persistence note (${eventType}):`, err.message);
    }
  }

  private async persistTurn(
    session: AgentSessionState,
    userQuery: string,
    comparison: MultiPlatformComparison
  ): Promise<void> {
    if (!session.databaseSessionId || !this.isUuid(session.user.id)) return;

    const db = getDb();
    if (!db) return;

    try {
      const structuredGoal = extractShoppingIntent(userQuery);
      await db.insert(intents).values({
        sessionId: session.databaseSessionId,
        userId: session.user.id,
        rawMessage: userQuery,
        structuredGoal,
      });

      const proposals = [comparison.swiggyProposal, comparison.zeptoProposal]
        .filter((proposal): proposal is QuickCommerceBasketProposal => Boolean(proposal));
      const options = proposals.flatMap((proposal) => proposal.items.map((item, index) => ({
        sessionId: session.databaseSessionId!,
        merchantId: proposal.platform,
        merchantName: proposal.merchantName,
        itemName: item.name,
        priceCents: item.unitPriceCents ?? 0,
        currency: proposal.currency || 'INR',
        deliveryFeeCents: proposal.deliveryFeeCents ?? 0,
        etaMinutes: proposal.etaMinutes ?? null,
        productUrl: item.productUrl ?? null,
        metadata: {
          clientSessionId: session.sessionId,
          cartId: proposal.cartId,
          quantity: item.quantity,
          totalPriceCents: item.totalPriceCents,
          isAvailable: proposal.isAvailable,
          platform: proposal.platform,
        },
        rank: index + 1,
      })));
      if (options.length > 0) await db.insert(candidateOptions).values(options);

      await db.update(agentSessions)
        .set({
          deliveryLocation: session.activeDeliveryLocation,
          sessionMetadata: { clientSessionId: session.sessionId, latestQuery: userQuery },
        })
        .where(eq(agentSessions.id, session.databaseSessionId));
    } catch (err: any) {
      console.warn('DB shopping-turn persistence note:', err.message);
    }
  }

  private async persistMandate(session: AgentSessionState, bundle: PendingMandateBundle): Promise<void> {
    if (!session.databaseSessionId || !this.isUuid(session.user.id)) return;

    const db = getDb();
    if (!db) return;

    try {
      await db.insert(schemaMandates).values({
        userId: session.user.id,
        sessionId: session.databaseSessionId,
        mandateId: bundle.mandateId,
        merchantId: bundle.merchantId,
        amountCents: bundle.amountCents,
        currency: bundle.currency || 'INR',
        status: 'pending',
        rawMandate: bundle.cartMandate,
        expiresAt: bundle.expiresAt,
      }).onConflictDoNothing({ target: schemaMandates.mandateId });
    } catch (err: any) {
      console.warn('DB mandate persistence note:', err.message);
    }
  }

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

    // The public token is intentionally not the database primary key: database
    // tables require UUID foreign keys, whereas the browser uses `sess_<uuid>`.
    const db = getDb();
    if (db && this.isUuid(user.id)) {
      try {
        const [storedSession] = await db.insert(agentSessions).values({
          userId: user.id,
          status: 'active',
          deliveryLocation: session.activeDeliveryLocation,
          sessionMetadata: { clientSessionId: sessionId, locationConfirmed: session.isLocationConfirmed },
        }).returning({ id: agentSessions.id });
        session.databaseSessionId = storedSession?.id;
      } catch (err: any) {
        console.warn('DB session persistence note:', err.cause?.message || err.message);
      }
    }

    this.sessions.set(sessionId, session);
    await this.persistAuditEvent(session, 'session_initialized', { clientSessionId: sessionId });
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

    // 1. Handle location confirmation or sync with user's current delivery location
    if (locationConfirmation) {
      const locCheck = orderValidator.validateLocation(
        session.activeDeliveryLocation,
        locationConfirmation.override
      );
      session.activeDeliveryLocation = locCheck.location;
      session.isLocationConfirmed = locationConfirmation.confirmed;
    } else if (
      session.user.defaultAddress &&
      (session.user.defaultAddress !== session.activeDeliveryLocation.address ||
       session.user.defaultPincode !== session.activeDeliveryLocation.pincode)
    ) {
      session.activeDeliveryLocation = {
        address: session.user.defaultAddress,
        pincode: session.user.defaultPincode,
        latitude: session.user.defaultLatitude,
        longitude: session.user.defaultLongitude,
      };
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
    await this.persistTurn(session, userQuery, comparison);
    await this.persistAuditEvent(session, 'shopping_turn_processed', {
      clientSessionId: sessionId,
      selectedPlatform: bestProposal.platform,
      totalAmountCents: bestProposal.totalAmountCents,
    });

    // 4. Validate order stock, location, and spending limits
    const validation = orderValidator.validatePrePurchase(
      session.user.id,
      bestProposal,
      session.user.dailySpendLimitCents,
      session.isLocationConfirmed
    );

    if (!validation.valid) {
      if (!validation.budgetAllowed) {
        // Step 5: Budget-aware item selection
        const altProposal = bestProposal.platform === 'swiggy_instamart'
          ? comparison.zeptoProposal
          : comparison.swiggyProposal;

        const remainingBudget = validation.remainingDailySpendCents;
        const excessCents = bestProposal.totalAmountCents - remainingBudget;
        bestProposal.budgetExceeded = true;
        bestProposal.excessAmountCents = excessCents;

        if (altProposal && altProposal.isAvailable && altProposal.totalAmountCents <= remainingBudget) {
          const altMerchant = altProposal.merchantName;
          const excessStr = (excessCents / 100).toFixed(2);
          const altTotalStr = (altProposal.totalAmountCents / 100).toFixed(2);
          const diffStr = ((bestProposal.totalAmountCents - altProposal.totalAmountCents) / 100).toFixed(2);

          const suggestionText = `The requested basket from ${bestProposal.merchantName} (₹${(bestProposal.totalAmountCents / 100).toFixed(2)}) exceeds your remaining daily budget of ₹${(remainingBudget / 100).toFixed(2)} by ₹${excessStr}. However, an equivalent complete basket is available on ${altMerchant} for ₹${altTotalStr} (saving ₹${diffStr}), which fits within your budget. Explicit approval is required to change merchants.`;

          bestProposal.budgetSuggestion = {
            text: suggestionText,
            alternativeProposal: altProposal,
            requiredApproval: `Switch to ${altMerchant} to fit within daily budget`,
          };
        } else {
          const excessStr = (excessCents / 100).toFixed(2);
          bestProposal.budgetSuggestion = {
            text: `The requested order total of ₹${(bestProposal.totalAmountCents / 100).toFixed(2)} exceeds your remaining daily budget of ₹${(remainingBudget / 100).toFixed(2)} by ₹${excessStr}. No equivalent basket fits within the remaining limit. You can increase your daily wallet limit or approve a change in items/quantities.`,
          };
        }
      }

      return {
        sessionId,
        proposal: bestProposal,
        comparison,
        swiggyProposal: comparison.swiggyProposal,
        zeptoProposal: comparison.zeptoProposal,
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
    await this.persistMandate(session, mandateBundle);
    await this.persistAuditEvent(session, 'mandate_created', {
      mandateId: mandateBundle.mandateId,
      amountCents: mandateBundle.amountCents,
      merchantId: mandateBundle.merchantId,
    });

    // Create alternative platform mandate bundle if both are available, to support instant tab switching!
    let swiggyMandateBundle = bestProposal.platform === 'swiggy_instamart' ? mandateBundle : undefined;
    let zeptoMandateBundle = bestProposal.platform === 'zepto' ? mandateBundle : undefined;

    if (!swiggyMandateBundle && comparison.swiggyProposal && comparison.swiggyProposal.isAvailable) {
      try {
        swiggyMandateBundle = await ap2PravaBridge.createBasketMandate(
          comparison.swiggyProposal,
          session.user.id
        );
      } catch {}
    }
    if (!zeptoMandateBundle && comparison.zeptoProposal && comparison.zeptoProposal.isAvailable) {
      try {
        zeptoMandateBundle = await ap2PravaBridge.createBasketMandate(
          comparison.zeptoProposal,
          session.user.id
        );
      } catch {}
    }

    return {
      sessionId,
      proposal: bestProposal,
      comparison,
      swiggyProposal: comparison.swiggyProposal,
      zeptoProposal: comparison.zeptoProposal,
      swiggyMandateBundle,
      zeptoMandateBundle,
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

    // Refresh user profile with latest authoritative limits & settings
    try {
      const refreshedUser = await authProvider.getAuthenticatedUser(session.user.id);
      if (refreshedUser) {
        session.user = refreshedUser;
      }
    } catch {
      // Keep existing session user if lookup fails
    }

    // 0a. Authentication invariant: User cannot order before signing up
    if (!session.user || session.user.id === 'guest' || session.user.id === 'unauthenticated') {
      throw new Error('Authentication Required: User must be signed up and authenticated to execute checkout.');
    }

    // 0b. Cross-user authorization check
    // Allow match on UUID id, Clerk user ID, or email — the frontend may send any of these
    if (
      requestingUserId &&
      session.user.id !== requestingUserId &&
      session.user.clerkUserId !== requestingUserId &&
      session.user.email?.toLowerCase() !== requestingUserId.toLowerCase()
    ) {
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

    // 4. Revalidate budget immediately before payment authorization and reserve atomically
    const spendReservation = await spendTracker.reserveSpendAsync(
      session.user.id,
      bundle.amountCents,
      mandateId,
      session.user.dailySpendLimitCents
    );
    if (!spendReservation.allowed) {
      this.inFlightClaims.delete(mandateId);
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
      await spendTracker.releaseReservationAsync(mandateId, 'prava_passkey_failed');
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
      await spendTracker.releaseReservationAsync(mandateId, 'merchant_checkout_failed');
      throw checkoutErr;
    }

    if (!checkoutResult.success) {
      this.inFlightClaims.delete(mandateId);
      await spendTracker.releaseReservationAsync(mandateId, 'merchant_checkout_unsuccessful');
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

    // Commit spend reservation permanently in memory and database
    await spendTracker.commitReservationAsync(
      mandateId,
      session.user.id,
      bundle.amountCents,
      {
        sessionId: session.databaseSessionId || session.sessionId,
        merchantId: bundle.merchantId,
        merchantOrderId: checkoutResult.orderId,
        pravaTokenRef: tokenResponse.pravaTokenRef,
        idempotencyKey,
        receiptSummary: checkoutResult.receiptSummary,
      }
    );

    // Persist consumption to database if available
    if (db && session.databaseSessionId && this.isUuid(session.user.id)) {
      try {
        const [dbMandate] = await db.update(schemaMandates)
          .set({
            status: 'consumed',
            consumedAt: new Date(),
            signedMandate: { mandate: bundle.cartMandate, signature: verification.signature },
          })
          .where(eq(schemaMandates.mandateId, mandateId))
          .returning({ id: schemaMandates.id });

        if (dbMandate) {
          await db.insert(schemaTransactions).values({
            userId: session.user.id,
            sessionId: session.databaseSessionId,
            mandateId: dbMandate.id,
            idempotencyKey: idempotencyKey || null,
            pravaTokenRef: tokenResponse.pravaTokenRef,
            merchantId: bundle.merchantId,
            merchantOrderId: checkoutResult.orderId || null,
            amountCents: bundle.amountCents,
            currency: bundle.currency || 'INR',
            status: 'completed',
            receiptSummary: checkoutResult.receiptSummary || {},
            completedAt: new Date(),
          }).onConflictDoNothing({ target: schemaTransactions.mandateId });
        }

        await db.update(agentSessions)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(agentSessions.id, session.databaseSessionId));
      } catch (dbErr: any) {
        console.warn('DB checkout persistence note:', dbErr.message);
      }
    }

    session.consumedMandateId = mandateId;
    session.pendingMandate = undefined;
    await this.persistAuditEvent(session, 'checkout_completed', {
      mandateId,
      transactionId,
      merchantOrderId: checkoutResult.orderId,
      amountCents: bundle.amountCents,
    });

    return result;
  }

  /**
   * Execute Prava v1 Order:
   * Polls Prava payment-result for minted virtual credentials / token,
   * executes merchant checkout via MCP, and reports transaction status to Prava.
   */
  public async executePravaOrderCheckout(
    sessionId: string,
    pravaSessionId: string,
    mandateId: string,
    requestingUserId?: string
  ): Promise<CheckoutExecutionResult & { txnRefId: string; pravaCardId?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      const refreshedUser = await authProvider.getAuthenticatedUser(session.user.id);
      if (refreshedUser) {
        session.user = refreshedUser;
      }
    } catch {
      // Keep existing user if lookup fails
    }

    if (!session.user || session.user.id === 'guest' || session.user.id === 'unauthenticated') {
      throw new Error('Authentication Required: User must be signed up and authenticated to execute checkout.');
    }

    if (
      requestingUserId &&
      session.user.id !== requestingUserId &&
      session.user.clerkUserId !== requestingUserId &&
      session.user.email?.toLowerCase() !== requestingUserId.toLowerCase()
    ) {
      throw new Error('Forbidden: Session does not belong to the requesting user.');
    }

    if (
      this.consumedMandates.has(mandateId) ||
      this.inFlightClaims.has(mandateId) ||
      this.transactionLedger.has(mandateId)
    ) {
      throw new Error(
        `Financial safety violation: Mandate ${mandateId} has already been consumed and cannot be reused.`
      );
    }

    this.inFlightClaims.add(mandateId);

    const bundle = session.pendingMandate;
    if (!bundle || bundle.mandateId !== mandateId) {
      this.inFlightClaims.delete(mandateId);
      throw new Error(`Invalid or missing mandate: ${mandateId}`);
    }

    // Expiration check (10-minute window)
    if (new Date() > bundle.expiresAt) {
      this.inFlightClaims.delete(mandateId);
      throw new Error('Biometric approval window has expired (10-minute limit). Please request a fresh proposal.');
    }

    // Reserve spend allowance
    const spendReservation = await spendTracker.reserveSpendAsync(
      session.user.id,
      bundle.amountCents,
      mandateId,
      session.user.dailySpendLimitCents
    );
    if (!spendReservation.allowed) {
      this.inFlightClaims.delete(mandateId);
      throw new Error(spendReservation.reason || 'Daily spend limit exceeded.');
    }

    let credentials: any;
    try {
      // 1. Poll Prava payment result (retrieves minted virtual card / token)
      credentials = await getPravaClient().pollPravaPaymentResult(pravaSessionId);
    } catch (pollErr: any) {
      this.inFlightClaims.delete(mandateId);
      await spendTracker.releaseReservationAsync(mandateId, 'prava_poll_failed');
      throw pollErr;
    }

    // 2. Execute platform checkout via MCP
    const platform = bundle.merchantId === 'swiggy' ? 'swiggy_instamart' : 'zepto';
    let checkoutResult: any;
    try {
      checkoutResult = await quickCommerceMcpManager.executePlatformCheckout(
        platform,
        session.activeProposal!.cartId,
        credentials.token
      );
    } catch (checkoutErr: any) {
      this.inFlightClaims.delete(mandateId);
      await spendTracker.releaseReservationAsync(mandateId, 'merchant_checkout_failed');
      // Report DECLINED to Prava to close transaction loop
      await getPravaClient().reportPravaTransactionStatus(pravaSessionId, credentials.txnRefId, 'DECLINED').catch(() => {});
      throw checkoutErr;
    }

    if (!checkoutResult.success) {
      this.inFlightClaims.delete(mandateId);
      await spendTracker.releaseReservationAsync(mandateId, 'merchant_checkout_unsuccessful');
      await getPravaClient().reportPravaTransactionStatus(pravaSessionId, credentials.txnRefId, 'DECLINED').catch(() => {});
      throw new Error(`Checkout failed at merchant ${platform}`);
    }

    // 3. Report APPROVED to Prava to finalize session
    await getPravaClient().reportPravaTransactionStatus(pravaSessionId, credentials.txnRefId, 'APPROVED').catch(() => {});

    // 4. Atomic transaction settlement
    const transactionId = `tx_${crypto.randomUUID()}`;
    this.consumedMandates.add(mandateId);
    this.inFlightClaims.delete(mandateId);

    const result = {
      success: true,
      order: checkoutResult,
      mandateId,
      transactionId,
      pravaTokenRef: credentials.token,
      txnRefId: credentials.txnRefId,
      pravaCardId: credentials.cardId,
    };

    this.transactionLedger.set(mandateId, result as any);

    await spendTracker.commitReservationAsync(
      mandateId,
      session.user.id,
      bundle.amountCents,
      {
        sessionId: session.databaseSessionId || session.sessionId,
        merchantId: bundle.merchantId,
        merchantOrderId: checkoutResult.orderId,
        pravaTokenRef: credentials.token,
        receiptSummary: checkoutResult.receiptSummary,
      }
    );

    const db = getDb();
    if (db && session.databaseSessionId && this.isUuid(session.user.id)) {
      try {
        const [dbMandate] = await db.update(schemaMandates)
          .set({
            status: 'consumed',
            consumedAt: new Date(),
          })
          .where(eq(schemaMandates.mandateId, mandateId))
          .returning({ id: schemaMandates.id });

        if (dbMandate) {
          await db.insert(schemaTransactions).values({
            userId: session.user.id,
            sessionId: session.databaseSessionId,
            mandateId: dbMandate.id,
            pravaTokenRef: credentials.token,
            merchantId: bundle.merchantId,
            merchantOrderId: checkoutResult.orderId || null,
            amountCents: bundle.amountCents,
            currency: bundle.currency || 'INR',
            status: 'completed',
            receiptSummary: checkoutResult.receiptSummary || {},
            completedAt: new Date(),
          }).onConflictDoNothing({ target: schemaTransactions.mandateId });
        }

        await db.update(agentSessions)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(agentSessions.id, session.databaseSessionId));
      } catch (dbErr: any) {
        console.warn('DB Prava checkout persistence note:', dbErr.message);
      }
    }

    session.consumedMandateId = mandateId;
    session.pendingMandate = undefined;
    await this.persistAuditEvent(session, 'checkout_completed', {
      mandateId,
      transactionId,
      merchantOrderId: checkoutResult.orderId,
      amountCents: bundle.amountCents,
      pravaSessionId,
      txnRefId: credentials.txnRefId,
    });

    return result;
  }

  /**
   * Helper to parse natural language shopping prompt into grocery items
   * with extracted product brand, name, max cost constraint, quantity, and delivery time constraint.
   */
  public parseQueryToGroceryItems(query: string): ConstrainedGroceryItem[] {
    const intent = extractShoppingIntent(query);
    return intent.items.map((item) => ({
      name: item.product,
      brand: item.brand || undefined,
      maxCostCents: item.maxCostCents,
      quantity: item.requestedQuantity,
      maxEtaMinutes: item.maxEtaMinutes,
      requestedQuantity: item.requestedQuantity,
      requestedUnit: item.requestedUnit,
      packSizePreference: item.packSizePreference,
      variants: item.variants,
      intentItem: item,
    }));
  }

  public getSession(sessionId: string): AgentSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  public getAuditTrail(): AuditEntry[] {
    return [...this.auditLogRecords];
  }
}

export const autonomousCommerceRunner = new AutonomousCommerceRunner();
