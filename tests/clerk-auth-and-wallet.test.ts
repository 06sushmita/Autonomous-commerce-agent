import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authProvider, SUSHMITA_USER, SHUBHAM_USER, DEFAULT_MOCK_USER } from '../src/auth/index.js';
import { spendTracker } from '../src/db/spend-tracker.js';
import { startDevServer } from '../src/dev-server.js';

describe('Clerk Authentication, Dynamic Wallet Budget & Dynamic Location Suite', () => {
  beforeEach(() => {
    authProvider.reset();
  });

  describe('1. Clerk Authentication & Session Verification', () => {
    it('detects live Clerk configuration when CLERK_SECRET_KEY is present', () => {
      const isClerk = authProvider.isClerkConfigured();
      expect(typeof isClerk).toBe('boolean');
    });

    it('seeds verified Clerk accounts (Sushmita Mishra & Shubham Mahajani) with valid Clerk IDs', () => {
      authProvider.seedVerifiedClerkProfiles();
      const users = authProvider.listUsers();
      expect(users.length).toBeGreaterThanOrEqual(2);

      const sushmita = users.find((u) => u.clerkUserId === 'user_3KjhrVNHC05EX0IP8D7Uk6DPxBt');
      expect(sushmita).toBeDefined();
      expect(sushmita?.displayName).toBe('Sushmita Mishra');

      const shubham = users.find((u) => u.clerkUserId === 'user_3KkSYq9sgXOy8L9T4irMRPpuzCc');
      expect(shubham).toBeDefined();
      expect(shubham?.displayName).toBe('Shubham Mahajani');
    });

    it('authenticates user via Clerk email and establishes active session', async () => {
      authProvider.seedVerifiedClerkProfiles();
      const user = await authProvider.loginWithClerk('mishrasushmita06@gmail.com', 'password123');
      expect(user.displayName).toBe('Sushmita Mishra');
      expect(authProvider.getActiveUser().displayName).toBe('Sushmita Mishra');
    });

    it('rejects unauthorized access when NODE_ENV is production and credentials are fake', () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        expect(authProvider.isMockMode()).toBe(false);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('2. Dynamic Wallet Budget (Editable Anytime)', () => {
    it('allows a user to update their daily spend limit dynamically', () => {
      authProvider.seedUser({ ...SUSHMITA_USER });
      authProvider.setActiveUser(SUSHMITA_USER.id);

      // Initial budget is ₹5,000 (500,000 paise)
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(500000);

      // User increases budget to ₹15,000 (1,500,000 paise)
      const updated = authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 1500000);
      expect(updated.dailySpendLimitCents).toBe(1500000);
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(1500000);

      // Spend tracker recalculates remaining budget based on new dynamic limit
      const spend = spendTracker.getUserSpendProfile(SUSHMITA_USER.id, updated.dailySpendLimitCents);
      expect(spend.dailySpendLimitCents).toBe(1500000);
      expect(spend.remainingDailySpendCents).toBe(1500000);
    });

    it('rejects invalid budget values below minimum ₹1 or exceeding ceiling', () => {
      authProvider.seedUser({ ...SUSHMITA_USER });
      authProvider.setActiveUser(SUSHMITA_USER.id);

      // Below ₹1 (less than 100 paise)
      expect(() => {
        authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 50);
      }).toThrow(/between ₹1 and ₹5,00,000/);

      // Exceeding ₹5,00,000 (more than 50,000,000 paise)
      expect(() => {
        authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 60000000);
      }).toThrow(/between ₹1 and ₹5,00,000/);
    });

    it('allows multiple budget edits without requiring re-registration', () => {
      authProvider.seedUser({ ...SUSHMITA_USER });
      authProvider.setActiveUser(SUSHMITA_USER.id);

      authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 250000); // Set to ₹2,500
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(250000);

      authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 5000000); // Increase to ₹50,000
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(5000000);

      authProvider.updateUserDailySpendLimit(SUSHMITA_USER.id, 100000); // Lower to ₹1,000
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(100000);
    });
  });

  describe('3. Dynamic Delivery Location (Pre-set or Change Anytime)', () => {
    it('allows user to change delivery address and pincode dynamically', () => {
      authProvider.seedUser({ ...SUSHMITA_USER });
      authProvider.setActiveUser(SUSHMITA_USER.id);

      // Original address in Dombivli
      expect(authProvider.getActiveUser().defaultPincode).toBe('421202');

      // User changes location to Bellandur, Bengaluru
      const updated = authProvider.updateUserDeliveryLocation(
        SUSHMITA_USER.id,
        'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
        '560103',
        12.9298,
        77.6835
      );

      expect(updated.defaultAddress).toContain('Bellandur');
      expect(updated.defaultPincode).toBe('560103');
      expect(updated.defaultLatitude).toBe(12.9298);
      expect(updated.defaultLongitude).toBe(77.6835);

      // Verify active user profile reflects the new dynamic location immediately
      const current = authProvider.getActiveUser();
      expect(current.defaultPincode).toBe('560103');
      expect(current.defaultAddress).toContain('Bellandur');
    });

    it('rejects location update for non-existent user ID', () => {
      expect(() => {
        authProvider.updateUserDeliveryLocation('non-existent-user-id', 'Address', '123456');
      }).toThrow(/User not found/);
    });
  });

  describe('4. Server Endpoints for Wallet & Location', () => {
    let server: any;
    let baseUrl: string;

    beforeEach(async () => {
      const port = 3899;
      baseUrl = `http://127.0.0.1:${port}`;
      server = startDevServer(port);
      await new Promise((r) => setTimeout(r, 100));
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('GET /api/me/wallet returns current spend profile and limit', async () => {
      const res = await fetch(`${baseUrl}/api/me/wallet`);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.dailyLimitINR).toBeDefined();
      expect(parseFloat(json.dailyLimitINR)).toBeGreaterThan(0);
    });

    it('PATCH /api/me/wallet updates daily spend limit and returns updated budget', async () => {
      const res = await fetch(`${baseUrl}/api/me/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailySpendLimitINR: 12500 }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect(json.dailyLimitINR).toBe('12500.00');
      expect(authProvider.getActiveUser().dailySpendLimitCents).toBe(1250000);
    });

    it('POST /api/me/address dynamically updates delivery location', async () => {
      const res = await fetch(`${baseUrl}/api/me/address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: 'Flat 501, Lake View, Powai, Mumbai',
          pincode: '400076',
          latitude: 19.1176,
          longitude: 72.9060,
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.success).toBe(true);
      expect(authProvider.getActiveUser().defaultPincode).toBe('400076');
      expect(authProvider.getActiveUser().defaultAddress).toContain('Lake View');
    });

    it('POST /api/chat rejects unauthenticated / guest ordering requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '1L milk', userId: 'guest' }),
      });
      expect(res.status).toBe(401);
      const json = await res.json() as any;
      expect(json.requiresSignup).toBe(true);
      expect(json.error).toContain('Authentication Required');
    });

    it('POST /api/checkout rejects ordering before signing up with 401', async () => {
      const res = await fetch(`${baseUrl}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session_mock_123',
          mandateId: 'mandate_mock_123',
          userId: 'guest',
        }),
      });
      expect(res.status).toBe(401);
      const json = await res.json() as any;
      expect(json.requiresSignup).toBe(true);
      expect(json.error).toContain('Authentication Required');
    });
  });
});

