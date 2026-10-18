/**
 * Spend Tracker & Limit Calculator
 * Computes rolling 24-hour aggregate transaction volume and checks against user daily budget limits.
 */

import { eq, and, gte, sum } from 'drizzle-orm';
import { transactions } from './schema.js';
import { getDb } from './client.js';

export interface UserSpendProfile {
  userId: string;
  dailySpendLimitCents: number; // In paise
  rolling24hSpentCents: number; // In paise
  remainingDailySpendCents: number; // In paise
  currency: 'INR';
}

export interface SpendValidationResult {
  allowed: boolean;
  attemptedCents: number;
  remainingDailyCents: number;
  reason?: string;
}

export class SpendTracker {
  // In-memory completed transactions store for testing and fallback
  private mockCompletedTransactions: Array<{
    userId: string;
    amountCents: number;
    completedAt: Date;
  }> = [];

  /**
   * Record a completed transaction in memory (for tests/fallback)
   */
  public recordCompletedTransaction(userId: string, amountCents: number, completedAt: Date = new Date()): void {
    this.mockCompletedTransactions.push({ userId, amountCents, completedAt });
  }

  /**
   * Calculate total spend by a user in the rolling 24-hour window (in-memory)
   */
  public calculateRolling24hSpend(userId: string, now: Date = new Date()): number {
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return this.mockCompletedTransactions
      .filter((tx) => tx.userId === userId && tx.completedAt >= twentyFourHoursAgo)
      .reduce((sum, tx) => sum + tx.amountCents, 0);
  }

  /**
   * Calculate total spend by a user in the rolling 24-hour window from PostgreSQL database
   */
  public async calculateRolling24hSpendFromDb(
    userId: string,
    dbOverride?: any,
    now: Date = new Date()
  ): Promise<number> {
    const db = dbOverride || getDb();
    if (!db) {
      // Graceful fallback to in-memory if DB is not configured
      return this.calculateRolling24hSpend(userId, now);
    }

    try {
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const result = await db
        .select({ total: sum(transactions.amountCents) })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.status, 'completed'),
            gte(transactions.completedAt, twentyFourHoursAgo)
          )
        );

      const total = result[0]?.total ? Number(result[0].total) : 0;
      return total;
    } catch {
      // Graceful fallback to in-memory if DB query fails or DB is offline
      return this.calculateRolling24hSpend(userId, now);
    }
  }

  /**
   * Get user spend profile
   */
  public getUserSpendProfile(
    userId: string,
    dailySpendLimitCents: number = 500000 // default ₹5,000.00
  ): UserSpendProfile {
    const rolling24hSpentCents = this.calculateRolling24hSpend(userId);
    const remainingDailySpendCents = Math.max(0, dailySpendLimitCents - rolling24hSpentCents);

    return {
      userId,
      dailySpendLimitCents,
      rolling24hSpentCents,
      remainingDailySpendCents,
      currency: 'INR',
    };
  }

  /**
   * Async variant retrieving spend profile directly using database query
   */
  public async getUserSpendProfileAsync(
    userId: string,
    dailySpendLimitCents: number = 500000,
    dbOverride?: any
  ): Promise<UserSpendProfile> {
    const rolling24hSpentCents = await this.calculateRolling24hSpendFromDb(userId, dbOverride);
    const remainingDailySpendCents = Math.max(0, dailySpendLimitCents - rolling24hSpentCents);

    return {
      userId,
      dailySpendLimitCents,
      rolling24hSpentCents,
      remainingDailySpendCents,
      currency: 'INR',
    };
  }

  /**
   * Validate whether an attempted purchase is within limits
   */
  public validateSpendLimit(
    userId: string,
    purchaseAmountCents: number,
    dailySpendLimitCents: number = 500000
  ): SpendValidationResult {
    const profile = this.getUserSpendProfile(userId, dailySpendLimitCents);

    if (purchaseAmountCents > profile.remainingDailySpendCents) {
      const attemptedInr = (purchaseAmountCents / 100).toFixed(2);
      const remainingInr = (profile.remainingDailySpendCents / 100).toFixed(2);
      return {
        allowed: false,
        attemptedCents: purchaseAmountCents,
        remainingDailyCents: profile.remainingDailySpendCents,
        reason: `Purchase amount of ₹${attemptedInr} exceeds your remaining daily spend allowance of ₹${remainingInr}.`,
      };
    }

    return {
      allowed: true,
      attemptedCents: purchaseAmountCents,
      remainingDailyCents: profile.remainingDailySpendCents,
    };
  }

  /**
   * Async validation checking against database spend totals
   */
  public async validateSpendLimitAsync(
    userId: string,
    purchaseAmountCents: number,
    dailySpendLimitCents: number = 500000,
    dbOverride?: any
  ): Promise<SpendValidationResult> {
    const profile = await this.getUserSpendProfileAsync(userId, dailySpendLimitCents, dbOverride);

    if (purchaseAmountCents > profile.remainingDailySpendCents) {
      const attemptedInr = (purchaseAmountCents / 100).toFixed(2);
      const remainingInr = (profile.remainingDailySpendCents / 100).toFixed(2);
      return {
        allowed: false,
        attemptedCents: purchaseAmountCents,
        remainingDailyCents: profile.remainingDailySpendCents,
        reason: `Purchase amount of ₹${attemptedInr} exceeds your remaining daily spend allowance of ₹${remainingInr}.`,
      };
    }

    return {
      allowed: true,
      attemptedCents: purchaseAmountCents,
      remainingDailyCents: profile.remainingDailySpendCents,
    };
  }

  public clear(): void {
    this.mockCompletedTransactions = [];
  }
}

export const spendTracker = new SpendTracker();
