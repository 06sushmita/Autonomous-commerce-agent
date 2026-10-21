/**
 * AP2 Mandate Bridge
 * Integrates @agorio/sdk Ap2Client with Prava Payments WebAuthn passkey gateway.
 */

import { Ap2Client, CartLineItem, CartMandate, verifyMandateShape } from '@agorio/sdk';
import { QuickCommerceBasketProposal } from '../mcp/types.js';
import { getPravaClient, PasskeyChallengeResponse, PravaAuthorizationProvider } from './client.js';

export interface PendingMandateBundle {
  mandateId: string;
  cartMandate: CartMandate;
  challenge: PasskeyChallengeResponse;
  merchantId: string;
  amountCents: number;
  currency: string;
  userId: string;
  expiresAt: Date;
}

export class Ap2PravaBridge {
  private pravaOverride?: PravaAuthorizationProvider;

  constructor(prava?: PravaAuthorizationProvider) {
    this.pravaOverride = prava;
  }

  private getPrava(): PravaAuthorizationProvider {
    return this.pravaOverride || getPravaClient();
  }

  /**
   * Create an AP2 CartMandate scoped to merchant and amount, with a 10-minute expiry
   */
  public async createBasketMandate(
    proposal: QuickCommerceBasketProposal,
    userId: string
  ): Promise<PendingMandateBundle> {
    const merchantId = proposal.platform === 'swiggy_instamart' ? 'swiggy' : 'zepto';
    const amountInr = (proposal.totalAmountCents / 100).toFixed(2);

    const ap2Client = new Ap2Client({
      merchantId,
      mandateTtlMs: 10 * 60 * 1000,
    });

    // 1. Create AP2 IntentMandate (10 minute expiry)
    const intent = ap2Client.createIntentMandate({
      amount: amountInr,
      currency: proposal.currency,
    });

    // 2. Map basket items to AP2 CartLineItems
    const lineItems: CartLineItem[] = proposal.items.map((item) => {
      const pricePaise = item.unitPriceCents ?? (item as any).priceCents ?? 0;
      return {
        productId: item.itemId || (item as any).id,
        name: item.name,
        quantity: item.quantity || 1,
        unitPrice: (pricePaise / 100).toFixed(2),
        currency: proposal.currency,
      };
    });

    if (proposal.deliveryFeeCents > 0) {
      lineItems.push({
        productId: 'delivery_fee',
        name: 'Quick Commerce Dark Store Delivery Fee',
        quantity: 1,
        unitPrice: (proposal.deliveryFeeCents / 100).toFixed(2),
        currency: proposal.currency,
      });
    }

    if (proposal.taxCents > 0) {
      lineItems.push({
        productId: 'gst_taxes',
        name: 'GST & Statutory Taxes',
        quantity: 1,
        unitPrice: (proposal.taxCents / 100).toFixed(2),
        currency: proposal.currency,
      });
    }

    // 3. Attach cart to create CartMandate
    const cartMandate = ap2Client.attachCart(intent, lineItems);

    // 4. Validate CartMandate fields
    if (!cartMandate.mandateId || !cartMandate.amount || !cartMandate.lineItems || cartMandate.lineItems.length === 0) {
      throw new Error('Invalid AP2 CartMandate: missing required fields or empty basket items');
    }

    // 5. Request FIDO WebAuthn passkey challenge from Prava
    const challenge = await this.getPrava().createPasskeyChallenge({
      mandateId: cartMandate.mandateId,
      merchantId,
      amountCents: proposal.totalAmountCents,
      currency: proposal.currency,
      userId,
    });

    return {
      mandateId: cartMandate.mandateId,
      cartMandate,
      challenge,
      merchantId,
      amountCents: proposal.totalAmountCents,
      currency: proposal.currency,
      userId,
      expiresAt: new Date(cartMandate.expiresAt),
    };
  }

  /**
   * Package and verify a signed mandate with cryptographic signature
   */
  public buildAndVerifySignedMandate(
    cartMandate: CartMandate,
    signature: string,
    keyId = 'fido2-user-key-01'
  ) {
    if (!signature || typeof signature !== 'string' || signature.trim() === '') {
      throw new Error('SignedMandate verification failed: signature is missing or empty');
    }

    if (!cartMandate.expiresAt) {
      throw new Error('SignedMandate verification failed: missing expiration timestamp');
    }

    const expiryTime = new Date(cartMandate.expiresAt).getTime();
    if (isNaN(expiryTime) || expiryTime <= Date.now()) {
      throw new Error('SignedMandate verification failed: mandate has expired');
    }

    if (!cartMandate.mandateId || !cartMandate.amount || !cartMandate.lineItems || cartMandate.lineItems.length === 0) {
      throw new Error('SignedMandate verification failed: invalid mandate structure');
    }

    const signedMandate = {
      mandate: cartMandate,
      signature,
      algorithm: 'ES256',
      keyId,
    };

    const shape = verifyMandateShape(signedMandate);
    if (!shape.ok) {
      throw new Error(`SignedMandate verification failed: ${shape.reason}`);
    }

    return signedMandate;
  }
}

export const ap2PravaBridge = new Ap2PravaBridge();
