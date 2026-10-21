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
        sessionId: session.sessionId,
        merchantId: bundle.merchantId,
        merchantOrderId: checkoutResult.orderId,
        pravaTokenRef: tokenResponse.pravaTokenRef,
        idempotencyKey,
        receiptSummary: checkoutResult.receiptSummary,
      }
    );

    // Persist consumption to database if available
    if (db) {
      db.update(schemaMandates)
        .set({ status: 'consumed', consumedAt: new Date() })
        .where(eq(schemaMandates.mandateId, mandateId))
        .catch((dbErr) => console.warn('DB mandate update note:', dbErr.message));

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.user.id);
      if (isUuid) {
        db.query.mandates
          .findFirst({
            where: eq(schemaMandates.mandateId, mandateId),
          })
          .then(async (dbMandate) => {
            if (dbMandate) {
              await db.insert(schemaTransactions).values({
                userId: session.user.id as any,
                sessionId: session.sessionId as any,
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
              });
            }
          })
          .catch((txErr) => console.warn('Note: DB tx insert:', txErr.message));
      }
    }

    session.consumedMandateId = mandateId;
    session.pendingMandate = undefined;

    return result;
  }

  /**
   * Helper to parse natural language shopping prompt into grocery items
   * with extracted product brand, name, max cost constraint, quantity, and delivery time constraint.
   */
  public parseQueryToGroceryItems(query: string): ConstrainedGroceryItem[] {
    const items: ConstrainedGroceryItem[] = [];

    // 1. Extract global time constraint, e.g. "in under 15 mins", "within 10 minutes", "in 10 mins"
    let globalEtaMinutes: number | undefined;
    const etaMatch = query.match(/(?:in\s+under|under|within|in|less than)\s*(\d+)\s*(?:mins?|minutes?)/i);
    if (etaMatch) {
      globalEtaMinutes = parseInt(etaMatch[1], 10);
    } else if (/\b(?:fast|urgent|urgently|asap)\b/i.test(query)) {
      globalEtaMinutes = 15;
    }

    // 2. Extract global budget / cost constraint if present across query, e.g. "budget under 100 rs", "under ₹50"
    // STRICT: Must require currency symbol or unit (₹, rs, inr, rupees) to prevent matching delivery time (e.g. "under 15 mins")
    let globalCostCents: number | undefined;
    const globalCostMatch = query.match(
      /(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?|under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?))|(?:(?:budget\s*(?:of|is)?|under|below|max|within|less than)\s*(\d+(?:\.\d+)?)\s*(?:rs|rupees|inr|bucks))\b/i
    );
    if (globalCostMatch) {
      const valStr = globalCostMatch[1] || globalCostMatch[2];
      if (valStr) {
        globalCostCents = Math.round(parseFloat(valStr) * 100);
      }
    }

    // 3. Known brands dictionary for quick commerce
    const knownBrands = [
      'nandini',
      'amul',
      'britannia',
      'eggoz',
      'the health factory',
      'health factory',
      'milky mist',
      'mother dairy',
      'fortune',
      'aashirvaad',
      'nestle',
      'cadbury',
      'safal',
      'suguna',
    ];

    // 4. Strip conversational lead-ins, follow-up instructions, and trailing constraints
    let clean = query
      .replace(/(?:[\r\n]+|\.\s+)(?:if\s+i\s+(?:am\s+)?asking|please\s+(?:show|give|make|pick)|make\s+sure|i\s+want\s+best|give\s+me\s+best).+$/is, '')
      .replace(/^(?:find|search|get|order|buy|show|look for|fetch|i want|please get me|bring me)\s+(?:me\s+)?/i, '')
      .replace(/\s+(?:in under \d+ mins?|in \d+ mins?|under \d+ mins?|within \d+ mins?|fast|urgent|quickly|asap|from swiggy|from zepto|near me)\.?$/i, '')
      .trim();

    // 5. Split multiple items by "and", "&", "+", or comma (handling Oxford commas like "milk, bread, and eggs")
    const rawSegments = clean
      .split(/(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const segment of rawSegments) {
      let seg = segment;
      let qty = 1;
      let itemCostCents = globalCostCents;
      let itemEtaMinutes = globalEtaMinutes;

      // Extract per-item price constraint if specified on this segment (e.g. "milk under 50 rs")
      const segPriceMatch = seg.match(
        /(?:(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?))|(?:(?:under|below|max|within|less than)\s*(\d+(?:\.\d+)?)\s*(?:rs|rupees|inr|bucks))\b/i
      );
      if (segPriceMatch) {
        const valStr = segPriceMatch[1] || segPriceMatch[2];
        if (valStr) {
          itemCostCents = Math.round(parseFloat(valStr) * 100);
        }
        seg = seg
          .replace(/(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*\d+(?:\.\d+)?/gi, '')
          .replace(/(?:under|below|max|within|less than)\s*\d+(?:\.\d+)?\s*(?:rs|rupees|inr|bucks)/gi, '')
          .trim();
      }

      // Extract per-item ETA constraint if on this segment
      const segEtaMatch = seg.match(/(?:in\s+under|under|within|in)\s*(\d+)\s*(?:mins?|minutes?)/i);
      if (segEtaMatch) {
        itemEtaMinutes = parseInt(segEtaMatch[1], 10);
        seg = seg.replace(/(?:in\s+under|under|within|in)\s*\d+\s*(?:mins?|minutes?)/gi, '').trim();
      }

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

      // Detect brand in this item segment
      let brand: string | undefined;
      const lowerSeg = seg.toLowerCase();
      for (const b of knownBrands) {
        if (lowerSeg.includes(b)) {
          brand = b.charAt(0).toUpperCase() + b.slice(1);
          break;
        }
      }

      // If segment matches "milk 1 litre", "milk 2 litres", "1l milk", etc., standardize generic milk
      if (/^(?:milk\s+(\d+)\s*(?:l|litre|liter|ltr)s?|(\d+)\s*(?:l|litre|liter|ltr)s?\s+milk)$/i.test(seg)) {
        const m = seg.match(/(\d+)/);
        qty = m ? parseInt(m[1], 10) : 1;
        seg = brand ? `${brand} milk` : 'milk';
      }

      if (seg.length > 0) {
        items.push({
          name: seg,
          brand,
          maxCostCents: itemCostCents,
          quantity: qty,
          maxEtaMinutes: itemEtaMinutes,
        });
      }
    }

    if (items.length === 0) {
      items.push({
        name: 'groceries',
        quantity: 1,
        maxCostCents: globalCostCents,
        maxEtaMinutes: globalEtaMinutes,
      });
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
