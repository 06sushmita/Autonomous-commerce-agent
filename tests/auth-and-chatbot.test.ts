import { describe, it, expect, beforeEach } from 'vitest';
import { authProvider, SUSHMITA_USER, ARJUN_USER } from '../src/auth/index.js';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import { autonomousCommerceRunner } from '../src/agent/runner.js';
import { SwiggyMcpClient } from '../src/mcp/swiggy-mcp.js';
import { ZeptoMcpClient } from '../src/mcp/zepto-mcp.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';

describe('User Authentication & Conversational Shopping Agent Suite', () => {
  beforeEach(async () => {
    authProvider.reset();
    authProvider.seedUser({ ...SUSHMITA_USER });

    const swiggyTransport = createTestSwiggyTransport();
    await swiggyTransport.initialize();
    const zeptoTransport = createTestZeptoTransport();
    await zeptoTransport.initialize();

    quickCommerceMcpManager.setClients(
      new SwiggyMcpClient(swiggyTransport),
      new ZeptoMcpClient(zeptoTransport)
    );
  });

  describe('1. User Registration & Sign Up', () => {
    it('registers a new user with custom delivery address, pincode, and spend limit', () => {
      const newUser = authProvider.registerUser({
        displayName: 'Priya Patel',
        email: 'priya.patel@example.com',
        phone: '9876543211',
        address: 'Flat 204, Galaxy Heights, Powai, Mumbai',
        pincode: '400076',
        dailySpendLimitINR: 4000,
      });

      expect(newUser.id).toBeDefined();
      expect(newUser.displayName).toBe('Priya Patel');
      expect(newUser.defaultAddress).toContain('Galaxy Heights');
      expect(newUser.defaultPincode).toBe('400076');
      expect(newUser.dailySpendLimitCents).toBe(400000); // ₹4,000 in paise
    });

    it('rejects registration with duplicate email address', () => {
      authProvider.registerUser({
        displayName: 'Ravi Verma',
        email: 'ravi@example.com',
        address: '10th Main, Indiranagar',
        pincode: '560038',
      });

      expect(() => {
        authProvider.registerUser({
          displayName: 'Ravi V',
          email: 'ravi@example.com',
          address: 'Another address',
          pincode: '560038',
        });
      }).toThrow(/already exists/);
    });
  });

  describe('2. User Login & Active User Context', () => {
    it('authenticates user by email and sets active user', () => {
      authProvider.registerUser({
        displayName: 'Karan Mehra',
        email: 'karan@example.com',
        password: 'secretPassword123',
        address: 'Sector 15, Noida',
        pincode: '201301',
      });

      const loggedIn = authProvider.loginUser('karan@example.com', 'secretPassword123');
      expect(loggedIn.displayName).toBe('Karan Mehra');
      expect(authProvider.getActiveUser().id).toBe(loggedIn.id);
    });

    it('authenticates user by phone number', () => {
      authProvider.seedUser({ ...SUSHMITA_USER });
      const loggedIn = authProvider.loginUser('9820002845', 'password123');
      expect(loggedIn.displayName).toBe('Sushmita Mishra');
      expect(authProvider.getActiveUser().id).toBe(SUSHMITA_USER.id);
    });

    it('rejects login with wrong password', () => {
      expect(() => {
        authProvider.loginUser('sushmita.mishra@example.com', 'wrongpassword');
      }).toThrow(/Invalid credentials/);
    });
  });

  describe('3. Ordering on Behalf of Logged-in User', () => {
    it('scopes shopping turn and delivery address to the authenticated user', async () => {
      // 1. Set active user to Sushmita Mishra
      authProvider.seedUser({ ...SUSHMITA_USER });
      authProvider.setActiveUser(SUSHMITA_USER.id);
      const user = authProvider.getActiveUser();

      // 2. Initialize session for this user
      const session = await autonomousCommerceRunner.initializeSession(user.id);
      expect(session.user.displayName).toBe('Sushmita Mishra');
      expect(session.activeDeliveryLocation.address).toContain('Dombivli');
      expect(session.activeDeliveryLocation.pincode).toBe('421202');

      // 3. Process turn on behalf of user
      const turn = await autonomousCommerceRunner.processShoppingTurn(
        session.sessionId,
        'Find me 1L milk and brown bread in under 15 mins'
      );

      expect(turn.proposal).toBeDefined();
      expect(turn.passkeyRequired).toBe(true);
      expect(turn.deliveryLocation.pincode).toBe('421202');

      // 4. Execute checkout with passkey signature on behalf of user
      const checkoutResult = await autonomousCommerceRunner.authorizeAndExecuteCheckout(
        session.sessionId,
        turn.mandateBundle!.mandateId,
        {
          mandateId: turn.mandateBundle!.mandateId,
          challengeId: turn.mandateBundle!.challenge.challengeId,
          clientDataJSON: Buffer.from('fido2_client_data').toString('base64url'),
          authenticatorData: Buffer.from('fido2_auth_data').toString('base64url'),
          signature: 'prava_biometric_passkey_test_sig',
        }
      );

      expect(checkoutResult.success).toBe(true);
      expect(checkoutResult.pravaTokenRef).toBeDefined();
      expect(checkoutResult.order.orderId).toBeDefined();
    });
  });

  describe('4. Real-Time Chatbot & Multi-Merchant Product Search', () => {
    it('queries Swiggy and Zepto catalogs and returns live items', async () => {
      const loc = {
        address: SUSHMITA_USER.defaultAddress,
        pincode: SUSHMITA_USER.defaultPincode,
        latitude: SUSHMITA_USER.defaultLatitude,
        longitude: SUSHMITA_USER.defaultLongitude,
      };

      const results = await quickCommerceMcpManager.searchAllMerchants('milk', loc);
      expect(results.swiggyItems.length).toBeGreaterThan(0);
      expect(results.zeptoItems.length).toBeGreaterThan(0);
      expect(results.swiggyItems[0].platform).toBe('swiggy_instamart');
      expect(results.zeptoItems[0].platform).toBe('zepto');
    });
  });
});
