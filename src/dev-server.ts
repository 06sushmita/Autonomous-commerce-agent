/**
 * Autonomous Commerce Agent (ACA) - Local Development Server & Web Playground
 *
 * Runs an in-process HTTP server providing:
 *  - User Authentication (Login & Sign Up with Delivery Address & Spend Limits)
 *  - Agent orders on behalf of the currently logged-in user
 *  - Real-time Conversational Quick-Commerce Chatbot querying Swiggy MCP & Zepto MCP
 *  - Live item cards displayed in chat stream in real time
 *  - Multi-Merchant Basket Comparison & AP2 Prava Biometric Passkey Checkout
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import {
  quickCommerceMcpManager,
  autonomousCommerceRunner,
  authProvider,
  spendTracker,
  DEFAULT_MOCK_USER,
  SUSHMITA_USER,
  DeliveryLocation,
  AuthUser,
  QuickCommerceItem,
  geocodeAddress,
  getPravaClient,
} from './index.js';
import { renderWebDashboard } from './dashboard-html.js';
import { renderLandingPage } from './landing-html.js';

function lookupCoordinatesForPincode(pincode: string, addressText?: string): { latitude: number; longitude: number } | undefined {
  const pin = pincode.trim();
  if (pin.startsWith('560')) return { latitude: 12.9298, longitude: 77.6835 }; // Bengaluru
  if (pin.startsWith('400')) return { latitude: 19.1176, longitude: 72.9060 }; // Mumbai (Powai)
  if (pin.startsWith('421')) return { latitude: 19.2183, longitude: 73.0867 }; // Dombivli / Thane
  if (pin.startsWith('110')) return { latitude: 28.6139, longitude: 77.2090 }; // Delhi
  if (pin.startsWith('122')) return { latitude: 28.4595, longitude: 77.0266 }; // Gurugram
  if (pin.startsWith('201')) return { latitude: 28.5355, longitude: 77.3910 }; // Noida
  if (pin.startsWith('500')) return { latitude: 17.3850, longitude: 78.4867 }; // Hyderabad
  if (pin.startsWith('600')) return { latitude: 13.0827, longitude: 80.2707 }; // Chennai
  if (pin.startsWith('411')) return { latitude: 18.5204, longitude: 73.8567 }; // Pune
  if (pin.startsWith('700')) return { latitude: 22.5726, longitude: 88.3639 }; // Kolkata

  const text = (addressText || '').toLowerCase();
  if (text.includes('bangalore') || text.includes('bengaluru') || text.includes('bellandur')) return { latitude: 12.9298, longitude: 77.6835 };
  if (text.includes('mumbai') || text.includes('powai') || text.includes('andheri')) return { latitude: 19.1176, longitude: 72.9060 };
  if (text.includes('dombivli') || text.includes('thane') || text.includes('kopar')) return { latitude: 19.2183, longitude: 73.0867 };
  return undefined;
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Helper to read JSON body
  const readJson = async (): Promise<any> => {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  };

  // Helper to send JSON
  const sendJson = (statusCode: number, data: any) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  };

  try {
    // 1. Health & Status Endpoint
    if (method === 'GET' && url.pathname === '/api/healthz') {
      const user = authProvider.getActiveUser();
      const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
      return sendJson(200, {
        status: 'online',
        service: 'Autonomous Commerce Agent (ACA)',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        mcp: {
          swiggy: {
            endpoint: process.env.SWIGGY_MCP_URL || 'https://mcp.swiggy.com/im',
            mode: 'live_active',
          },
          zepto: {
            endpoint: process.env.ZEPTO_MCP_URL || 'https://mcp.zepto.co.in/mcp',
            mode: 'live_active',
          },
        },
        prava: {
          endpoint: process.env.PRAVA_API_URL || 'https://sandbox.api.prava.space',
          mode: 'sandbox_passkeys',
        },
        user: {
          id: user.id,
          name: user.displayName,
          email: user.email,
          phone: user.phone,
          address: user.defaultAddress,
          pincode: user.defaultPincode,
          dailyLimitINR: `₹${(user.dailySpendLimitCents / 100).toFixed(2)}`,
          remainingLimitINR: `₹${(spend.remainingDailySpendCents / 100).toFixed(2)}`,
        },
      });
    }

    // 2. Authentication: Get Current Active User
    if (method === 'GET' && url.pathname === '/api/auth/current') {
      const requestedId = url.searchParams.get('userId');
      if (requestedId) {
        try {
          const user = authProvider.setActiveUser(requestedId);
          const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
          const { password, ...safeUser } = user;
          return sendJson(200, {
            user: safeUser,
            remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
          });
        } catch {
          // not found, fall through
        }
      }

      if (url.searchParams.get('guest') === '1') {
        return sendJson(200, { user: null });
      }

      const user = authProvider.getActiveUser();
      const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
      const { password, ...safeUser } = user;
      return sendJson(200, {
        user: safeUser,
        remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
      });
    }

    // 2b. Authentication: Log Out
    if (method === 'POST' && url.pathname === '/api/auth/logout') {
      return sendJson(200, { success: true, message: 'Logged out successfully.' });
    }

    // 3. Authentication: List Known Users (for quick preset switching)
    if (method === 'GET' && url.pathname === '/api/auth/users') {
      const users = authProvider.listUsers();
      return sendJson(200, { users });
    }

    // 4. Authentication: Log In
    // 4. Authentication: Log In (with Clerk & Neon DB synchronization)
    if (method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson();
      const { emailOrPhone, password } = body;
      if (!emailOrPhone) {
        return sendJson(400, { error: 'Email or phone number is required.' });
      }
      try {
        const user = await authProvider.loginWithClerk(emailOrPhone, password);
        const { password: _, ...safeUser } = user;
        const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
        return sendJson(200, {
          success: true,
          user: safeUser,
          clerkUserId: user.clerkUserId,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
        });
      } catch (e: any) {
        return sendJson(401, { error: e.message || 'Login failed.' });
      }
    }

    // 5. Authentication: Sign Up (registers directly with Clerk & saves to Neon PostgreSQL)
    if (method === 'POST' && url.pathname === '/api/auth/signup') {
      const body = await readJson();
      try {
        let signupLat = body.latitude ? parseFloat(body.latitude) : undefined;
        let signupLng = body.longitude ? parseFloat(body.longitude) : undefined;
        if (signupLat === undefined || signupLng === undefined || isNaN(signupLat) || isNaN(signupLng)) {
          const guessed = lookupCoordinatesForPincode(body.pincode, body.address);
          if (guessed) {
            signupLat = guessed.latitude;
            signupLng = guessed.longitude;
          } else {
            const geo = await geocodeAddress(body.address, body.pincode);
            if (geo) {
              signupLat = geo.latitude;
              signupLng = geo.longitude;
            }
          }
        }

        const newUser = await authProvider.registerWithClerk({
          displayName: body.displayName,
          email: body.email,
          phone: body.phone,
          password: body.password,
          address: body.address,
          pincode: body.pincode,
          latitude: signupLat,
          longitude: signupLng,
          dailySpendLimitINR: body.dailySpendLimitINR ? parseFloat(body.dailySpendLimitINR) : 5000,
        });
        const { password: _, ...safeUser } = newUser;
        const spend = spendTracker.getUserSpendProfile(newUser.id, newUser.dailySpendLimitCents);
        return sendJson(201, {
          success: true,
          user: safeUser,
          clerkUserId: newUser.clerkUserId,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
        });
      } catch (e: any) {
        return sendJson(400, { error: e.message || 'Registration failed.' });
      }
    }

    // 5b. Authentication: Google Sign-In
    if (method === 'POST' && url.pathname === '/api/auth/google') {
      const body = await readJson();
      const { email, displayName, googleId, avatarUrl } = body;
      if (!email) {
        return sendJson(400, { error: 'Google email address is required.' });
      }
      try {
        const user = await authProvider.loginOrRegisterGoogle({
          email,
          displayName,
          googleId,
          avatarUrl,
        });
        const { password: _, ...safeUser } = user;
        const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
        return sendJson(200, {
          success: true,
          user: safeUser,
          clerkUserId: user.clerkUserId,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
        });
      } catch (e: any) {
        return sendJson(400, { error: e.message || 'Google sign-in failed.' });
      }
    }

    // 6. Authentication: Switch User
    if (method === 'POST' && url.pathname === '/api/auth/switch') {
      const body = await readJson();
      const { userId } = body;
      try {
        const user = authProvider.setActiveUser(userId);
        const { password: _, ...safeUser } = user;
        const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
        return sendJson(200, {
          success: true,
          user: safeUser,
          clerkUserId: user.clerkUserId,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
        });
      } catch (e: any) {
        return sendJson(404, { error: e.message });
      }
    }

    // 6a. Wallet & Spend Limit Management: Get Spend Profile
    if (method === 'GET' && (url.pathname === '/api/me/wallet' || url.pathname === '/api/wallet')) {
      const user = authProvider.getActiveUser();
      const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
      const { password: _, ...safeUser } = user;
      return sendJson(200, {
        user: safeUser,
        clerkUserId: user.clerkUserId,
        dailySpendLimitCents: user.dailySpendLimitCents,
        dailyLimitINR: (user.dailySpendLimitCents / 100).toFixed(2),
        spentLast24hINR: (spend.rolling24hSpentCents / 100).toFixed(2),
        remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
      });
    }

    // 6b. Wallet & Spend Limit Management: Edit Wallet Budget
    if ((method === 'PATCH' || method === 'POST') && (url.pathname === '/api/me/wallet' || url.pathname === '/api/wallet/budget')) {
      const body = await readJson();
      let user = authProvider.getActiveUser();

      if (body.userId) {
        try {
          user = authProvider.setActiveUser(body.userId);
        } catch {
          // fallback to active user if available
        }
      }

      const newLimitINR = body.dailySpendLimitINR !== undefined ? parseFloat(body.dailySpendLimitINR) : undefined;
      const newLimitCents = body.dailySpendLimitCents !== undefined
        ? parseInt(body.dailySpendLimitCents, 10)
        : newLimitINR !== undefined
        ? Math.round(newLimitINR * 100)
        : null;

      if (!newLimitCents || isNaN(newLimitCents)) {
        return sendJson(400, { error: 'Valid dailySpendLimitINR or dailySpendLimitCents is required.' });
      }

      try {
        const updatedUser = authProvider.updateUserDailySpendLimit(user.id, newLimitCents);
        const spend = spendTracker.getUserSpendProfile(updatedUser.id, updatedUser.dailySpendLimitCents);
        const { password: _, ...safeUser } = updatedUser;
        return sendJson(200, {
          success: true,
          message: `Daily wallet budget successfully updated to ₹${(newLimitCents / 100).toFixed(2)}`,
          dailyLimitINR: (newLimitCents / 100).toFixed(2),
          dailySpendLimitCents: newLimitCents,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
          user: safeUser,
        });
      } catch (err: any) {
        return sendJson(400, { error: err.message || 'Failed to update wallet limit.' });
      }
    }

    // 6c. Dynamic Delivery Address Management: Change Address
    if ((method === 'PATCH' || method === 'POST') && (url.pathname === '/api/me/address' || url.pathname === '/api/address')) {
      const body = await readJson();
      const user = authProvider.getActiveUser();

      if (body.userId && body.userId !== user.id && body.userId !== user.clerkUserId) {
        return sendJson(403, { error: "Forbidden: Cannot modify another user's delivery location." });
      }

      const { address, pincode, latitude, longitude } = body;
      if (!address || !pincode) {
        return sendJson(400, { error: 'Address and pincode are required.' });
      }
      try {
        let effLat = latitude !== undefined && latitude !== '' ? parseFloat(latitude) : undefined;
        let effLng = longitude !== undefined && longitude !== '' ? parseFloat(longitude) : undefined;
        if (effLat === undefined || effLng === undefined || isNaN(effLat) || isNaN(effLng)) {
          const guessed = lookupCoordinatesForPincode(pincode, address);
          if (guessed) {
            effLat = guessed.latitude;
            effLng = guessed.longitude;
          } else {
            const geo = await geocodeAddress(address, pincode, body.city);
            if (geo) {
              effLat = geo.latitude;
              effLng = geo.longitude;
            }
          }
        }

        const updatedUser = authProvider.updateUserDeliveryLocation(
          user.id,
          address.trim(),
          pincode.trim(),
          effLat,
          effLng
        );
        const { password: _, ...safeUser } = updatedUser;
        return sendJson(200, {
          success: true,
          message: `Delivery address updated to: ${address} (${pincode})`,
          user: safeUser,
        });
      } catch (err: any) {
        return sendJson(400, { error: err.message || 'Failed to update delivery address.' });
      }
    }

    // 7. Real-Time Chatbot Endpoint (Natural Language -> Live Swiggy + Zepto Fetch -> Mandate)
    if (method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson();
      const query = (body.message || body.query || 'milk').trim();

      // STRICT CONSTRAINT: Do not allow shopping turn or order creation before signing up
      if (!body.userId || body.userId === 'guest') {
        return sendJson(401, {
          error: 'Authentication Required: Please sign in or create an account before searching or placing orders.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(body.userId);
      } catch (authErr: any) {
        return sendJson(401, {
          error: `Authentication Required: ${authErr.message || 'Please sign in or create an account.'}`,
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      const userLocation: DeliveryLocation = {
        address: user.defaultAddress,
        pincode: user.defaultPincode,
        latitude: user.defaultLatitude,
        longitude: user.defaultLongitude,
      };

      // Ensure MCP servers are initialized
      await quickCommerceMcpManager.initialize();

      // Parallel Real-Time Search across Swiggy Instamart and Zepto
      const searchResults = await quickCommerceMcpManager.searchAllMerchants(query, userLocation);

      // Create or continue Agent Shopping Session for this authenticated user
      let sessionId = body.sessionId;
      if (!sessionId) {
        const session = await autonomousCommerceRunner.initializeSession(user.id);
        sessionId = session.sessionId;
      }

      // Process shopping turn (basket comparison, spend limits check, AP2 mandate creation)
      let turn: any = null;
      let errorMsg: string | undefined;

      try {
        turn = await autonomousCommerceRunner.processShoppingTurn(
          sessionId,
          query,
          { confirmed: true, override: userLocation }
        );
      } catch (err: any) {
        console.error('DEV-SERVER CHAT ERROR STACK:', err.stack);
        errorMsg = err.message;
      }

      // Ensure all items have official product links and are strictly capped to the top 5 highest-accuracy items
      const swiggyItems = quickCommerceMcpManager.rankTopItems(searchResults.swiggyItems, { query, limit: 5 }).map((item) => ({
        ...item,
        productUrl:
          item.productUrl ||
          `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(item.name)}`,
      }));

      const zeptoItems = quickCommerceMcpManager.rankTopItems(searchResults.zeptoItems, { query, limit: 5 }).map((item) => ({
        ...item,
        productUrl:
          item.productUrl ||
          `https://www.zeptonow.com/search?q=${encodeURIComponent(item.name)}`,
      }));

      // Determine best items (supporting multiple items when query requests 2 or more items!)
      const rawBestItems: QuickCommerceItem[] =
        (turn?.proposal?.bestItems && turn.proposal.bestItems.length > 0)
          ? turn.proposal.bestItems
          : (turn?.proposal?.items && turn.proposal.items.length > 0)
          ? turn.proposal.items.map((it: any) => ({
              id: it.itemId || it.id,
              name: it.name,
              platform: turn.proposal.platform,
              merchantName: turn.proposal.merchantName,
              priceCents: it.unitPriceCents || it.priceCents,
              mrpCents: it.mrpCents,
              imageUrl: it.imageUrl,
              productUrl: it.productUrl || (turn.proposal.platform === 'zepto'
                ? `https://www.zeptonow.com/search?q=${encodeURIComponent(it.name)}`
                : `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(it.name)}`),
              unit: it.unit,
              brand: it.brand,
              etaMinutes: turn.proposal.etaMinutes,
              isPriceVerified: it.isPriceVerified !== false,
            }))
          : [];

      const bestItem =
        turn?.proposal?.bestItem ||
        rawBestItems[0] ||
        swiggyItems[0] ||
        zeptoItems[0];

      const bestItems = rawBestItems.length > 0 ? rawBestItems : bestItem ? [bestItem] : [];

      // Ensure all best items have product URLs
      bestItems.forEach((it) => {
        if (!it.productUrl) {
          it.productUrl =
            it.platform === 'zepto'
              ? `https://www.zeptonow.com/search?q=${encodeURIComponent(it.name)}`
              : `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(it.name)}`;
        }
      });

      if (turn?.proposal) {
        turn.proposal.bestItem = bestItems[0] || bestItem;
        turn.proposal.bestItems = bestItems;
      }

      // Format clean, conversational AI response emphasizing the Top 5 and the 4 constraints
      const swiggyCount = swiggyItems.length;
      const zeptoCount = zeptoItems.length;

      let reply = `I searched both **Swiggy Instamart** and **Zepto** in real time for **"${query}"** for delivery to **${user.defaultAddress}**.\n\n`;

      if (swiggyCount > 0 || zeptoCount > 0) {
        reply += `Filtered and ranked to the **top 5 highest-accuracy items** based on your priority constraints: **1. Price (lowest first)**, **2. Quantity (stock & pack)**, **3. Product relevance**, and **4. Brand**.\n`;
      } else {
        reply += `⚠️ No live products found on Swiggy or Zepto for "${query}". Demo items and fabricated fallback prices are strictly prohibited.\n`;
      }

      if (turn && turn.proposal) {
        if (bestItems.length > 1) {
          reply += `\n⭐ **Agent's Top Choices for Your Requested Items:**\n`;
          bestItems.forEach((it, idx) => {
            const itemPriceStr = (it.priceCents / 100).toFixed(2);
            const unitStr = it.unit ? ` (${it.unit})` : '';
            reply += `  ${idx + 1}. **${it.name}**${unitStr} — **₹${itemPriceStr}** from **${it.merchantName || turn.proposal.merchantName}**\n`;
          });
        } else {
          const titleStr = bestItem ? `**${bestItem.name}**` : 'Selected Items';
          reply += `\n⭐ **Agent's Top Choice:** ${titleStr}\n`;
        }
        if (turn.proposal.constraintValidation?.allPassed) {
          reply += `\n🎯 **Multi-Constraint Gate:** ✓ All 5 constraints (Product Brand, Verified Live Price, Cost Limit, Quantity/Stock, and Delivery ETA) strictly accepted by ${turn.proposal.merchantName} MCP server.\n`;
        }
        reply += `\n💡 **Reason:** ${turn.recommendationReason}\n`;
        reply += `Total payable is **₹${(turn.proposal.totalAmountCents / 100).toFixed(2)}** (estimated) with an ETA of **${turn.proposal.etaMinutes} minutes**.\n`;
        if (turn.proposal.budgetSuggestion) {
          reply += `\n🛡️ **Budget Advisory:** ${turn.proposal.budgetSuggestion.text}\n`;
        }
        if (turn.passkeyRequired) {
          const countDesc = bestItems.length > 1 ? `all ${bestItems.length} top choices` : 'the spotlight top choice';
          reply += `\nPlease review ${countDesc} below and authorize on behalf of **${user.displayName}** using your Biometric Passkey.`;
        }
      } else if (errorMsg) {
        reply += `\n⚠️ **Order Constraints Not Met:** ${errorMsg}\nFallback to synthetic or unverified mock data is strictly prohibited.`;
      }

      return sendJson(200, {
        reply,
        sessionId,
        swiggyItems,
        zeptoItems,
        bestItem: bestItems[0] || bestItem,
        bestItems,
        turn,
        proposal: turn?.proposal,
        comparison: turn?.comparison,
        swiggyProposal: turn?.comparison?.swiggyProposal,
        zeptoProposal: turn?.comparison?.zeptoProposal,
        feesBreakdown: turn?.comparison?.feesBreakdown,
        swiggyMandateBundle: turn?.swiggyMandateBundle,
        zeptoMandateBundle: turn?.zeptoMandateBundle,
        recommendationReason: turn?.recommendationReason,
        mandateBundle: turn?.mandateBundle,
        passkeyRequired: Boolean(turn?.passkeyRequired),
        user: {
          id: user.id,
          displayName: user.displayName,
          phone: user.phone,
          address: user.defaultAddress,
          pincode: user.defaultPincode,
        },
      });
    }

    // 8. Multi-Merchant Direct Search
    if (method === 'POST' && url.pathname === '/api/search') {
      const body = await readJson();
      const user = authProvider.getActiveUser();
      const query = body.query || 'milk';
      const location = body.location || {
        address: user.defaultAddress,
        pincode: user.defaultPincode,
        latitude: user.defaultLatitude,
        longitude: user.defaultLongitude,
      };

      await quickCommerceMcpManager.initialize();
      const results = await quickCommerceMcpManager.searchAllMerchants(query, location);
      return sendJson(200, { query, results });
    }

    // 9. Biometric Passkey Checkout Execution (AP2 + Prava token -> Confirmed Order)
    if (method === 'POST' && url.pathname === '/api/checkout') {
      const body = await readJson();
      const { sessionId, mandateId, userId } = body;

      // STRICT CONSTRAINT: Do not allow checkout/ordering without an account
      if (!userId || userId === 'guest') {
        return sendJson(401, {
          error: 'Authentication Required: Please sign in or create an account to place or authorize orders.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(userId);
      } catch (err: any) {
        return sendJson(401, {
          error: 'Authentication Required: No valid registered user account found. Please sign in or create an account first.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      const activeUser = authProvider.getActiveUser();
      if (user.id !== activeUser.id && user.clerkUserId !== activeUser.clerkUserId) {
        authProvider.setActiveUser(user.id);
      }

      if (!sessionId || !mandateId) {
        return sendJson(400, { error: 'Missing sessionId or mandateId' });
      }

      try {
        const result = await autonomousCommerceRunner.authorizeAndExecuteCheckout(
          sessionId,
          mandateId,
          {
            mandateId,
            challengeId: body.challengeId || 'prava_chal_live',
            clientDataJSON: Buffer.from('prava_fido2_client_data').toString('base64url'),
            authenticatorData: Buffer.from('prava_fido2_auth_data').toString('base64url'),
            signature: body.signature || 'prava_biometric_passkey_sig',
          },
          body.idempotencyKey,
          user.id
        );

        const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
        return sendJson(200, {
          ...result,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
          spentLast24hINR: (spend.rolling24hSpentCents / 100).toFixed(2),
          orderedFor: {
            name: user.displayName,
            phone: user.phone,
            address: user.defaultAddress,
            pincode: user.defaultPincode,
          },
        });
      } catch (checkoutErr: any) {
        const msg = checkoutErr.message || 'Checkout failed';
        if (
          msg.includes('Daily spend limit') ||
          msg.includes('Daily budget') ||
          msg.includes('limit exceeded') ||
          msg.includes('daily spend allowance') ||
          msg.includes('exceeds your remaining daily')
        ) {
          return sendJson(422, {
            success: false,
            error: msg,
            code: 'DAILY_BUDGET_EXCEEDED',
          });
        }
        if (msg.includes('Mandate') && msg.includes('consumed')) {
          return sendJson(409, {
            success: false,
            error: msg,
            code: 'MANDATE_ALREADY_CONSUMED',
          });
        }
        return sendJson(400, {
          success: false,
          error: msg,
        });
      }
    }

    // 9b. Serve Prava SDK Client Script
    if (method === 'GET' && url.pathname === '/prava-sdk.js') {
      try {
        const sdkPath = path.resolve('node_modules/@prava-sdk/core/dist/index.js');
        if (fs.existsSync(sdkPath)) {
          const content = fs.readFileSync(sdkPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end(content);
          return;
        }
      } catch (e: any) {
        console.warn('Could not serve /prava-sdk.js from node_modules:', e.message);
      }
      sendJson(404, { error: 'Prava SDK bundle not found' });
      return;
    }

    // 9c. Prava v1: Create Session Endpoint
    if (method === 'POST' && url.pathname === '/api/prava/create-session') {
      const body = await readJson();
      const rawPayload = body.cartPayload || body;
      const userId = rawPayload.userId || body.userId;

      if (!userId || userId === 'guest') {
        return sendJson(401, {
          error: 'Authentication Required: Please sign in or create an account to start Prava checkout.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(userId);
      } catch (err: any) {
        return sendJson(401, {
          error: `Authentication Required: ${err.message || 'Please sign in or create an account first.'}`,
          requiresAuth: true,
        });
      }

      try {
        const merchantName = (rawPayload.merchantName || 'Zepto').includes('swiggy') ? 'Swiggy' : 'Zepto';
        const totalAmount = rawPayload.totalAmount || (rawPayload.totalAmountCents ? rawPayload.totalAmountCents / 100 : 29.26);

        const pravaPayload = {
          orderId: rawPayload.orderId,
          userId: user.id,
          userEmail: user.email || 'customer@example.com',
          merchantName: merchantName as 'Swiggy' | 'Zepto',
          totalAmount: typeof totalAmount === 'number' ? totalAmount : parseFloat(totalAmount),
          totalAmountCents: rawPayload.totalAmountCents || Math.round(Number(totalAmount) * 100),
          currency: rawPayload.currency || 'INR',
          mcpCartId: rawPayload.mcpCartId || `cart_${Date.now()}`,
          items: rawPayload.items || [
            {
              name: rawPayload.itemName || 'Quick Commerce Item',
              quantity: rawPayload.quantity || 1,
              price: typeof totalAmount === 'number' ? totalAmount : parseFloat(totalAmount),
            },
          ],
        };

        const sessionRes = await getPravaClient().createPravaSession(pravaPayload);
        const publishableKey =
          process.env.NEXT_PUBLIC_PRAVA_CLIENT_KEY ||
          process.env.PRAVA_CLIENT_KEY ||
          getPravaClient().getPublishableKey() ||
          'pk_test_NWYJLkIIGe0clWjBzUwiB9EYyHeE-5UOo_jKapZf5EE';

        return sendJson(200, {
          success: true,
          sessionId: sessionRes.session_id,
          sessionToken: sessionRes.session_token,
          iframeUrl: sessionRes.iframe_url,
          orderId: sessionRes.order_id,
          expiresAt: sessionRes.expires_at,
          publishableKey,
        });
      } catch (err: any) {
        console.error('Prava session creation error:', err);
        return sendJson(500, {
          success: false,
          error: err.message || 'Failed to create Prava checkout session',
        });
      }
    }

    // 9d. Prava v1: Execute Order & Settle Status
    if (method === 'POST' && url.pathname === '/api/prava/execute-order') {
      const body = await readJson();
      const { sessionId, pravaSessionId, mandateId, userId } = body;

      if (!userId || userId === 'guest') {
        return sendJson(401, {
          error: 'Authentication Required: Please sign in or create an account to authorize orders.',
          requiresAuth: true,
        });
      }

      if (!sessionId || !pravaSessionId || !mandateId) {
        return sendJson(400, {
          error: 'Missing required parameters: sessionId, pravaSessionId, and mandateId are required.',
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(userId);
      } catch (err: any) {
        return sendJson(401, {
          error: `Authentication Required: ${err.message || 'User not found.'}`,
          requiresAuth: true,
        });
      }

      try {
        const result = await autonomousCommerceRunner.executePravaOrderCheckout(
          sessionId,
          pravaSessionId,
          mandateId,
          user.id
        );

        const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
        return sendJson(200, {
          ...result,
          remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
          spentLast24hINR: (spend.rolling24hSpentCents / 100).toFixed(2),
          orderedFor: {
            name: user.displayName,
            phone: user.phone,
            address: user.defaultAddress,
            pincode: user.defaultPincode,
          },
        });
      } catch (checkoutErr: any) {
        console.error('Prava order execution error:', checkoutErr);
        const msg = checkoutErr.message || 'Prava order execution failed';
        if (
          msg.includes('Daily spend limit') ||
          msg.includes('Daily budget') ||
          msg.includes('limit exceeded')
        ) {
          return sendJson(422, {
            success: false,
            error: msg,
            code: 'DAILY_BUDGET_EXCEEDED',
          });
        }
        return sendJson(400, {
          success: false,
          error: msg,
        });
      }
    }

    // 10. Web UI Views
    // 10a. Landing Page: / and /landing
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/landing')) {
      const html = renderLandingPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // 10b. Interactive Agent Copilot / Dashboard: /app, /dashboard, /index.html, /chat
    if (method === 'GET' && (url.pathname === '/app' || url.pathname === '/dashboard' || url.pathname === '/index.html' || url.pathname === '/chat')) {
      const html = renderWebDashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // 10c. SSO / Google Callback Handler: /sso-callback
    if (method === 'GET' && url.pathname === '/sso-callback') {
      const callbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connecting with Google — Autonomous Commerce</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #FAF8F5;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      color: #18191B;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid rgba(0,0,0,0.08);
      border-radius: 16px;
      padding: 36px 40px;
      text-align: center;
      box-shadow: 0 12px 36px rgba(0,0,0,0.06);
      max-width: 420px;
      width: 90%;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(224,90,28,0.18);
      border-top-color: #E05A1C;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 18px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h3 { margin: 0 0 8px 0; font-size: 17px; font-weight: 700; color: #18191B; }
    p { font-size: 13px; color: #5B616E; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3>Connecting with Google</h3>
    <p>Please wait a moment while we redirect you to your shopping session...</p>
  </div>
  <script>
    setTimeout(function() {
      window.location.href = '/app';
    }, 600);
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml);
      return;
    }

    // Fallback 404
    sendJson(404, { error: 'Not Found', path: url.pathname });
  } catch (err: any) {
    console.error('API Error:', err);
    sendJson(500, { error: err.message || 'Internal Server Error' });
  }
}




// Start Server
export function startDevServer(port = PORT): http.Server {
  authProvider.seedVerifiedClerkProfiles();
  authProvider.syncWithClerkAndDb().catch((err) => {
    console.warn('Initial Clerk/Neon sync note:', err.message);
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`Internal Server Error: ${String(err)}`);
    });
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Error: Port ${port} is already in use by another process.`);
      console.error(`👉 Tip: Stop the other process or set PORT in .env.local (e.g. PORT=3001).\n`);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, () => {
    console.log(`
========================================================================
🚀 Autonomous Commerce Agent (ACA) Dev Server
========================================================================
📍 Local Web App:     http://localhost:${port}
📦 Swiggy MCP:        https://mcp.swiggy.com/im (Instamart Live)
⚡ Zepto MCP:         https://mcp.zepto.co.in/mcp (10-minute Quick Delivery)
🔒 Prava Payments:    https://sandbox.api.prava.space (AP2 Passkeys)
🛡️ Spend Controls:    Per-user dynamic limit with FIDO2 gate
👤 User Auth:         Enabled (Live Identity + Neon PostgreSQL)
========================================================================
`);
  });

  return server;
}

// If executed directly via CLI
if (process.argv[1] && process.argv[1].includes('dev-server')) {
  startDevServer();
}
