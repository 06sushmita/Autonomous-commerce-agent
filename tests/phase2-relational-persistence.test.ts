import { describe, it, expect, beforeEach } from 'vitest';
import {
  users,
  agentSessions,
  intents,
  candidateOptions,
  mandates,
  transactions,
  auditLog,
  productEmbeddings,
  mandateStatusEnum,
  transactionStatusEnum,
  sessionStatusEnum,
  spendTracker,
  authProvider,
  DEFAULT_MOCK_USER,
  isDatabaseConfigured,
  getDb,
} from '../src/index.js';
import { getTableColumns } from 'drizzle-orm';

describe('Phase 2: Relational Persistence Layer (Drizzle ORM & Auth)', () => {
  beforeEach(() => {
    spendTracker.clear();
    authProvider.reset();
  });

  describe('1. Relational Schema & Table Invariance', () => {
    it('defines all 8 required tables for quick commerce', () => {
      expect(users).toBeDefined();
      expect(agentSessions).toBeDefined();
      expect(intents).toBeDefined();
      expect(candidateOptions).toBeDefined();
      expect(mandates).toBeDefined();
      expect(transactions).toBeDefined();
      expect(auditLog).toBeDefined();
      expect(productEmbeddings).toBeDefined();
    });

    it('validates users table schema contains delivery location and spend limits', () => {
      const cols = getTableColumns(users);
      expect(cols.id).toBeDefined();
      expect(cols.clerkUserId).toBeDefined();
      expect(cols.email).toBeDefined();
      expect(cols.displayName).toBeDefined();
      expect(cols.defaultAddress).toBeDefined();
      expect(cols.defaultPincode).toBeDefined();
      expect(cols.defaultLatitude).toBeDefined();
      expect(cols.defaultLongitude).toBeDefined();
      expect(cols.pravaAccountId).toBeDefined();
      expect(cols.dailySpendLimitCents).toBeDefined();
    });

    it('validates agent_sessions table schema has active delivery location jsonb', () => {
      const cols = getTableColumns(agentSessions);
      expect(cols.id).toBeDefined();
      expect(cols.userId).toBeDefined();
      expect(cols.status).toBeDefined();
      expect(cols.deliveryLocation).toBeDefined();
      expect(cols.sessionMetadata).toBeDefined();
    });

    it('validates mandates table schema with mandate status enum and AP2 structures', () => {
      const cols = getTableColumns(mandates);
      expect(cols.mandateId).toBeDefined();
      expect(cols.amountCents).toBeDefined();
      expect(cols.status).toBeDefined();
      expect(cols.rawMandate).toBeDefined();
      expect(cols.signedMandate).toBeDefined();
      expect(cols.expiresAt).toBeDefined();
      expect(mandateStatusEnum.enumValues).toEqual([
        'pending',
        'approved',
        'expired',
        'consumed',
        'revoked',
      ]);
    });

    it('validates transactions table schema enforces mandateId for double-spend protection', () => {
      const cols = getTableColumns(transactions);
      expect(cols.id).toBeDefined();
      expect(cols.userId).toBeDefined();
      expect(cols.sessionId).toBeDefined();
      expect(cols.mandateId).toBeDefined();
      expect(cols.pravaTokenRef).toBeDefined();
      expect(cols.amountCents).toBeDefined();
      expect(cols.status).toBeDefined();
      expect(transactionStatusEnum.enumValues).toEqual([
        'pending',
        'completed',
        'failed',
        'refunded',
      ]);
    });

    it('validates product_embeddings table schema contains 768-dimension pgvector embedding', () => {
      const cols = getTableColumns(productEmbeddings);
      expect(cols.id).toBeDefined();
      expect(cols.merchantId).toBeDefined();
      expect(cols.itemId).toBeDefined();
      expect(cols.itemName).toBeDefined();
      expect(cols.embedding).toBeDefined();
      // Check column type is vector
      expect(cols.embedding.columnType).toBe('PgVector');
    });

    it('validates session status enum values', () => {
      expect(sessionStatusEnum.enumValues).toEqual(['active', 'completed', 'abandoned']);
    });
  });

  describe('2. Rolling 24-Hour Spend Calculation Helper', () => {
    const testUserId = 'user_spend_test_01';

    it('returns zero spend and full allowance when user has no prior transactions', () => {
      const profile = spendTracker.getUserSpendProfile(testUserId, 500000);
      expect(profile.rolling24hSpentCents).toBe(0);
      expect(profile.remainingDailySpendCents).toBe(500000);
      expect(profile.currency).toBe('INR');
    });

    it('accurately aggregates transactions within rolling 24-hour window', () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

      spendTracker.recordCompletedTransaction(testUserId, 150000, twoHoursAgo); // ₹1,500.00
      spendTracker.recordCompletedTransaction(testUserId, 120000, fiveHoursAgo); // ₹1,200.00

      const profile = spendTracker.getUserSpendProfile(testUserId, 500000);
      expect(profile.rolling24hSpentCents).toBe(270000); // ₹2,700.00
      expect(profile.remainingDailySpendCents).toBe(230000); // ₹2,300.00
    });

    it('excludes transactions older than 24 hours from rolling sum', () => {
      const now = new Date();
      const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

      spendTracker.recordCompletedTransaction(testUserId, 400000, twentyFiveHoursAgo); // ₹4,000.00 (expired)
      spendTracker.recordCompletedTransaction(testUserId, 50000, oneHourAgo); // ₹500.00 (active)

      const profile = spendTracker.getUserSpendProfile(testUserId, 500000);
      expect(profile.rolling24hSpentCents).toBe(50000); // only ₹500.00
      expect(profile.remainingDailySpendCents).toBe(450000);
    });

    it('isolates spend between different users', () => {
      const userA = 'user_A';
      const userB = 'user_B';

      spendTracker.recordCompletedTransaction(userA, 300000);
      spendTracker.recordCompletedTransaction(userB, 100000);

      expect(spendTracker.getUserSpendProfile(userA).rolling24hSpentCents).toBe(300000);
      expect(spendTracker.getUserSpendProfile(userB).rolling24hSpentCents).toBe(100000);
    });

    it('validates spend limit correctly for allowed and exceeding purchases', () => {
      spendTracker.recordCompletedTransaction(testUserId, 450000); // Spent ₹4,500.00, remaining ₹500.00 (50,000 paise)

      const allowedCheck = spendTracker.validateSpendLimit(testUserId, 40000, 500000); // ₹400.00
      expect(allowedCheck.allowed).toBe(true);
      expect(allowedCheck.remainingDailyCents).toBe(50000);

      const rejectedCheck = spendTracker.validateSpendLimit(testUserId, 60000, 500000); // ₹600.00
      expect(rejectedCheck.allowed).toBe(false);
      expect(rejectedCheck.reason).toContain('exceeds your remaining daily spend allowance');
    });

    it('supports async spend profile query with DB fallback when DB is offline', async () => {
      const originalUrl = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@ep-sample-123456.neon.tech/neondb';
        spendTracker.recordCompletedTransaction(testUserId, 200000);

        const profile = await spendTracker.getUserSpendProfileAsync(testUserId, 500000);
        expect(profile.rolling24hSpentCents).toBe(200000);
        expect(profile.remainingDailySpendCents).toBe(300000);
      } finally {
        if (originalUrl !== undefined) {
          process.env.DATABASE_URL = originalUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it('queries provided mock DB client when querying async rolling spend', async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: async () => [{ total: '350000' }],
          }),
        }),
      };

      const total = await spendTracker.calculateRolling24hSpendFromDb(testUserId, mockDb);
      expect(total).toBe(350000);

      const asyncProfile = await spendTracker.getUserSpendProfileAsync(testUserId, 500000, mockDb);
      expect(asyncProfile.rolling24hSpentCents).toBe(350000);
      expect(asyncProfile.remainingDailySpendCents).toBe(150000);
    });
  });

  describe('3. Unified Auth & Mock User Provisioning', () => {
    it('detects mock mode when Clerk credentials are not set or are placeholder', () => {
      const originalKey = process.env.CLERK_SECRET_KEY;
      try {
        process.env.CLERK_SECRET_KEY = 'sk_test_placeholder_key';
        expect(authProvider.isMockMode()).toBe(true);
        delete process.env.CLERK_SECRET_KEY;
        expect(authProvider.isMockMode()).toBe(true);
      } finally {
        if (originalKey !== undefined) {
          process.env.CLERK_SECRET_KEY = originalKey;
        } else {
          delete process.env.CLERK_SECRET_KEY;
        }
      }
    });

    it('provisions deterministic default mock user with Bengaluru delivery coordinates', async () => {
      const user = await authProvider.getAuthenticatedUser();
      expect(user.id).toBe(DEFAULT_MOCK_USER.id);
      expect(user.displayName).toBe('Arjun Sharma');
      expect(user.defaultAddress).toContain('Bellandur, Bengaluru');
      expect(user.defaultPincode).toBe('560103');
      expect(user.defaultLatitude).toBe(12.9298);
      expect(user.defaultLongitude).toBe(77.6835);
      expect(user.dailySpendLimitCents).toBe(500000); // ₹5,000.00
    });

    it('updates delivery location for mock user', async () => {
      const updated = authProvider.updateUserDeliveryLocation(
        DEFAULT_MOCK_USER.id,
        'Flat 101, Indiranagar 100ft Road',
        '560038',
        12.9784,
        77.6408
      );
      expect(updated.defaultAddress).toBe('Flat 101, Indiranagar 100ft Road');
      expect(updated.defaultPincode).toBe('560038');
      expect(updated.defaultLatitude).toBe(12.9784);
      expect(updated.defaultLongitude).toBe(77.6408);

      const fetched = await authProvider.getAuthenticatedUser(DEFAULT_MOCK_USER.id);
      expect(fetched.defaultAddress).toBe('Flat 101, Indiranagar 100ft Road');
    });

    it('updates daily spend limit for mock user', async () => {
      const updated = authProvider.updateUserDailySpendLimit(DEFAULT_MOCK_USER.id, 1000000); // ₹10,000.00
      expect(updated.dailySpendLimitCents).toBe(1000000);

      const fetched = await authProvider.getAuthenticatedUser(DEFAULT_MOCK_USER.id);
      expect(fetched.dailySpendLimitCents).toBe(1000000);
    });

    it('allows seeding custom users into the provider registry', async () => {
      authProvider.seedUser({
        id: 'user_mumbai_01',
        clerkUserId: 'clerk_mumbai_01',
        email: 'priya@example.com',
        displayName: 'Priya Mehta',
        defaultAddress: 'Bandra West, Mumbai',
        defaultPincode: '400050',
        dailySpendLimitCents: 800000,
      });

      const user = await authProvider.getAuthenticatedUser('user_mumbai_01');
      expect(user.displayName).toBe('Priya Mehta');
      expect(user.defaultAddress).toBe('Bandra West, Mumbai');
      expect(user.defaultPincode).toBe('400050');
      expect(user.dailySpendLimitCents).toBe(800000);
    });

    it('lists all registered users and resets to default mock user', () => {
      authProvider.seedUser({
        id: 'user_temp',
        clerkUserId: 'clerk_temp',
        email: 'temp@example.com',
        displayName: 'Temp User',
        defaultAddress: 'Delhi',
        defaultPincode: '110001',
        dailySpendLimitCents: 500000,
      });

      expect(authProvider.listUsers().length).toBeGreaterThanOrEqual(2);

      authProvider.reset();
      expect(authProvider.listUsers().length).toBe(1);
      expect(authProvider.listUsers()[0].id).toBe(DEFAULT_MOCK_USER.id);
    });
  });

  describe('4. Neon Database Client & Configuration Handling', () => {
    it('safely recognizes placeholder DATABASE_URL as unconfigured', () => {
      const originalUrl = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@ep-sample-123456.neon.tech/neondb';
        expect(isDatabaseConfigured()).toBe(false);
      } finally {
        if (originalUrl !== undefined) {
          process.env.DATABASE_URL = originalUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it('returns null db instance gracefully without throwing when unconfigured', () => {
      const originalUrl = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@ep-sample-123456.neon.tech/neondb';
        const db = getDb();
        expect(db).toBeNull();
      } finally {
        if (originalUrl !== undefined) {
          process.env.DATABASE_URL = originalUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });
  });
});
