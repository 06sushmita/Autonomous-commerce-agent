import { eq, and, gte, lte, sum } from 'drizzle-orm';
import { transactions, budgetReservations, users } from './schema.js';
import { getDb } from './client.js';
import { authProvider } from '../auth/index.js';

export class BudgetVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetVerificationError';
  }
}

export interface UserSpendProfile {
  userId: string;
  dailySpendLimitCents: number; // In paise (100 paise = 1 INR)
  rolling24hSpentCents: number; // In paise (spent in period)
  remainingDailySpendCents: number; // In paise
  currency: 'INR';
  timeZone?: string;
  periodStart?: Date;
  periodEnd?: Date;
  activeReservedCents?: number;
}

export interface SpendValidationResult {
  allowed: boolean;
  attemptedCents: number;
  remainingDailyCents: number;
  reason?: string;
  reservationId?: string;
}

export interface ActiveSpendReservation {
  reservationId: string;
  userId: string;
  mandateId: string;
  amountCents: number;
  createdAt: Date;
  expiresAt: Date;
  status?: 'active' | 'committed' | 'released' | 'expired';
}

export interface LocalDayBounds {
  startOfDay: Date;
  endOfDay: Date;
  timeZone: string;
  localDateString: string;
}

export class SpendTracker {
  private defaultTimeZone: string = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  public mode: 'local_day' | 'rolling_24h' = 'local_day';

  // In-memory completed transactions store for testing and fallback
  private mockCompletedTransactions: Array<{
    userId: string;
    amountCents: number;
    completedAt: Date;
    transactionId?: string;
  }> = [];

  // Active in-flight spend reservations to prevent concurrent checkout overspend
  private activeReservations: Map<string, ActiveSpendReservation> = new Map();

  public setTimeZone(tz: string): void {
    this.defaultTimeZone = tz;
  }

  public getTimeZone(): string {
    return this.defaultTimeZone;
  }

  /**
   * Calculate the local-day spending period bounds in a defined timezone (default Asia/Kolkata)
   */
  public getLocalDayBounds(now: Date = new Date(), timeZone: string = this.defaultTimeZone): LocalDayBounds {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const partMap: Record<string, string> = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    const year = parseInt(partMap.year, 10);
    const month = parseInt(partMap.month, 10);
    const day = parseInt(partMap.day, 10);
    const localDateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const localMidnightUtcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const tzParts = formatter.formatToParts(localMidnightUtcGuess);
    const tzMap: Record<string, string> = {};
    for (const p of tzParts) tzMap[p.type] = p.value;

    const tzHours = parseInt(tzMap.hour, 10);
    const tzMinutes = parseInt(tzMap.minute, 10);
    const tzDay = parseInt(tzMap.day, 10);

    let diffMinutes = tzHours * 60 + tzMinutes;
    if (tzDay > day) diffMinutes += 24 * 60;
    else if (tzDay < day) diffMinutes -= 24 * 60;

    const startOfDay = new Date(localMidnightUtcGuess.getTime() - diffMinutes * 60 * 1000);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    return { startOfDay, endOfDay, timeZone, localDateString };
  }

  /**
   * Record a completed transaction in memory (for tests/fallback)
   */
  public recordCompletedTransaction(
    userId: string,
    amountCents: number,
    completedAt: Date = new Date(),
    transactionId?: string
  ): void {
    this.mockCompletedTransactions.push({ userId, amountCents, completedAt, transactionId });
  }

  /**
   * Read the user's configured daily spend limit from persistent storage (DB/authProvider)
   */
  public async getUserConfiguredLimit(userId: string, dbOverride?: any): Promise<number> {
    const db = dbOverride || getDb();
    if (db) {
      try {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
        const condition = isUuid ? eq(users.id, userId as any) : eq(users.clerkUserId, userId);
        const dbUser = await db.select({ limit: users.dailySpendLimitCents }).from(users).where(condition).limit(1);
        if (dbUser.length > 0 && dbUser[0].limit) {
          return dbUser[0].limit;
        }
      } catch {
        // Fall back to authProvider
      }
    }
    try {
      const authUser = authProvider.getUser(userId);
      if (authUser && authUser.dailySpendLimitCents) {
        return authUser.dailySpendLimitCents;
      }
    } catch {}
    return 500000; // default ₹5,000.00
  }

  /**
   * Get active (unexpired) reservations total for a user from in-memory state
   */
  public getActiveReservationsTotal(userId: string, now: Date = new Date()): number {
    let total = 0;
    for (const [key, res] of this.activeReservations.entries()) {
      if (res.expiresAt <= now) {
        this.activeReservations.delete(key);
      } else if (res.userId === userId && res.status !== 'released' && res.status !== 'committed') {
        total += res.amountCents;
      }
    }
    return total;
  }

  /**
   * Get active unexpired reservations total for a user from database
   */
  public async getActiveReservationsTotalFromDb(
    userId: string,
    dbOverride?: any,
    now: Date = new Date()
  ): Promise<number> {
    const db = dbOverride || getDb();
    if (!db || (dbOverride && !('query' in dbOverride) && !('execute' in dbOverride))) {
      return this.getActiveReservationsTotal(userId, now);
    }

    try {
      const result = await db
        .select({ total: sum(budgetReservations.amountCents) })
        .from(budgetReservations)
        .where(
          and(
            eq(budgetReservations.userId, userId as any),
            eq(budgetReservations.status, 'active'),
            gte(budgetReservations.expiresAt, now)
          )
        );

      const dbTotal = result[0]?.total ? Number(result[0].total) : 0;
      const memTotal = this.getActiveReservationsTotal(userId, now);
      return Math.max(dbTotal, memTotal);
    } catch {
      return this.getActiveReservationsTotal(userId, now);
    }
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
      return this.calculateRolling24hSpend(userId, now);
    }

    try {
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const result = await db
        .select({ total: sum(transactions.amountCents) })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId as any),
            eq(transactions.status, 'completed'),
            gte(transactions.completedAt, twentyFourHoursAgo)
          )
        );

      const total = result[0]?.total ? Number(result[0].total) : 0;
      return total;
    } catch {
      return this.calculateRolling24hSpend(userId, now);
    }
  }

  /**
   * Calculate total verified spend in user's local day (in-memory)
   */
  public calculateLocalDaySpend(
    userId: string,
    now: Date = new Date(),
    timeZone: string = this.defaultTimeZone
  ): number {
    const { startOfDay, endOfDay } = this.getLocalDayBounds(now, timeZone);
    return this.mockCompletedTransactions
      .filter((tx) => tx.userId === userId && tx.completedAt >= startOfDay && tx.completedAt <= endOfDay)
      .reduce((sum, tx) => sum + tx.amountCents, 0);
  }

  /**
   * Calculate total verified spend in user's local day from PostgreSQL database
   */
  public async calculateLocalDaySpendFromDb(
    userId: string,
    now: Date = new Date(),
    timeZone: string = this.defaultTimeZone,
    dbOverride?: any
  ): Promise<number> {
    const db = dbOverride || getDb();
    if (!db) {
      return this.calculateLocalDaySpend(userId, now, timeZone);
    }

    try {
      const { startOfDay, endOfDay } = this.getLocalDayBounds(now, timeZone);
      const result = await db
        .select({ total: sum(transactions.amountCents) })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId as any),
            eq(transactions.status, 'completed'),
            gte(transactions.completedAt, startOfDay),
            lte(transactions.completedAt, endOfDay)
          )
        );

      const total = result[0]?.total ? Number(result[0].total) : 0;
      return total;
    } catch {
      return this.calculateLocalDaySpend(userId, now, timeZone);
    }
  }

  /**
   * Get user spend profile (includes committed spend + active reservations)
   */
  public getUserSpendProfile(
    userId: string,
    dailySpendLimitCents: number = 500000,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h' }
  ): UserSpendProfile {
    const now = options?.now || new Date();
    const tz = options?.timeZone || this.defaultTimeZone;
    const period = options?.period || this.mode;

    const bounds = this.getLocalDayBounds(now, tz);
    const rollingSpent = this.calculateRolling24hSpend(userId, now);
    const localDaySpent = this.calculateLocalDaySpend(userId, now, tz);
    const spentCents = options?.period === 'local_day'
      ? localDaySpent
      : options?.period === 'rolling_24h'
      ? rollingSpent
      : Math.max(rollingSpent, localDaySpent);

    const activeReserved = this.getActiveReservationsTotal(userId, now);
    const totalCommitted = spentCents + activeReserved;
    const remainingDailySpendCents = Math.max(0, dailySpendLimitCents - totalCommitted);

    return {
      userId,
      dailySpendLimitCents,
      rolling24hSpentCents: totalCommitted,
      remainingDailySpendCents,
      currency: 'INR',
      timeZone: tz,
      periodStart: bounds.startOfDay,
      periodEnd: bounds.endOfDay,
      activeReservedCents: activeReserved,
    };
  }

  /**
   * Async variant retrieving spend profile directly using database query
   */
  public async getUserSpendProfileAsync(
    userId: string,
    dailySpendLimitCents: number = 500000,
    dbOverride?: any,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h' }
  ): Promise<UserSpendProfile> {
    const now = options?.now || new Date();
    const tz = options?.timeZone || this.defaultTimeZone;

    const bounds = this.getLocalDayBounds(now, tz);
    const [localDaySpent, rollingSpent] = await Promise.all([
      this.calculateLocalDaySpendFromDb(userId, now, tz, dbOverride),
      this.calculateRolling24hSpendFromDb(userId, dbOverride, now),
    ]);
    const spentCents = options?.period === 'local_day'
      ? localDaySpent
      : options?.period === 'rolling_24h'
      ? rollingSpent
      : Math.max(rollingSpent, localDaySpent);

    const activeReserved = await this.getActiveReservationsTotalFromDb(userId, dbOverride, now);
    const totalCommitted = spentCents + activeReserved;
    const remainingDailySpendCents = Math.max(0, dailySpendLimitCents - totalCommitted);

    return {
      userId,
      dailySpendLimitCents,
      rolling24hSpentCents: totalCommitted,
      remainingDailySpendCents,
      currency: 'INR',
      timeZone: tz,
      periodStart: bounds.startOfDay,
      periodEnd: bounds.endOfDay,
      activeReservedCents: activeReserved,
    };
  }

  /**
   * Atomically reserve spend budget for a pending checkout (Synchronous / In-Memory)
   */
  public reserveSpend(
    userId: string,
    amountCents: number,
    mandateId: string,
    dailySpendLimitCents: number = 500000,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h' }
  ): SpendValidationResult & { reservationId?: string } {
    const now = options?.now || new Date();
    const tz = options?.timeZone || this.defaultTimeZone;
    const period = options?.period || this.mode;

    const spent =
      period === 'local_day'
        ? this.calculateLocalDaySpend(userId, now, tz)
        : this.calculateRolling24hSpend(userId, now);

    const activeReserved = this.getActiveReservationsTotal(userId, now);
    const totalCommitted = spent + activeReserved;
    const remaining = Math.max(0, dailySpendLimitCents - totalCommitted);

    if (amountCents > remaining) {
      const attemptedInr = (amountCents / 100).toFixed(2);
      const remainingInr = (remaining / 100).toFixed(2);
      return {
        allowed: false,
        attemptedCents: amountCents,
        remainingDailyCents: remaining,
        reason: `Purchase amount of ₹${attemptedInr} exceeds your remaining daily spend allowance of ₹${remainingInr} (including active reservations).`,
      };
    }

    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const reservation: ActiveSpendReservation = {
      reservationId,
      userId,
      mandateId,
      amountCents,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000), // 10 minute window matching AP2 mandate TTL
      status: 'active',
    };
    this.activeReservations.set(mandateId, reservation);

    return {
      allowed: true,
      attemptedCents: amountCents,
      remainingDailyCents: remaining - amountCents,
      reservationId,
    };
  }

  /**
   * Authoritative async atomic budget reservation persisted to database
   */
  public async reserveSpendAsync(
    userId: string,
    amountCents: number,
    mandateId: string,
    dailySpendLimitCents?: number,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h'; dbOverride?: any }
  ): Promise<SpendValidationResult & { reservationId?: string }> {
    const db = options?.dbOverride || getDb();

    if (process.env.NODE_ENV === 'production' && !db) {
      throw new BudgetVerificationError(
        'Production database unconfigured: Authoritative budget cannot be verified. Checkout aborted (fail-closed).'
      );
    }

    const now = options?.now || new Date();
    const tz = options?.timeZone || this.defaultTimeZone;
    const period = options?.period || this.mode;

    const effectiveLimit =
      dailySpendLimitCents !== undefined
        ? dailySpendLimitCents
        : await this.getUserConfiguredLimit(userId, db);

    const spent =
      period === 'local_day'
        ? await this.calculateLocalDaySpendFromDb(userId, now, tz, db)
        : await this.calculateRolling24hSpendFromDb(userId, db, now);

    const activeReserved = await this.getActiveReservationsTotalFromDb(userId, db, now);
    const totalCommitted = spent + activeReserved;
    const remaining = Math.max(0, effectiveLimit - totalCommitted);

    if (amountCents > remaining) {
      const attemptedInr = (amountCents / 100).toFixed(2);
      const remainingInr = (remaining / 100).toFixed(2);
      return {
        allowed: false,
        attemptedCents: amountCents,
        remainingDailyCents: remaining,
        reason: `Purchase amount of ₹${attemptedInr} exceeds your remaining daily spend allowance of ₹${remainingInr} (including active reservations).`,
      };
    }

    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    // In-memory atomic update
    this.activeReservations.set(mandateId, {
      reservationId,
      userId,
      mandateId,
      amountCents,
      createdAt: now,
      expiresAt,
      status: 'active',
    });

    // Persistent DB record if UUID user & DB configured
    if (db) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
      if (isUuid) {
        try {
          await db.insert(budgetReservations).values({
            reservationId,
            userId: userId as any,
            mandateId,
            amountCents,
            currency: 'INR',
            status: 'active',
            expiresAt,
            createdAt: now,
          });
        } catch (dbErr: any) {
          if (process.env.NODE_ENV === 'production') {
            this.activeReservations.delete(mandateId);
            throw new BudgetVerificationError(
              `Failed to persist budget reservation: ${dbErr.message}. Failing closed.`
            );
          }
        }
      }
    }

    return {
      allowed: true,
      attemptedCents: amountCents,
      remainingDailyCents: remaining - amountCents,
      reservationId,
    };
  }

  /**
   * Commit reservation to permanent spend on checkout success (Synchronous / In-Memory)
   */
  public commitReservation(mandateId: string, userId: string, amountCents: number): void {
    const res = this.activeReservations.get(mandateId);
    if (res) {
      res.status = 'committed';
    }
    this.activeReservations.delete(mandateId);
    this.recordCompletedTransaction(userId, amountCents);
  }

  /**
   * Authoritative async reservation commit to database on verified payment outcome
   */
  public async commitReservationAsync(
    mandateId: string,
    userId: string,
    amountCents: number,
    txMetadata?: {
      sessionId?: string;
      merchantId?: string;
      merchantOrderId?: string;
      pravaTokenRef?: string;
      idempotencyKey?: string;
      receiptSummary?: any;
    },
    dbOverride?: any
  ): Promise<void> {
    this.commitReservation(mandateId, userId, amountCents);

    const db = dbOverride || getDb();
    if (!db) return;

    const now = new Date();
    try {
      await db
        .update(budgetReservations)
        .set({
          status: 'committed',
          committedAt: now,
          updatedAt: now,
        })
        .where(eq(budgetReservations.mandateId, mandateId));
    } catch (err: any) {
      console.warn('Note: DB reservation commit update:', err.message);
    }
  }

  /**
   * Release reservation on checkout failure, cancellation, or rejection
   */
  public releaseReservation(mandateId: string, reason: string = 'cancelled'): void {
    const res = this.activeReservations.get(mandateId);
    if (res) {
      res.status = 'released';
    }
    this.activeReservations.delete(mandateId);
  }

  /**
   * Authoritative async reservation release in database
   */
  public async releaseReservationAsync(
    mandateId: string,
    reason: string = 'cancelled',
    dbOverride?: any
  ): Promise<void> {
    this.releaseReservation(mandateId, reason);

    const db = dbOverride || getDb();
    if (!db) return;

    const now = new Date();
    try {
      await db
        .update(budgetReservations)
        .set({
          status: 'released',
          releasedAt: now,
          releaseReason: reason,
          updatedAt: now,
        })
        .where(eq(budgetReservations.mandateId, mandateId));
    } catch (err: any) {
      console.warn('Note: DB reservation release update:', err.message);
    }
  }

  /**
   * Reconcile an ambiguous reservation based on actual merchant/payment provider state
   */
  public async reconcileReservation(
    mandateId: string,
    userId: string,
    amountCents: number,
    confirmedStatus: 'confirmed' | 'failed' | 'cancelled' | 'refunded',
    reason?: string,
    dbOverride?: any
  ): Promise<void> {
    if (confirmedStatus === 'confirmed') {
      await this.commitReservationAsync(mandateId, userId, amountCents, undefined, dbOverride);
    } else {
      await this.releaseReservationAsync(mandateId, reason || confirmedStatus, dbOverride);
    }
  }

  /**
   * Validate whether an attempted purchase is within limits
   */
  public validateSpendLimit(
    userId: string,
    purchaseAmountCents: number,
    dailySpendLimitCents: number = 500000,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h' }
  ): SpendValidationResult {
    const profile = this.getUserSpendProfile(userId, dailySpendLimitCents, options);

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
    dbOverride?: any,
    options?: { timeZone?: string; now?: Date; period?: 'local_day' | 'rolling_24h' }
  ): Promise<SpendValidationResult> {
    const profile = await this.getUserSpendProfileAsync(userId, dailySpendLimitCents, dbOverride, options);

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
    this.activeReservations.clear();
  }
}

export const spendTracker = new SpendTracker();
export const authoritativeBudgetService = spendTracker;
export const budgetService = spendTracker;
