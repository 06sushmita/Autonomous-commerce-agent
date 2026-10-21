/**
 * Order & Location Validator
 * Enforces spending limits, delivery address confirmation, and dark store inventory checks.
 */

import { DeliveryLocation, QuickCommerceBasketProposal } from '../mcp/types.js';
import { spendTracker } from '../db/spend-tracker.js';

export interface LocationValidationResult {
  valid: boolean;
  location: DeliveryLocation;
  confirmed: boolean;
  message?: string;
}

export interface PrePurchaseValidationResult {
  valid: boolean;
  budgetAllowed: boolean;
  stockAvailable: boolean;
  locationConfirmed: boolean;
  remainingDailySpendCents: number;
  errorMessage?: string;
}

export class OrderValidator {
  /**
   * Validate or update user delivery location for quick commerce
   */
  public validateLocation(
    currentLocation: DeliveryLocation,
    override?: Partial<DeliveryLocation>
  ): LocationValidationResult {
    const effective: DeliveryLocation = {
      address: override?.address || currentLocation.address,
      pincode: override?.pincode || currentLocation.pincode,
      city: override?.city || currentLocation.city,
      latitude: override?.latitude ?? currentLocation.latitude,
      longitude: override?.longitude ?? currentLocation.longitude,
    };

    if (!effective.address || effective.address.trim().length < 5) {
      return {
        valid: false,
        location: effective,
        confirmed: false,
        message: 'A complete delivery street address is required for quick-commerce delivery.',
      };
    }

    if (!effective.pincode || !/^\d{6}$/.test(effective.pincode.trim())) {
      return {
        valid: false,
        location: effective,
        confirmed: false,
        message: 'A valid 6-digit Indian postal pincode is required to locate dark stores.',
      };
    }

    return {
      valid: true,
      location: effective,
      confirmed: true,
      message: `Delivery location confirmed: ${effective.address} (${effective.pincode}).`,
    };
  }

  /**
   * Run comprehensive pre-purchase checks before initiating AP2 mandate or passkey challenge
   */
  public validatePrePurchase(
    userId: string,
    proposal: QuickCommerceBasketProposal,
    dailySpendLimitCents: number = 500000,
    isLocationConfirmed: boolean = true
  ): PrePurchaseValidationResult {
    // 1. Check verified merchant pricing
    if (proposal.isPriceVerified === false) {
      return {
        valid: false,
        budgetAllowed: false,
        stockAvailable: true,
        locationConfirmed: isLocationConfirmed,
        remainingDailySpendCents: 0,
        errorMessage: `Unverified merchant price: Products from ${proposal.merchantName} do not have verified live prices from the authorized merchant integration. Automatic checkout is disabled.`,
      };
    }

    const unverifiedItems = proposal.items.filter((it) => it.isPriceVerified === false || !it.unitPriceCents);
    if (unverifiedItems.length > 0) {
      return {
        valid: false,
        budgetAllowed: false,
        stockAvailable: true,
        locationConfirmed: isLocationConfirmed,
        remainingDailySpendCents: 0,
        errorMessage: `Unverified merchant price for item(s): ${unverifiedItems.map((i) => i.name).join(', ')}. Automatic checkout is disabled.`,
      };
    }

    // 2. Check dark-store item stock availability
    if (proposal.isAvailable === false || (proposal.unavailableItems && proposal.unavailableItems.length > 0)) {
      return {
        valid: false,
        budgetAllowed: false,
        stockAvailable: false,
        locationConfirmed: isLocationConfirmed,
        remainingDailySpendCents: 0,
        errorMessage: `Some items in the cart are currently out of stock at the ${proposal.merchantName} dark store.`,
      };
    }

    // 3. Check delivery location confirmation
    if (!isLocationConfirmed) {
      return {
        valid: false,
        budgetAllowed: false,
        stockAvailable: true,
        locationConfirmed: false,
        remainingDailySpendCents: 0,
        errorMessage: 'Please confirm or update your delivery address before placing the order.',
      };
    }

    // 4. Enforce authoritative daily budget limit
    const spendCheck = spendTracker.validateSpendLimit(
      userId,
      proposal.totalAmountCents,
      dailySpendLimitCents
    );

    if (!spendCheck.allowed) {
      proposal.budgetExceeded = true;
      proposal.excessAmountCents = proposal.totalAmountCents - spendCheck.remainingDailyCents;
      return {
        valid: false,
        budgetAllowed: false,
        stockAvailable: true,
        locationConfirmed: true,
        remainingDailySpendCents: spendCheck.remainingDailyCents,
        errorMessage: spendCheck.reason,
      };
    }

    return {
      valid: true,
      budgetAllowed: true,
      stockAvailable: true,
      locationConfirmed: true,
      remainingDailySpendCents: spendCheck.remainingDailyCents - proposal.totalAmountCents,
    };
  }
}

export const orderValidator = new OrderValidator();
