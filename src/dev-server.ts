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
} from './index.js';

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
          error: 'Authentication Required: You cannot search or place orders before signing up or logging in with Clerk.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(body.userId);
      } catch (authErr: any) {
        return sendJson(401, {
          error: `Authentication Required: ${authErr.message || 'Please sign up or log in with Clerk.'}`,
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

      // STRICT CONSTRAINT: Do not allow checkout/ordering without signing up with Clerk
      if (!userId || userId === 'guest') {
        return sendJson(401, {
          error: 'Authentication Required: You cannot place or authorize orders before signing up or logging in with Clerk.',
          requiresAuth: true,
          requiresSignup: true,
        });
      }

      let user: AuthUser;
      try {
        user = await authProvider.getAuthenticatedUser(userId);
      } catch (err: any) {
        return sendJson(401, {
          error: 'Authentication Required: No valid registered user account found. Please sign up with Clerk first.',
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

        return sendJson(200, {
          ...result,
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

    // 10. Web UI View
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = renderWebDashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Fallback 404
    sendJson(404, { error: 'Not Found', path: url.pathname });
  } catch (err: any) {
    console.error('API Error:', err);
    sendJson(500, { error: err.message || 'Internal Server Error' });
  }
}

function renderWebDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Autonomous Commerce Agent — Swiggy & Zepto Real-Time Ordering</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070d1e;
      --card-bg: #0d172e;
      --card-border: rgba(59, 130, 246, 0.22);
      --card-hover-border: #38bdf8;
      --swiggy: #fc8019;
      --swiggy-glow: rgba(252, 128, 25, 0.18);
      --zepto: #a855f7;
      --zepto-glow: rgba(168, 85, 247, 0.18);
      --prava: #00d26a;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --azure: #38bdf8;
      --cyan: #06b6d4;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --surface: #0e1933;
      --surface-light: #132244;
      --surface-glass: rgba(13, 23, 46, 0.85);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(1200px circle at 50% -80px, #172b59 0%, #0c1733 45%, #070d1e 100%), #070d1e;
      color: var(--text);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }

    /* Top Navigation */
    header {
      background: rgba(10, 18, 40, 0.88);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid rgba(59, 130, 246, 0.22);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      box-shadow: 0 4px 25px rgba(2, 6, 23, 0.5);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 18px rgba(14, 165, 233, 0.45);
    }
    .brand-text h1 {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #fff;
    }
    .brand-text p {
      font-size: 11px;
      color: #94a3b8;
    }
    .platform-pills {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pill {
      font-size: 11px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 20px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(13, 23, 46, 0.6);
      backdrop-filter: blur(8px);
    }
    .pill-swiggy {
      background: var(--swiggy-glow);
      color: var(--swiggy);
      border: 1px solid rgba(252, 128, 25, 0.35);
    }
    .pill-zepto {
      background: var(--zepto-glow);
      color: var(--zepto);
      border: 1px solid rgba(168, 85, 247, 0.35);
    }
    .pill-prava {
      background: rgba(0, 210, 106, 0.12);
      color: var(--prava);
      border: 1px solid rgba(0, 210, 106, 0.35);
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }

    /* User Profile Bar */
    .user-profile-btn {
      background: #0f1c38;
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 28px;
      padding: 6px 16px 6px 6px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      transition: all 0.25s ease;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    }
    .user-profile-btn:hover {
      border-color: #38bdf8;
      background: #14244a;
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(14, 165, 233, 0.25);
    }
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 12px;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.4);
    }
    .user-info {
      text-align: left;
    }
    .user-name {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .user-loc {
      font-size: 10px;
      color: #94a3b8;
    }

    /* Main Container */
    .main-layout {
      max-width: 1120px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 20px;
      display: flex;
      flex-direction: column;
      flex: 1;
    }

    /* Active User Context Banner */
    .context-banner {
      background: linear-gradient(90deg, rgba(30, 58, 138, 0.35) 0%, rgba(14, 165, 233, 0.12) 100%), #0d172e;
      border: 1px solid rgba(59, 130, 246, 0.32);
      border-radius: 14px;
      padding: 14px 20px;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    }
    .context-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .context-left b {
      color: #38bdf8;
    }
    .btn-auth-switch {
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-auth-switch:hover {
      background: #2563eb;
      border-color: #38bdf8;
      color: #fff;
      box-shadow: 0 2px 10px rgba(37, 99, 235, 0.4);
    }

    /* Chat Area */
    .chat-container {
      background: rgba(11, 20, 42, 0.92);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(59, 130, 246, 0.25);
      border-radius: 20px;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 600px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(37, 99, 235, 0.1);
      overflow: hidden;
    }
    .chat-feed {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Message Bubbles */
    .msg {
      display: flex;
      gap: 12px;
      max-width: 92%;
    }
    .msg-user {
      align-self: flex-end;
      flex-direction: row-reverse;
    }
    .msg-agent {
      align-self: flex-start;
      width: 100%;
    }
    .msg-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      background: #0f1c38;
      border: 1px solid rgba(59, 130, 246, 0.3);
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    }
    .msg-user .msg-avatar {
      background: linear-gradient(135deg, #1d4ed8, #0284c7);
      color: #fff;
      font-size: 13px;
      font-weight: 800;
    }
    .msg-bubble {
      padding: 16px 20px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.6;
    }
    .msg-user .msg-bubble {
      background: linear-gradient(135deg, #1e40af 0%, #2563eb 100%);
      color: #fff;
      border-bottom-right-radius: 4px;
      box-shadow: 0 4px 15px rgba(37, 99, 235, 0.35);
    }
    .msg-agent .msg-bubble {
      background: #0d172e;
      border: 1px solid rgba(59, 130, 246, 0.22);
      color: #e2e8f0;
      border-bottom-left-radius: 4px;
      width: 100%;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }

    /* Live Searching Pulse */
    .searching-indicator {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: #38bdf8;
      padding: 10px 16px;
      background: rgba(14, 165, 233, 0.1);
      border: 1px dashed rgba(56, 189, 248, 0.4);
      border-radius: 10px;
      width: fit-content;
      margin-top: 8px;
    }
    .dot-flashing {
      position: relative;
      width: 7px;
      height: 7px;
      border-radius: 5px;
      background-color: #38bdf8;
      animation: dotPulse 1s infinite alternate;
    }
    @keyframes dotPulse {
      0% { opacity: 0.2; transform: scale(0.8); }
      100% { opacity: 1; transform: scale(1.2); }
    }

    /* Hero "THE ONE BEST CHOICE" Card */
    .best-choice-card {
      background: linear-gradient(135deg, rgba(14, 165, 233, 0.14) 0%, rgba(37, 99, 235, 0.12) 50%, rgba(11, 20, 42, 0.95) 100%), #0b1428;
      border: 1.5px solid rgba(56, 189, 248, 0.65);
      border-radius: 18px;
      padding: 22px;
      margin-top: 18px;
      margin-bottom: 18px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 16px 45px rgba(2, 6, 23, 0.7), 0 0 35px rgba(14, 165, 233, 0.2);
    }
    .best-choice-glow {
      position: absolute;
      top: -50px;
      right: -50px;
      width: 160px;
      height: 160px;
      background: radial-gradient(circle, rgba(14, 165, 233, 0.3) 0%, transparent 70%);
      pointer-events: none;
    }
    .best-choice-top-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .best-choice-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 5px 14px;
      border-radius: 20px;
      box-shadow: 0 2px 12px rgba(14, 165, 233, 0.45);
    }
    .best-choice-body {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 22px;
      align-items: center;
    }
    @media (max-width: 600px) {
      .best-choice-body {
        grid-template-columns: 1fr;
      }
    }
    .best-choice-img-box {
      width: 140px;
      height: 140px;
      background: #0f1c38;
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px;
      position: relative;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .best-choice-img-box img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      transition: transform 0.3s ease;
    }
    .best-choice-card:hover .best-choice-img-box img {
      transform: scale(1.06);
    }
    .live-in-stock-tag {
      position: absolute;
      bottom: 6px;
      left: 6px;
      background: rgba(16, 185, 129, 0.95);
      color: #fff;
      font-size: 9px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.04em;
    }
    .best-choice-info {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .best-choice-brand {
      font-size: 11px;
      font-weight: 800;
      color: #38bdf8;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .best-choice-title {
      font-size: 19px;
      font-weight: 800;
      color: #fff;
      line-height: 1.3;
    }
    .best-choice-unit {
      font-size: 12px;
      color: #cbd5e1;
    }
    .best-choice-pricing {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin: 8px 0;
    }
    .best-choice-price {
      font-size: 28px;
      font-weight: 800;
      color: #38bdf8;
      text-shadow: 0 0 20px rgba(56, 189, 248, 0.3);
    }
    .best-choice-mrp {
      font-size: 14px;
      color: #64748b;
      text-decoration: line-through;
    }
    .discount-pill {
      background: rgba(239, 68, 68, 0.18);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #f87171;
      font-size: 11px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 6px;
    }
    .best-choice-links-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 6px 0 10px 0;
    }
    .btn-product-external {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      font-size: 12px;
      font-weight: 700;
      padding: 8px 16px;
      border-radius: 8px;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-product-external:hover {
      background: rgba(14, 165, 233, 0.3);
      border-color: #38bdf8;
      color: #fff;
      transform: translateY(-1px);
      box-shadow: 0 4px 15px rgba(14, 165, 233, 0.35);
    }
    .best-choice-reason {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.5;
      padding: 10px 14px;
      background: rgba(10, 18, 38, 0.5);
      border-radius: 10px;
      border: 1px solid rgba(59, 130, 246, 0.2);
    }
    .best-choice-footer {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid rgba(59, 130, 246, 0.2);
    }

    /* Alternative Options Section */
    .alt-options-section {
      margin-top: 20px;
      border-top: 1px dashed rgba(59, 130, 246, 0.25);
      padding-top: 18px;
    }
    .alt-options-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 14px;
    }
    .product-cards-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 14px;
    }
    .product-card {
      background: #0b1426;
      border: 1px solid rgba(59, 130, 246, 0.22);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.25s ease;
      position: relative;
    }
    .product-card:hover {
      border-color: #38bdf8;
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(14, 165, 233, 0.2);
      background: #0f1c38;
    }
    .card-active-best {
      border-color: #38bdf8 !important;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.3) !important;
      background: #112040 !important;
    }
    .product-card-top-pill {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .product-img {
      width: 100%;
      height: 110px;
      object-fit: contain;
      background: #0e1933;
      border-radius: 8px;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    .product-img img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 8px;
    }
    .product-brand {
      font-size: 10px;
      font-weight: 800;
      color: #38bdf8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .product-name {
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      margin: 2px 0 6px 0;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .product-unit {
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 8px;
    }
    .product-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid rgba(255,255,255,0.06);
      padding-top: 8px;
      margin-top: 6px;
    }
    .price-box {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .live-price {
      font-size: 15px;
      font-weight: 800;
      color: #fff;
    }
    .mrp-price {
      font-size: 11px;
      color: #64748b;
      text-decoration: line-through;
    }
    .eta-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(59, 130, 246, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .product-card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .product-card-link {
      font-size: 11px;
      font-weight: 700;
      color: #38bdf8;
      text-decoration: none;
      transition: color 0.2s;
    }
    .product-card-link:hover {
      color: #fff;
      text-decoration: underline;
    }
    .btn-select-alt {
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      font-size: 11px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-select-alt:hover {
      background: #0284c7;
      color: #fff;
      box-shadow: 0 2px 10px rgba(14, 165, 233, 0.4);
    }

    /* Recommendation & Passkey Checkout Card */
    .proposal-card {
      background: linear-gradient(135deg, #0e1933 0%, #0a1329 100%);
      border: 1px solid rgba(59, 130, 246, 0.35);
      border-radius: 14px;
      padding: 18px;
      margin-top: 16px;
      box-shadow: 0 4px 25px rgba(0,0,0,0.4);
    }
    .proposal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .proposal-title {
      font-size: 14px;
      font-weight: 800;
      color: #38bdf8;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .proposal-reason {
      font-size: 12px;
      color: #cbd5e1;
      margin-bottom: 12px;
    }
    .proposal-breakdown {
      background: #091224;
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 14px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .proposal-breakdown b {
      font-size: 16px;
      color: #fff;
    }
    .fee-breakdown-card {
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(59, 130, 246, 0.25);
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .fee-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      color: #94a3b8;
    }
    .fee-row.total-row {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed rgba(148, 163, 184, 0.3);
      color: #f8fafc;
      font-weight: 700;
      font-size: 14px;
    }
    .verified-price-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 6px;
    }
    .verified-price-tag.verified {
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .verified-price-tag.unverified {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .budget-alert-banner {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      color: #fbbf24;
      font-size: 12px;
      line-height: 1.4;
    }
    .btn-passkey {
      background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #0284c7 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 14px 20px;
      font-weight: 800;
      font-size: 14px;
      width: 100%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.25s ease;
      box-shadow: 0 4px 20px rgba(37, 99, 235, 0.45);
    }
    .btn-passkey:hover {
      background: linear-gradient(135deg, #2563eb 0%, #0284c7 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(14, 165, 233, 0.55);
    }

    /* Order Receipt */
    .receipt-card {
      background: #091426;
      border: 1px solid rgba(0, 210, 106, 0.4);
      border-radius: 14px;
      padding: 18px;
      margin-top: 14px;
      font-size: 12px;
      box-shadow: 0 4px 25px rgba(0, 210, 106, 0.15);
    }
    .receipt-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      font-size: 15px;
      color: var(--prava);
      margin-bottom: 10px;
    }
    .receipt-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      color: #cbd5e1;
      margin-top: 10px;
    }
    .token-proof {
      margin-top: 10px;
      padding: 8px 12px;
      background: #050d1a;
      border: 1px solid rgba(59, 130, 246, 0.2);
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #38bdf8;
      word-break: break-all;
    }

    /* Chat Input Bar */
    .chat-input-bar {
      padding: 18px 24px;
      border-top: 1px solid rgba(59, 130, 246, 0.22);
      background: #0a1329;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .input-wrapper {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .chat-input {
      flex: 1;
      background: #0e1933;
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #fff;
      padding: 14px 18px;
      border-radius: 12px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: all 0.25s ease;
    }
    .chat-input:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.25);
      background: #112040;
    }
    .btn-send {
      background: linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%);
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 14px 24px;
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.25s ease;
      box-shadow: 0 4px 18px rgba(14, 165, 233, 0.4);
    }
    .btn-send:hover {
      background: linear-gradient(135deg, #2563eb 0%, #38bdf8 100%);
      transform: translateY(-2px);
      box-shadow: 0 6px 25px rgba(14, 165, 233, 0.6);
    }
    .quick-chips {
      display: flex;
      align-items: center;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .chip {
      background: #0f1c38;
      border: 1px solid rgba(59, 130, 246, 0.25);
      color: #94a3b8;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .chip:hover {
      color: #fff;
      border-color: #38bdf8;
      background: rgba(14, 165, 233, 0.15);
      transform: translateY(-1px);
    }

    /* Auth Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(3, 7, 18, 0.82);
      backdrop-filter: blur(12px);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-content {
      background: #0b1428;
      border: 1px solid rgba(59, 130, 246, 0.35);
      border-radius: 20px;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 25px 70px rgba(0,0,0,0.8), 0 0 40px rgba(37, 99, 235, 0.2);
      overflow: hidden;
    }
    .modal-header {
      padding: 22px 26px;
      border-bottom: 1px solid rgba(59, 130, 246, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-header h2 {
      font-size: 18px;
      font-weight: 800;
      color: #fff;
    }
    .modal-close {
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 20px;
      cursor: pointer;
    }
    .modal-close:hover {
      color: #fff;
    }
    .modal-tabs {
      display: flex;
      border-bottom: 1px solid rgba(59, 130, 246, 0.2);
    }
    .tab-btn {
      flex: 1;
      padding: 14px;
      background: none;
      border: none;
      color: #94a3b8;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .tab-btn.active {
      color: #38bdf8;
      border-bottom-color: #38bdf8;
      background: rgba(14, 165, 233, 0.08);
    }
    .modal-body {
      padding: 24px;
    }
    .form-group {
      margin-bottom: 14px;
    }
    .form-group label {
      display: block;
      font-size: 11px;
      font-weight: 800;
      color: #94a3b8;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .form-group input, .form-group textarea {
      width: 100%;
      background: #0e1933;
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #fff;
      padding: 11px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-group input:focus, .form-group textarea:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.2);
    }
    .quick-preset-cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    .preset-card {
      background: #0e1933;
      border: 1px solid rgba(59, 130, 246, 0.25);
      border-radius: 10px;
      padding: 12px;
      cursor: pointer;
      text-align: left;
      transition: all 0.25s ease;
    }
    .preset-card:hover {
      border-color: #38bdf8;
      background: rgba(14, 165, 233, 0.12);
      transform: translateY(-2px);
    }
    .preset-card .preset-name {
      font-size: 12px;
      font-weight: 800;
      color: #fff;
    }
    .preset-card .preset-loc {
      font-size: 10px;
      color: #94a3b8;
    }
    .btn-submit {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
      margin-top: 10px;
      transition: all 0.2s;
      box-shadow: 0 4px 15px rgba(14, 165, 233, 0.35);
    }
    .btn-submit:hover {
      background: linear-gradient(135deg, #2563eb 0%, #38bdf8 100%);
      transform: translateY(-1px);
    }

    /* Passkey Biometric Dialog */
    .biometric-dialog {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(3, 7, 18, 0.85);
      backdrop-filter: blur(12px);
      z-index: 2000;
      align-items: center;
      justify-content: center;
    }
    .biometric-box {
      background: #0b1428;
      border: 1.5px solid #38bdf8;
      border-radius: 22px;
      padding: 32px;
      text-align: center;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 0 60px rgba(14, 165, 233, 0.4);
    }
    .scanner-ring {
      width: 80px;
      height: 80px;
      margin: 0 auto 18px auto;
      border-radius: 50%;
      border: 3px solid rgba(14, 165, 233, 0.25);
      border-top-color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      animation: spinRing 1.5s linear infinite;
    }
    @keyframes spinRing {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <!-- Top Navigation Bar -->
  <header>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div class="brand-text">
        <h1>Autonomous Commerce Agent</h1>
        <p>Swiggy Instamart + Zepto Real-Time Ordering</p>
      </div>
    </div>

    <div class="platform-pills">
      <span class="pill pill-swiggy"><span class="status-dot"></span> Swiggy MCP</span>
      <span class="pill pill-zepto"><span class="status-dot"></span> Zepto MCP</span>
      <span class="pill pill-prava"><span class="status-dot"></span> Prava AP2 Passkey</span>
    </div>

    <button class="user-profile-btn" onclick="openAccountOrLoginModal()" id="navProfileBtn">
      <div class="user-avatar" id="navAvatar">👤</div>
      <div class="user-info">
        <div class="user-name" id="navUserName">Sign In with Clerk <span style="font-size:10px;">▼</span></div>
        <div class="user-loc" id="navUserLoc">Guest Mode</div>
      </div>
    </button>
  </header>

  <!-- Main Content Layout -->
  <div class="main-layout">
    <!-- Active Context Info with Dynamic Address & Wallet Controls -->
    <div class="context-banner" id="contextBanner">
      <div class="context-left" id="bannerContent">
        <span>👤 <b>Guest Session</b></span>
        <span>•</span>
        <span>Please <b>Sign In</b> or <b>Sign Up with Clerk</b> to configure your wallet budget limit and place orders.</span>
      </div>
      <div style="display: flex; gap: 8px;" id="bannerButtons">
        <button class="btn-auth-switch" style="border-color:#10b981; color:#34d399;" onclick="openSignupModal()">⚡ Sign Up with Clerk</button>
        <button class="btn-auth-switch" onclick="openLoginModal()">👤 Log In with Clerk</button>
      </div>
    </div>

    <!-- Chat Container -->
    <div class="chat-container">
      <div class="chat-feed" id="chatFeed">
        <!-- Initial Agent Message -->
        <div class="msg msg-agent">
          <div class="msg-avatar">⚡</div>
          <div class="msg-bubble">
            👋 Welcome! I am your <b>Autonomous Commerce Copilot</b>.<br><br>
            I connect directly to <b>Swiggy Instamart</b> and <b>Zepto</b> in real-time. Simply tell me what you need, and I will locate the nearest dark stores, compare prices and ETAs, spotlight the <b>One Best Choice</b> with official product links, and autonomously execute orders on your behalf with <b>Prava Biometric Passkeys</b>.
          </div>
        </div>
      </div>

      <!-- Chat Input Bar -->
      <div class="chat-input-bar">
        <div class="quick-chips">
          <span class="chip" onclick="quickSend('Find me 1L Nandini milk and brown bread in under 15 mins')">🥛 1L Milk & Bread (<15m)</span>
          <span class="chip" onclick="quickSend('Nandini milk under ₹50 in under 15 mins')">🥛 Nandini Milk (<₹50, <15m)</span>
          <span class="chip" onclick="quickSend('Amul butter under ₹65 within 10 mins')">🧈 Amul Butter (<₹65, <10m)</span>
          <span class="chip" onclick="quickSend('6 eggs and brown bread under ₹150')">🥚 6 Eggs & Bread</span>
          <span class="chip" onclick="quickSend('Maggi Hot & Sweet Chilli Tomato Sauce')">🥫 Maggi Sauce</span>
          <span class="chip" onclick="quickSend('Compare Swiggy vs Zepto for milk')">⚡ Compare Swiggy vs Zepto</span>
        </div>
        <div class="input-wrapper">
          <input type="text" id="userInput" class="chat-input" placeholder="Search groceries or order items (e.g. 'Maggi sauce', '1L milk', 'Amul butter')..." onkeydown="if(event.key==='Enter') sendMessage()">
          <button class="btn-send" id="sendBtn" onclick="sendMessage()">Send ➔</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Wallet & Daily Spend Budget Modal -->
  <div class="modal-overlay" id="walletModal">
    <div class="modal-content" style="max-width: 480px;">
      <div class="modal-header">
        <h2>💳 Wallet & Daily Spend Budget</h2>
        <button class="modal-close" onclick="closeWalletModal()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
          Adjust your daily autonomous commerce allowance anytime. Changes are saved immediately to your Neon PostgreSQL profile and enforced by the agent guardrails.
        </p>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
          <div style="background: rgba(15, 23, 42, 0.6); padding: 12px; border-radius: 10px; border: 1px solid rgba(59, 130, 246, 0.2);">
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Current Daily Limit</div>
            <div style="font-size: 20px; font-weight: 800; color: #38bdf8; margin-top: 4px;" id="walletModalLimit">₹5,000.00</div>
          </div>
          <div style="background: rgba(15, 23, 42, 0.6); padding: 12px; border-radius: 10px; border: 1px solid rgba(16, 185, 129, 0.2);">
            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase;">Remaining Today</div>
            <div style="font-size: 20px; font-weight: 800; color: #10b981; margin-top: 4px;" id="walletModalRemaining">₹5,000.00</div>
          </div>
        </div>

        <div class="form-group">
          <label>New Daily Spend Limit (₹)</label>
          <input type="number" id="walletLimitInput" min="100" max="500000" step="500" value="5000" placeholder="e.g. 10000">
        </div>

        <div style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px;">Quick Presets:</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px;">
          <button type="button" class="btn-auth-switch" onclick="setBudgetPreset(2500)">₹2,500</button>
          <button type="button" class="btn-auth-switch" onclick="setBudgetPreset(5000)">₹5,000</button>
          <button type="button" class="btn-auth-switch" onclick="setBudgetPreset(10000)">₹10,000</button>
          <button type="button" class="btn-auth-switch" onclick="setBudgetPreset(25000)">₹25,000</button>
          <button type="button" class="btn-auth-switch" onclick="setBudgetPreset(50000)">₹50,000</button>
        </div>

        <button class="btn-submit" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%);" onclick="submitWalletUpdate()">Save Limit & Update Database</button>
      </div>
    </div>
  </div>

  <!-- Dynamic Delivery Address Modal -->
  <div class="modal-overlay" id="addressModal">
    <div class="modal-content" style="max-width: 520px;">
      <div class="modal-header">
        <h2>📍 Dynamic Delivery Address</h2>
        <button class="modal-close" onclick="closeAddressModal()">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Enter any street address & pincode across India, or use your GPS location. The autonomous agent dynamically geocodes coordinates and directly routes Swiggy Instamart and Zepto to your exact location.
        </p>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <button type="button" class="btn-auth-switch" onclick="detectCurrentLocation()" style="display: flex; align-items: center; gap: 6px; padding: 7px 14px; font-weight: 600; color: #2563eb; border-color: #93c5fd; background: #eff6ff;">
            <span>📍</span> <span id="gpsBtnText">Use My Current GPS Location</span>
          </button>
          <span style="font-size: 11px; color: #64748b;">Zero address fallbacks</span>
        </div>

        <div style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px;">Quick Shortcuts:</div>
        <div class="quick-preset-cards" style="margin-bottom: 14px;">
          <div class="preset-card" onclick="presetAddress('A/30, Sai Anant Darshan, Kopar Rd, Shastri Nagar, Dombivli West, Dombivli, Maharashtra 421202', '421202', 19.2183, 73.0867)">
            <div class="preset-name">Dombivli West</div>
            <div class="preset-loc">📍 421202 (Mumbai MMR)</div>
          </div>
          <div class="preset-card" onclick="presetAddress('Flat 402, Green Glen Layout, Bellandur, Bengaluru, Karnataka 560103', '560103', 12.9298, 77.6835)">
            <div class="preset-name">Bellandur, Bengaluru</div>
            <div class="preset-loc">📍 560103 (Tech Corridor)</div>
          </div>
          <div class="preset-card" onclick="presetAddress('Flat 101, Powai Heights, Hiranandani Gardens, Powai, Mumbai, Maharashtra 400076', '400076', 19.1176, 72.9060)">
            <div class="preset-name">Powai, Mumbai</div>
            <div class="preset-loc">📍 400076 (Hiranandani)</div>
          </div>
        </div>

        <div class="form-group">
          <label>Custom Street Address (Anywhere in India)</label>
          <input type="text" id="addressStreetInput" placeholder="House/Flat No, Building, Street, Area">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label>6-Digit Pincode</label>
            <input type="text" id="addressPincodeInput" placeholder="e.g. 160018, 302017, 560103" maxlength="6" oninput="clearStaleCoords()">
          </div>
          <div class="form-group">
            <label>City / Region</label>
            <input type="text" id="addressCityInput" placeholder="e.g. Chandigarh, Jaipur, Pune">
          </div>
        </div>

        <button class="btn-submit" id="submitAddressBtn" onclick="submitAddressUpdate()">Update Delivery Location & Dark Stores</button>
      </div>
    </div>
  </div>

  <!-- Clerk Auth Modal (Login & Sign Up) -->
  <div class="modal-overlay" id="authModal">
    <div class="modal-content" style="max-width: 520px;">
      <div class="modal-header">
        <div>
          <h2>Clerk User Authentication</h2>
          <div style="font-size: 11px; color: #10b981; margin-top: 2px;">✓ Powered by Clerk Live Identity & Neon PostgreSQL</div>
        </div>
        <button class="modal-close" onclick="closeAuthModal()">✕</button>
      </div>

      <div class="modal-tabs">
        <button class="tab-btn active" id="tabLoginBtn" onclick="switchAuthTab('login')">Log In (Clerk)</button>
        <button class="tab-btn" id="tabSignupBtn" onclick="switchAuthTab('signup')">Sign Up with Clerk</button>
        <button class="tab-btn" id="tabAccountBtn" onclick="switchAuthTab('account')" style="display: none;">Active Account</button>
      </div>

      <!-- Log In Form -->
      <div class="modal-body" id="loginTab">
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">
          Sign in with your Clerk credentials. The autonomous agent will authenticate your session and load your delivery address & wallet budget from Neon PostgreSQL.
        </p>

        <div class="form-group">
          <label>Email Address or Mobile Number</label>
          <input type="text" id="loginEmail" placeholder="Enter your email or phone" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="loginPassword" placeholder="Enter your password" autocomplete="current-password">
        </div>
        <button class="btn-submit" id="loginSubmitBtn" onclick="submitLogin()">Log In with Clerk</button>
        <div style="text-align: center; margin-top: 14px; font-size: 12px; color: #94a3b8;">
          Don't have an account? <a href="javascript:void(0)" onclick="switchAuthTab('signup')" style="color: #38bdf8; font-weight: 600; text-decoration: underline;">Sign Up with Clerk & Set Budget ➔</a>
        </div>
      </div>

      <!-- Sign Up Form -->
      <div class="modal-body" id="signupTab" style="display: none;">
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 14px;">
          Create a new user account with Clerk. Set your delivery location and daily wallet budget limit to start autonomous commerce ordering.
        </p>
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" id="signupName" placeholder="e.g. Rahul Sharma" autocomplete="name">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label>Email Address (Clerk)</label>
            <input type="email" id="signupEmail" placeholder="e.g. rahul@example.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label>Mobile Number (+91)</label>
            <input type="tel" id="signupPhone" placeholder="e.g. 9876543210" autocomplete="tel">
          </div>
        </div>
        <div class="form-group">
          <label>Delivery Address</label>
          <input type="text" id="signupAddress" placeholder="Flat/House No, Building, Street, Locality">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label>Pincode</label>
            <input type="text" id="signupPincode" placeholder="e.g. 560038 or 400076">
          </div>
          <div class="form-group">
            <label>Password (min 8 chars)</label>
            <input type="password" id="signupPassword" placeholder="Create a password" autocomplete="new-password">
          </div>
        </div>

        <!-- Initial Daily Wallet Budget Limit Section -->
        <div class="form-group" style="background: rgba(15, 23, 42, 0.6); padding: 14px; border-radius: 10px; border: 1px solid rgba(59, 130, 246, 0.25); margin-top: 10px; margin-bottom: 12px;">
          <label style="color: #38bdf8; font-weight: 700; font-size: 13px;">💳 Set Daily Wallet Budget Limit (₹)</label>
          <p style="font-size: 11px; color: #94a3b8; margin: 4px 0 10px 0;">
            Configure your daily autonomous commerce spending cap. The agent will never exceed this budget without explicit passkey approval. You can modify this limit anytime.
          </p>
          <input type="number" id="signupLimit" min="100" max="500000" step="500" value="5000" placeholder="5000" style="font-size: 16px; font-weight: 800; color: #10b981;">
          <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; font-weight: 700; margin-top: 10px; margin-bottom: 6px;">Quick Presets:</div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button type="button" class="btn-auth-switch" style="padding: 4px 10px; font-size: 11px;" onclick="document.getElementById('signupLimit').value = 2500">₹2,500</button>
            <button type="button" class="btn-auth-switch" style="padding: 4px 10px; font-size: 11px;" onclick="document.getElementById('signupLimit').value = 5000">₹5,000</button>
            <button type="button" class="btn-auth-switch" style="padding: 4px 10px; font-size: 11px;" onclick="document.getElementById('signupLimit').value = 10000">₹10,000</button>
            <button type="button" class="btn-auth-switch" style="padding: 4px 10px; font-size: 11px;" onclick="document.getElementById('signupLimit').value = 25000">₹25,000</button>
            <button type="button" class="btn-auth-switch" style="padding: 4px 10px; font-size: 11px;" onclick="document.getElementById('signupLimit').value = 50000">₹50,000</button>
          </div>
        </div>

        <button class="btn-submit" id="signupSubmitBtn" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%);" onclick="submitSignup()">Sign Up with Clerk & Save Budget</button>
        <div style="text-align: center; margin-top: 14px; font-size: 12px; color: #94a3b8;">
          Already have an account? <a href="javascript:void(0)" onclick="switchAuthTab('login')" style="color: #38bdf8; font-weight: 600; text-decoration: underline;">Log In with Clerk ➔</a>
        </div>
      </div>

      <!-- Active Account Management Tab -->
      <div class="modal-body" id="accountTab" style="display: none;">
        <div style="background: rgba(15, 23, 42, 0.6); padding: 16px; border-radius: 12px; border: 1px solid rgba(59, 130, 246, 0.2); margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <div class="user-avatar" id="accountAvatar" style="width: 44px; height: 44px; font-size: 16px;">👤</div>
            <div>
              <div style="font-size: 16px; font-weight: 800; color: #fff;" id="accountDisplayName">User Name</div>
              <div style="font-size: 12px; color: #94a3b8;" id="accountEmail">user@example.com</div>
            </div>
          </div>
          <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px;">📍 <b>Delivery Address:</b> <span id="accountAddress">-</span></div>
          <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px;">🛡️ <b>Daily Wallet Budget:</b> <span id="accountLimit" style="color: #10b981; font-weight: 700;">₹5,000.00</span></div>
          <div style="font-size: 11px; color: #64748b; font-family: monospace;" id="accountClerkId">Clerk ID: -</div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="btn-submit" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%);" onclick="closeAuthModal(); openWalletModal();">💳 Modify Daily Budget Limit</button>
          <button class="btn-submit" style="background: linear-gradient(135deg, #2563eb 0%, #38bdf8 100%);" onclick="closeAuthModal(); openAddressModal();">📍 Change Delivery Address</button>
          <button class="btn-submit" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);" onclick="logout()">🚪 Sign Out / Switch User</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Biometric Passkey Simulation Modal -->
  <div class="biometric-dialog" id="biometricDialog">
    <div class="biometric-box">
      <div class="scanner-ring">🔒</div>
      <h3 style="font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 6px;">Biometric Passkey Required</h3>
      <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 16px;" id="biometricDesc">
        Prava AP2 is authenticating your Touch ID / Face ID passkey...
      </p>
      <div style="font-size: 11px; color: #6ee7b7; font-family: monospace;" id="biometricChallengeId"></div>
    </div>
  </div>

  <script>
    let activeUser = null;
    let activeSessionId = null;
    let currentTurnData = null;

    function openLoginModal() { openAuthModal('login'); }
    function openSignupModal() { openAuthModal('signup'); }
    function openAccountModal() { openAuthModal('account'); }
    function openAccountOrLoginModal() { if (activeUser) openAccountModal(); else openLoginModal(); }

    // Load initial user (respects user session in localStorage, defaults to guest without prefilled credentials)
    async function loadCurrentUser() {
      const savedUserId = localStorage.getItem('aca_active_user_id');
      try {
        let endpoint = '/api/auth/current';
        if (savedUserId) {
          endpoint += '?userId=' + encodeURIComponent(savedUserId);
        } else {
          endpoint += '?guest=1';
        }
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data && data.user) {
          setUserUI(data.user);
        } else {
          setGuestUI();
        }
      } catch (e) {
        console.error('Failed to load user:', e);
        setGuestUI();
      }
    }

    function setGuestUI() {
      activeUser = null;
      document.getElementById('navAvatar').textContent = '👤';
      document.getElementById('navUserName').innerHTML = 'Sign In with Clerk <span style="font-size:10px;">▼</span>';
      document.getElementById('navUserLoc').textContent = 'Guest Mode';

      const bannerContent = document.getElementById('bannerContent');
      if (bannerContent) {
        bannerContent.innerHTML =
          '<span>👤 <b>Guest Session</b></span>' +
          '<span>•</span>' +
          '<span>Please <b>Sign In</b> or <b>Sign Up with Clerk</b> to configure your wallet budget limit and place orders.</span>';
      }

      const bannerButtons = document.getElementById('bannerButtons');
      if (bannerButtons) {
        bannerButtons.innerHTML =
          '<button class="btn-auth-switch" style="border-color:#10b981; color:#34d399;" onclick="openSignupModal()">⚡ Sign Up with Clerk</button>' +
          '<button class="btn-auth-switch" onclick="openLoginModal()">👤 Log In with Clerk</button>';
      }

      const tabAcc = document.getElementById('tabAccountBtn');
      if (tabAcc) tabAcc.style.display = 'none';
    }

    function setUserUI(user, remainingSpendINR) {
      activeUser = user;
      if (user.id) {
        localStorage.setItem('aca_active_user_id', user.id);
      }

      const initials = (user.displayName || 'User')
        .split(' ')
        .filter(Boolean)
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || '👤';

      const limitINR = ((user.dailySpendLimitCents || 500000) / 100).toFixed(2);
      const remText = remainingSpendINR ? (' (₹' + parseFloat(remainingSpendINR).toFixed(2) + ' left)') : '';

      document.getElementById('navAvatar').textContent = initials;
      document.getElementById('navUserName').innerHTML = (user.displayName || 'User') + ' <span style="font-size:10px;">▼</span>';
      document.getElementById('navUserLoc').textContent = '📍 ' + (user.defaultPincode || 'India');

      const bannerContent = document.getElementById('bannerContent');
      if (bannerContent) {
        bannerContent.innerHTML =
          '<span>👤 Ordering for: <b id="bannerUserName">' + (user.displayName || 'User') + '</b></span>' +
          '<span>•</span>' +
          '<span style="cursor: pointer;" onclick="openAddressModal()" title="Click to edit delivery address">📍 Delivery: <b id="bannerUserAddress">' + (user.defaultAddress || '') + ' (' + (user.defaultPincode || '') + ')</b> <span style="font-size:11px; color:#38bdf8;">✏️</span></span>' +
          '<span>•</span>' +
          '<span style="cursor: pointer;" onclick="openWalletModal()" title="Click to edit daily budget">🛡️ Limit: <b id="bannerUserLimit">₹' + limitINR + ' / day' + remText + '</b> <span style="font-size:11px; color:#10b981;">✏️ Edit</span></span>';
      }

      const bannerButtons = document.getElementById('bannerButtons');
      if (bannerButtons) {
        bannerButtons.innerHTML =
          '<button class="btn-auth-switch" style="border-color:#10b981; color:#34d399;" onclick="openWalletModal()">💳 Wallet Budget</button>' +
          '<button class="btn-auth-switch" onclick="openAddressModal()">📍 Change Location</button>' +
          '<button class="btn-auth-switch" onclick="openAccountModal()">👤 Account</button>';
      }

      // Update wallet modal indicators if present
      const wLimit = document.getElementById('walletModalLimit');
      if (wLimit) wLimit.textContent = '₹' + limitINR;
      const wRemaining = document.getElementById('walletModalRemaining');
      if (wRemaining) wRemaining.textContent = '₹' + (remainingSpendINR ? parseFloat(remainingSpendINR).toFixed(2) : limitINR);
      const wInput = document.getElementById('walletLimitInput');
      if (wInput) wInput.value = Math.round((user.dailySpendLimitCents || 500000) / 100);

      // Update address modal inputs if present
      const addrInput = document.getElementById('addressStreetInput');
      if (addrInput) addrInput.value = user.defaultAddress || '';
      const pinInput = document.getElementById('addressPincodeInput');
      if (pinInput) pinInput.value = user.defaultPincode || '';

      // Update account tab in modal
      const tabAcc = document.getElementById('tabAccountBtn');
      if (tabAcc) tabAcc.style.display = 'block';

      const accName = document.getElementById('accountDisplayName');
      if (accName) accName.textContent = user.displayName;
      const accEmail = document.getElementById('accountEmail');
      if (accEmail) accEmail.textContent = user.email || (user.phone ? 'Phone: ' + user.phone : '');
      const accAddr = document.getElementById('accountAddress');
      if (accAddr) accAddr.textContent = (user.defaultAddress || '') + ' (' + (user.defaultPincode || '') + ')';
      const accLimit = document.getElementById('accountLimit');
      if (accLimit) accLimit.textContent = '₹' + limitINR + ' / day';
      const accClerk = document.getElementById('accountClerkId');
      if (accClerk) accClerk.textContent = 'Clerk ID: ' + (user.clerkUserId || user.id);
      const accAv = document.getElementById('accountAvatar');
      if (accAv) accAv.textContent = initials;
    }

    async function logout() {
      localStorage.removeItem('aca_active_user_id');
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      setGuestUI();
      closeAuthModal();
      appendAgentMessage('👋 You have been logged out. Please sign in or register with Clerk to start ordering.');
    }

    // Wallet & Budget Management Functions
    async function openWalletModal() {
      if (!activeUser) {
        openAuthModal('signup');
        return;
      }
      const limitINR = ((activeUser.dailySpendLimitCents || 500000) / 100).toFixed(2);
      document.getElementById('walletModalLimit').textContent = '₹' + limitINR;
      document.getElementById('walletLimitInput').value = Math.round((activeUser.dailySpendLimitCents || 500000) / 100);
      document.getElementById('walletModal').style.display = 'flex';

      try {
        const res = await fetch('/api/me/wallet');
        if (res.ok) {
          const wdata = await res.json();
          if (wdata.remainingSpendINR !== undefined) {
            document.getElementById('walletModalRemaining').textContent = '₹' + parseFloat(wdata.remainingSpendINR).toFixed(2);
          }
          if (wdata.dailyLimitINR !== undefined) {
            document.getElementById('walletModalLimit').textContent = '₹' + parseFloat(wdata.dailyLimitINR).toFixed(2);
          }
        }
      } catch (err) {
        console.error('Error fetching live wallet spend:', err);
      }
    }
    function closeWalletModal() {
      document.getElementById('walletModal').style.display = 'none';
    }
    function setBudgetPreset(val) {
      document.getElementById('walletLimitInput').value = val;
    }
    async function submitWalletUpdate() {
      const input = document.getElementById('walletLimitInput');
      const val = parseFloat(input.value);
      if (!val || isNaN(val) || val < 100 || val > 500000) {
        alert('Please enter a valid daily budget between ₹100 and ₹5,00,000.');
        return;
      }
      try {
        const res = await fetch('/api/me/wallet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dailySpendLimitINR: val,
            userId: activeUser ? activeUser.id : undefined,
          })
        });
        const data = await res.json();
        if (data.success && data.user) {
          setUserUI(data.user);
          closeWalletModal();
          appendAgentMessage('🛡️ **Wallet Daily Spend Limit Updated:** Set to **₹' + parseFloat(data.dailyLimitINR).toFixed(2) + ' / day**. Saved to Neon database and enforced by agent guardrails.');
        } else {
          alert(data.error || 'Failed to update wallet limit');
        }
      } catch (err) {
        alert('Wallet update request failed: ' + err.message);
      }
    }

    // Dynamic Delivery Location Functions
    function openAddressModal() {
      if (!activeUser) {
        openSignupModal();
        return;
      }
      document.getElementById('addressStreetInput').value = activeUser.defaultAddress || '';
      document.getElementById('addressPincodeInput').value = activeUser.defaultPincode || '';
      document.getElementById('addressModal').style.display = 'flex';
    }
    function closeAddressModal() {
      document.getElementById('addressModal').style.display = 'none';
    }
    function clearStaleCoords() {
      delete document.getElementById('addressStreetInput').dataset.lat;
      delete document.getElementById('addressStreetInput').dataset.lng;
    }
    function detectCurrentLocation() {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
      }
      const btn = document.getElementById('gpsBtnText');
      if (btn) btn.textContent = 'Locating GPS...';
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          document.getElementById('addressStreetInput').dataset.lat = lat;
          document.getElementById('addressStreetInput').dataset.lng = lng;
          if (btn) btn.textContent = 'Resolving address...';
          try {
            const res = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json');
            if (res.ok) {
              const data = await res.json();
              if (data && data.address) {
                document.getElementById('addressStreetInput').value = data.display_name.split(',').slice(0, 3).join(', ');
                if (data.address.postcode) {
                  document.getElementById('addressPincodeInput').value = data.address.postcode.replace(/[^0-9]/g, '');
                }
                document.getElementById('addressCityInput').value = data.address.city || data.address.town || data.address.state || '';
              }
            }
          } catch {}
          if (btn) btn.textContent = '📍 GPS Detected!';
        },
        (err) => {
          if (btn) btn.textContent = 'Use My Current GPS Location';
          alert('Could not retrieve GPS location: ' + err.message + '. You can enter your address and pincode manually.');
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
    function presetAddress(addr, pin, lat, lng) {
      document.getElementById('addressStreetInput').value = addr;
      document.getElementById('addressPincodeInput').value = pin;
      document.getElementById('addressStreetInput').dataset.lat = lat ? String(lat) : '';
      document.getElementById('addressStreetInput').dataset.lng = lng ? String(lng) : '';
    }
    async function submitAddressUpdate() {
      const address = document.getElementById('addressStreetInput').value.trim();
      const pincode = document.getElementById('addressPincodeInput').value.trim();
      const city = document.getElementById('addressCityInput') ? document.getElementById('addressCityInput').value.trim() : '';
      const lat = document.getElementById('addressStreetInput').dataset.lat;
      const lng = document.getElementById('addressStreetInput').dataset.lng;

      if (!address || !pincode) {
        alert('Please provide both delivery address and pincode.');
        return;
      }

      const submitBtn = document.getElementById('submitAddressBtn');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Routing to Your Dark Store...';
      }

      try {
        const res = await fetch('/api/me/address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address,
            pincode,
            city,
            latitude: lat || undefined,
            longitude: lng || undefined,
            userId: activeUser ? activeUser.id : undefined,
          })
        });
        const data = await res.json();
        if (data.success && data.user) {
          activeUser = data.user;
          setUserUI(data.user);
          activeSessionId = null; // Re-initialize agent session with the new dark store location
          closeAddressModal();
          appendAgentMessage('📍 **Delivery Location Updated:** Set to **' + data.user.defaultAddress + ' (' + data.user.defaultPincode + ')**. Dark-store searches will now route directly to this specified location.');
        } else {
          alert(data.error || 'Failed to update delivery address');
        }
      } catch (err) {
        alert('Address update request failed: ' + err.message);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Update Delivery Location & Dark Stores';
        }
      }
    }

    function openAuthModal(tab) {
      if (tab) {
        switchAuthTab(tab);
      } else if (activeUser) {
        switchAuthTab('account');
      } else {
        switchAuthTab('login');
      }
      document.getElementById('authModal').style.display = 'flex';
    }
    function closeAuthModal() {
      document.getElementById('authModal').style.display = 'none';
    }

    function switchAuthTab(tab) {
      const loginTab = document.getElementById('loginTab');
      const signupTab = document.getElementById('signupTab');
      const accountTab = document.getElementById('accountTab');
      const tabLoginBtn = document.getElementById('tabLoginBtn');
      const tabSignupBtn = document.getElementById('tabSignupBtn');
      const tabAccountBtn = document.getElementById('tabAccountBtn');

      tabLoginBtn.classList.remove('active');
      tabSignupBtn.classList.remove('active');
      if (tabAccountBtn) tabAccountBtn.classList.remove('active');

      if (tab === 'signup') {
        loginTab.style.display = 'none';
        signupTab.style.display = 'block';
        if (accountTab) accountTab.style.display = 'none';
        tabSignupBtn.classList.add('active');
      } else if (tab === 'account') {
        loginTab.style.display = 'none';
        signupTab.style.display = 'none';
        if (accountTab) accountTab.style.display = 'block';
        if (tabAccountBtn) tabAccountBtn.classList.add('active');
      } else {
        loginTab.style.display = 'block';
        signupTab.style.display = 'none';
        if (accountTab) accountTab.style.display = 'none';
        tabLoginBtn.classList.add('active');
      }
    }

    async function submitLogin() {
      const emailOrPhone = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value.trim();
      if (!emailOrPhone) {
        alert('Please enter your email or phone number');
        return;
      }

      const loginBtn = document.getElementById('loginSubmitBtn');
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Authenticating with Clerk...';
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailOrPhone, password })
        });
        const data = await res.json();
        if (data.success && data.user) {
          setUserUI(data.user);
          closeAuthModal();
          appendAgentMessage('👋 Welcome back, **' + data.user.displayName + '**! Active session established via Clerk.\\n\\n🛡️ Daily Wallet Budget: **₹' + ((data.user.dailySpendLimitCents || 500000) / 100).toFixed(2) + ' / day**\\n📍 Delivery: **' + data.user.defaultAddress + ' (' + data.user.defaultPincode + ')**');
        } else {
          alert(data.error || 'Login failed. Please verify your credentials.');
        }
      } catch (e) {
        alert('Login request failed: ' + e.message);
      } finally {
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Log In with Clerk';
        }
      }
    }

    async function submitSignup() {
      const displayName = document.getElementById('signupName').value.trim();
      const email = document.getElementById('signupEmail').value.trim();
      const phone = document.getElementById('signupPhone').value.trim();
      const address = document.getElementById('signupAddress').value.trim();
      const pincode = document.getElementById('signupPincode').value.trim();
      const limit = document.getElementById('signupLimit').value.trim();
      const password = document.getElementById('signupPassword').value.trim();

      if (!displayName || !email || !address || !pincode) {
        alert('Please fill in your name, email, delivery address, and pincode.');
        return;
      }

      if (password && password.length < 8) {
        alert('Password must be at least 8 characters long for Clerk security.');
        return;
      }

      const signupBtn = document.getElementById('signupSubmitBtn');
      if (signupBtn) {
        signupBtn.disabled = true;
        signupBtn.textContent = 'Registering with Clerk...';
      }

      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName,
            email,
            phone,
            address,
            pincode,
            dailySpendLimitINR: limit ? parseFloat(limit) : 5000,
            password
          })
        });
        const data = await res.json();
        if (data.success && data.user) {
          setUserUI(data.user);
          closeAuthModal();
          appendAgentMessage('🎉 **Welcome ' + data.user.displayName + '!** Your Clerk account has been created and your daily wallet budget is configured to **₹' + parseFloat(data.remainingSpendINR).toFixed(2) + ' / day**.\\n\\n📍 Delivery Location: **' + data.user.defaultAddress + ' (' + data.user.defaultPincode + ')**.\\n\\nTell me what you would like to order!');
        } else {
          alert(data.error || 'Registration failed');
        }
      } catch (e) {
        alert('Sign up request failed: ' + e.message);
      } finally {
        if (signupBtn) {
          signupBtn.disabled = false;
          signupBtn.textContent = 'Sign Up with Clerk & Save Budget';
        }
      }
    }

    function quickSend(text) {
      if (!activeUser) {
        openSignupModal();
        appendAgentMessage('🔒 **Authentication Required:** You cannot order without signing up. Please create an account or log in with Clerk to set your wallet budget and place orders.');
        return;
      }
      document.getElementById('userInput').value = text;
      sendMessage();
    }

    async function sendMessage() {
      const input = document.getElementById('userInput');
      const text = input.value.trim();
      if (!text) return;

      if (!activeUser) {
        openSignupModal();
        appendAgentMessage('🔒 **Authentication Required:** You cannot order without signing up. Please create an account or log in with Clerk to configure your wallet budget and place orders.');
        return;
      }

      input.value = '';
      appendUserMessage(text);

      const indicator = appendSearchingIndicator();

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            sessionId: activeSessionId,
            userId: activeUser ? activeUser.id : undefined
          })
        });

        indicator.remove();

        const data = await res.json();
        if (data.sessionId) activeSessionId = data.sessionId;
        currentTurnData = data;

        appendAgentResponse(data);
      } catch (e) {
        indicator.remove();
        appendAgentMessage('⚠️ Connection error: ' + e.message);
      }
    }

    function appendUserMessage(text) {
      const feed = document.getElementById('chatFeed');
      const div = document.createElement('div');
      div.className = 'msg msg-user';
      div.innerHTML = '<div class="msg-avatar">' + (activeUser ? activeUser.displayName[0] : 'U') + '</div><div class="msg-bubble">' + escapeHtml(text) + '</div>';
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }

    function appendSearchingIndicator() {
      const feed = document.getElementById('chatFeed');
      const div = document.createElement('div');
      div.className = 'msg msg-agent';
      div.innerHTML = '<div class="msg-avatar">⚡</div><div class="msg-bubble"><div class="searching-indicator"><span class="dot-flashing"></span> Searching live Swiggy Instamart & Zepto dark stores in real time...</div></div>';
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
      return div;
    }

    function appendAgentMessage(markdownText) {
      const feed = document.getElementById('chatFeed');
      const div = document.createElement('div');
      div.className = 'msg msg-agent';
      div.innerHTML = '<div class="msg-avatar">⚡</div><div class="msg-bubble">' + formatMarkdown(markdownText) + '</div>';
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }

    function appendAgentResponse(data) {
      const feed = document.getElementById('chatFeed');
      const div = document.createElement('div');
      div.className = 'msg msg-agent';

      let html = '<div class="msg-avatar">⚡</div><div class="msg-bubble">';
      html += formatMarkdown(data.reply);

      const swiggyItems = data.swiggyItems || [];
      const zeptoItems = data.zeptoItems || [];
      const allItems = [...swiggyItems, ...zeptoItems];
      const bestItems = (data.bestItems && data.bestItems.length > 0)
        ? data.bestItems
        : (data.proposal && data.proposal.bestItems && data.proposal.bestItems.length > 0)
        ? data.proposal.bestItems
        : (data.bestItem ? [data.bestItem] : (data.proposal && data.proposal.bestItem ? [data.proposal.bestItem] : (allItems[0] ? [allItems[0]] : [])));
      const best = bestItems[0];

      // 1. RENDER BEST CHOICES (MULTI-ITEM OR SINGLE ITEM SPOTLIGHT)
      if (bestItems.length > 1 && data.proposal) {
        const prop = data.proposal;
        const total = (prop.totalAmountCents / 100).toFixed(2);
        const isSwiggy = prop.platform === 'swiggy_instamart';
        const platformColor = isSwiggy ? 'var(--swiggy)' : 'var(--zepto)';
        const platformName = isSwiggy ? 'Swiggy Instamart' : 'Zepto';
        const eta = prop.etaMinutes || (isSwiggy ? 14 : 10);

        html += '<div class="best-choice-card" id="bestChoiceCard_' + data.sessionId + '">';
        html += '<div class="best-choice-glow"></div>';
        html += '<div class="best-choice-top-bar">';
        html += '<div class="best-choice-badge">🏆 AGENT TOP CHOICES (' + bestItems.length + ' ITEMS)</div>';
        if (prop.constraintValidation && prop.constraintValidation.allPassed) {
          html += '<span style="border: 1px solid #10b981; color: #10b981; background: rgba(16,185,129,0.15); font-size:11px; padding:3px 10px; border-radius:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;">✓ 5 CONSTRAINTS VERIFIED</span>';
        }
        html += '<span style="border: 1px solid ' + platformColor + '; color: ' + platformColor + '; background: rgba(0,0,0,0.3); font-size:11px; padding:3px 10px; border-radius:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;">';
        html += '<span class="status-dot" style="background:' + platformColor + ';"></span> ' + platformName;
        html += '</span>';
        html += '<span class="eta-badge" style="background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); font-weight:700;">⚡ ' + eta + ' MINS DELIVERY</span>';
        html += '</div>';

        if (prop.constraintValidation && prop.constraintValidation.allPassed) {
          html += '<div style="display:flex; flex-wrap:wrap; gap:6px; margin: 0 0 10px 0;">';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Brand Verified</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Live MCP Price Confirmed</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Cost Limit Satisfied</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Stock & Qty Available</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Delivery ETA (' + eta + 'm) Guaranteed</span>';
          html += '</div>';
        }

        html += '<div style="display:flex; flex-direction:column; gap:10px; margin: 12px 0;">';
        for (let i = 0; i < bestItems.length; i++) {
          const item = bestItems[i];
          const itemPrice = (item.priceCents / 100).toFixed(2);
          const mrp = item.mrpCents ? (item.mrpCents / 100).toFixed(2) : null;
          const discountPct = (item.mrpCents && item.priceCents && item.mrpCents > item.priceCents)
            ? Math.round(((item.mrpCents - item.priceCents) / item.mrpCents) * 100)
            : null;
          const pUrl = item.productUrl || (isSwiggy
            ? 'https://www.swiggy.com/instamart/search?query=' + encodeURIComponent(item.name)
            : 'https://www.zeptonow.com/search?q=' + encodeURIComponent(item.name));
          const isButter = item.name.toLowerCase().includes('butter');
          const isEgg = item.name.toLowerCase().includes('egg');
          const icon = isButter ? '🧈' : (isEgg ? '🥚' : (isSwiggy ? '🥫' : '⚡'));

          html += '<div class="best-item-row" style="background:rgba(15,23,42,0.8); border:1px solid rgba(59,130,246,0.25); border-radius:12px; padding:12px 14px; display:flex; gap:14px; align-items:center;">';
          html += '<div style="font-size:11px; font-weight:800; background:linear-gradient(135deg, #2563eb, #38bdf8); color:#fff; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">' + (i + 1) + '</div>';
          html += '<div class="best-choice-img-box" style="width:56px; height:56px; flex-shrink:0; border-radius:8px;">';
          if (item.imageUrl) {
            html += '<img src="' + item.imageUrl + '" alt="' + escapeHtml(item.name) + '" style="width:100%; height:100%; object-fit:contain;">';
          } else {
            html += '<span style="font-size:26px;">' + icon + '</span>';
          }
          html += '</div>';

          html += '<div style="flex:1; min-width:0;">';
          html += '<div class="best-choice-brand" style="font-size:11px;">' + escapeHtml(item.brand || platformName) + '</div>';
          html += '<div style="font-weight:700; font-size:14px; color:#f8fafc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>';
          if (item.unit) html += '<div style="font-size:11px; color:#94a3b8;">Size / Variant: <b>' + escapeHtml(item.unit) + '</b></div>';
          if (item.isPriceVerified !== false) {
            html += '<span class="verified-price-tag verified" style="font-size:9px; padding:1px 5px; margin-top:3px;">✓ Verified Live Price</span>';
          } else {
            html += '<span class="verified-price-tag unverified" style="font-size:9px; padding:1px 5px; margin-top:3px;">⚠️ Unverified</span>';
          }
          html += '</div>';

          html += '<div style="text-align:right; flex-shrink:0;">';
          html += '<div style="font-size:16px; font-weight:800; color:#38bdf8;">₹' + itemPrice + '</div>';
          if (mrp && mrp !== itemPrice) html += '<div style="font-size:11px; color:#94a3b8; text-decoration:line-through;">₹' + mrp + '</div>';
          if (discountPct) html += '<span class="discount-pill" style="font-size:9px; padding:1px 5px;">' + discountPct + '% OFF</span>';
          html += '<div style="margin-top:4px;"><a href="' + pUrl + '" target="_blank" rel="noopener noreferrer" style="font-size:10px; color:#38bdf8; text-decoration:underline;">View ↗</a></div>';
          html += '</div>';

          html += '</div>'; // end best-item-row
        }
        html += '</div>';

        html += '<div class="best-choice-reason" id="bestHeroReason_' + data.sessionId + '">';
        html += '💡 <b>Why these are your best choices:</b> ' + escapeHtml(data.recommendationReason || 'Optimal combination of dark store availability, lowest price, and fastest guaranteed ETA for both requested items.');
        html += '</div>';

        // Cost breakdown card
        const subtotalStr = ((prop.subtotalCents || prop.totalAmountCents) / 100).toFixed(2);
        const delivStr = (prop.deliveryFeeCents && prop.deliveryFeeCents > 0)
          ? ('₹' + (prop.deliveryFeeCents / 100).toFixed(2))
          : '<span style="color:#10b981;">FREE</span>';
        const handlingStr = ((prop.handlingFeeCents || 0) / 100).toFixed(2);
        const taxStr = ((prop.taxesCents || 0) / 100).toFixed(2);
        const discountStr = (prop.discountCents && prop.discountCents > 0)
          ? ('-₹' + (prop.discountCents / 100).toFixed(2))
          : null;

        html += '<div class="fee-breakdown-card">';
        html += '<div style="font-size:11px; text-transform:uppercase; color:#38bdf8; font-weight:700; margin-bottom:6px; display:flex; justify-content:space-between;">';
        html += '<span>Order Cost Breakdown (' + bestItems.length + ' Items)</span>';
        html += '<span style="font-size:10px; color:#94a3b8; font-weight:normal;">Estimated (Confirmed at Checkout)</span>';
        html += '</div>';
        html += '<div class="fee-row"><span>Items Subtotal:</span><span id="bestHeroSubtotal_' + data.sessionId + '">₹' + subtotalStr + '</span></div>';
        html += '<div class="fee-row"><span>Delivery Fee:</span><span id="bestHeroDeliv_' + data.sessionId + '">' + delivStr + '</span></div>';
        html += '<div class="fee-row"><span>Platform & Handling Fee:</span><span id="bestHeroHandling_' + data.sessionId + '">₹' + handlingStr + '</span></div>';
        html += '<div class="fee-row"><span>Taxes & GST:</span><span id="bestHeroTaxes_' + data.sessionId + '">₹' + taxStr + '</span></div>';
        if (discountStr) {
          html += '<div class="fee-row" style="color:#10b981;"><span>Eligible Discounts:</span><span id="bestHeroDiscountAmt_' + data.sessionId + '">' + discountStr + '</span></div>';
        }
        html += '<div class="fee-row total-row"><span>Estimated Total Payable:</span><span id="bestHeroTotal_' + data.sessionId + '" style="color:#10b981; font-size:16px;">₹' + total + '</span></div>';
        html += '</div>';

        if (prop.budgetExceeded || prop.budgetSuggestion) {
          const advisoryMsg = prop.budgetSuggestion ? prop.budgetSuggestion.text : ('Estimated total ₹' + total + ' exceeds remaining daily budget.');
          html += '<div class="budget-alert-banner">';
          html += '🛡️ <b>Daily Budget Advisory:</b> ' + escapeHtml(advisoryMsg);
          html += '</div>';
        }

        // Bottom Breakdown & Biometric Authorization
        html += '<div class="best-choice-footer">';
        html += '<div class="proposal-breakdown" style="margin-bottom:10px;">';
        const userDisplayName = activeUser ? activeUser.displayName : (data.user ? data.user.displayName : 'Guest (Sign Up Required)');
        const userPin = activeUser ? (activeUser.defaultPincode || '') : (data.user ? data.user.pincode : '');
        html += '<span>Delivering on behalf of: <b>' + escapeHtml(userDisplayName) + '</b>' + (userPin ? ' (' + escapeHtml(userPin) + ')' : '') + '</span>';
        html += '<span style="font-size:13px; color:#94a3b8;">Est. Payable: <b style="color:#10b981; font-size:15px;">₹' + total + '</b></span>';
        html += '</div>';

        const hasUnverified = bestItems.some(it => it.isPriceVerified === false) || prop.isPriceVerified === false;
        if (hasUnverified) {
          html += '<button class="btn-passkey" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;" disabled>';
          html += '⚠️ Checkout Blocked: Item price not verified by merchant integration';
          html += '</button>';
        } else if (prop.budgetExceeded) {
          html += '<button class="btn-passkey" style="background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24;" disabled title="Daily spend limit exceeded">';
          html += '⚠️ Cannot Authorize: Exceeds Daily Spend Limit (Adjust in Wallet or select cheaper alternative)';
          html += '</button>';
        } else if (activeUser && data.mandateBundle) {
          const mandateId = data.mandateBundle.mandateId || '';
          const challengeId = (data.mandateBundle.challenge && data.mandateBundle.challenge.challengeId) || '';
          html += '<button class="btn-passkey" id="passkeyBtn_' + data.sessionId + '" data-session="' + data.sessionId + '" data-mandate="' + mandateId + '" data-challenge="' + challengeId + '" data-amount="' + prop.totalAmountCents + '" onclick="triggerPasskeyFromBtn(this)">';
          html += '🔒 Authorize ₹' + total + ' for ' + bestItems.length + ' Items with Biometric Passkey';
          html += '</button>';
        } else if (!activeUser) {
          html += '<button class="btn-passkey" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%);" id="passkeyBtn_' + data.sessionId + '" onclick="openSignupModal()">';
          html += '⚡ Sign Up with Clerk to Authorize Order (₹' + total + ')';
          html += '</button>';
        } else {
          html += '<button class="btn-passkey" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;" disabled>';
          html += '⚠️ ' + escapeHtml((data.turn && data.turn.error) || data.error || 'Authorization mandate unavailable');
          html += '</button>';
        }
        html += '</div>'; // end best-choice-footer
        html += '</div>'; // end best-choice-card
      } else if (best && data.proposal) {
        const prop = data.proposal;
        const total = (prop.totalAmountCents / 100).toFixed(2);
        const itemPrice = ((best.priceCents || prop.totalAmountCents) / 100).toFixed(2);
        const mrp = best.mrpCents ? (best.mrpCents / 100).toFixed(2) : null;
        const discountPct = (best.mrpCents && best.priceCents && best.mrpCents > best.priceCents)
          ? Math.round(((best.mrpCents - best.priceCents) / best.mrpCents) * 100)
          : null;
        const isSwiggy = best.platform === 'swiggy_instamart';
        const platformColor = isSwiggy ? 'var(--swiggy)' : 'var(--zepto)';
        const platformName = isSwiggy ? 'Swiggy Instamart' : 'Zepto';
        const eta = best.etaMinutes || prop.etaMinutes || (isSwiggy ? 14 : 10);
        const productUrl = best.productUrl || (isSwiggy
          ? 'https://www.swiggy.com/instamart/search?query=' + encodeURIComponent(best.name)
          : 'https://www.zeptonow.com/search?q=' + encodeURIComponent(best.name));

        html += '<div class="best-choice-card" id="bestChoiceCard_' + data.sessionId + '">';
        html += '<div class="best-choice-glow"></div>';
        html += '<div class="best-choice-top-bar">';
        html += '<div class="best-choice-badge">🏆 AGENT TOP CHOICE</div>';
        if (prop.constraintValidation && prop.constraintValidation.allPassed) {
          html += '<span style="border: 1px solid #10b981; color: #10b981; background: rgba(16,185,129,0.15); font-size:11px; padding:3px 10px; border-radius:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;">✓ 5 CONSTRAINTS VERIFIED</span>';
        }
        html += '<span style="border: 1px solid ' + platformColor + '; color: ' + platformColor + '; background: rgba(0,0,0,0.3); font-size:11px; padding:3px 10px; border-radius:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;">';
        html += '<span class="status-dot" style="background:' + platformColor + ';"></span> ' + platformName;
        html += '</span>';
        html += '<span class="eta-badge" style="background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); font-weight:700;">⚡ ' + eta + ' MINS DELIVERY</span>';
        html += '</div>';

        if (prop.constraintValidation && prop.constraintValidation.allPassed) {
          html += '<div style="display:flex; flex-wrap:wrap; gap:6px; margin: 0 0 14px 0;">';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Brand Verified</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Live MCP Price Confirmed</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Cost Limit Satisfied</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Stock & Qty Available</span>';
          html += '<span style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#34d399; font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;">✓ Delivery ETA (' + eta + 'm) Guaranteed</span>';
          html += '</div>';
        }

        html += '<div class="best-choice-body">';
        html += '<div class="best-choice-img-box">';
        if (best.imageUrl) {
          html += '<img id="bestHeroImg_' + data.sessionId + '" src="' + best.imageUrl + '" alt="' + escapeHtml(best.name) + '">';
        } else {
          html += '<span style="font-size:42px;">' + (isSwiggy ? '🥫' : '⚡') + '</span>';
        }
        html += '<span class="live-in-stock-tag">● IN STOCK</span>';
        html += '</div>';

        html += '<div class="best-choice-info">';
        html += '<div class="best-choice-brand" id="bestHeroBrand_' + data.sessionId + '">' + escapeHtml(best.brand || (isSwiggy ? 'Swiggy' : 'Zepto')) + '</div>';
        html += '<h3 class="best-choice-title" id="bestHeroTitle_' + data.sessionId + '">' + escapeHtml(best.name) + '</h3>';
        if (best.unit) {
          html += '<div class="best-choice-unit" id="bestHeroUnit_' + data.sessionId + '">Size / Variant: <b>' + escapeHtml(best.unit) + '</b></div>';
        }

        html += '<div class="best-choice-pricing">';
        html += '<span class="best-choice-price" id="bestHeroPrice_' + data.sessionId + '">₹' + itemPrice + '</span>';
        if (mrp && mrp !== itemPrice) {
          html += '<span class="best-choice-mrp" id="bestHeroMrp_' + data.sessionId + '">₹' + mrp + '</span>';
        }
        if (discountPct) {
          html += '<span class="discount-pill" id="bestHeroDiscount_' + data.sessionId + '">' + discountPct + '% OFF</span>';
        }
        if (best.isPriceVerified) {
          html += '<span class="verified-price-tag verified">✓ Verified Live Price</span>';
        } else {
          html += '<span class="verified-price-tag unverified">⚠️ Unverified Price</span>';
        }
        html += '</div>';

        html += '<div class="best-choice-links-row">';
        html += '<a href="' + productUrl + '" id="bestHeroLink_' + data.sessionId + '" target="_blank" rel="noopener noreferrer" class="btn-product-external">';
        html += '🔗 View Product on ' + platformName + ' ↗';
        html += '</a>';
        html += '</div>';

        html += '<div class="best-choice-reason" id="bestHeroReason_' + data.sessionId + '">';
        html += '💡 <b>Why this is your best choice:</b> ' + escapeHtml(data.recommendationReason || 'Optimal combination of dark store availability, lowest price, and fastest guaranteed ETA.');
        html += '</div>';

        // Complete cost breakdown card
        const subtotalStr = ((prop.subtotalCents || best.priceCents || prop.totalAmountCents) / 100).toFixed(2);
        const delivStr = (prop.deliveryFeeCents && prop.deliveryFeeCents > 0)
          ? ('₹' + (prop.deliveryFeeCents / 100).toFixed(2))
          : '<span style="color:#10b981;">FREE</span>';
        const handlingStr = ((prop.handlingFeeCents || 0) / 100).toFixed(2);
        const taxStr = ((prop.taxesCents || 0) / 100).toFixed(2);
        const discountStr = (prop.discountCents && prop.discountCents > 0)
          ? ('-₹' + (prop.discountCents / 100).toFixed(2))
          : null;

        html += '<div class="fee-breakdown-card">';
        html += '<div style="font-size:11px; text-transform:uppercase; color:#38bdf8; font-weight:700; margin-bottom:6px; display:flex; justify-content:space-between;">';
        html += '<span>Order Cost Breakdown</span>';
        html += '<span style="font-size:10px; color:#94a3b8; font-weight:normal;">Estimated (Confirmed at Checkout)</span>';
        html += '</div>';
        html += '<div class="fee-row"><span>Items Subtotal:</span><span id="bestHeroSubtotal_' + data.sessionId + '">₹' + subtotalStr + '</span></div>';
        html += '<div class="fee-row"><span>Delivery Fee:</span><span id="bestHeroDeliv_' + data.sessionId + '">' + delivStr + '</span></div>';
        html += '<div class="fee-row"><span>Platform & Handling Fee:</span><span id="bestHeroHandling_' + data.sessionId + '">₹' + handlingStr + '</span></div>';
        html += '<div class="fee-row"><span>Taxes & GST:</span><span id="bestHeroTaxes_' + data.sessionId + '">₹' + taxStr + '</span></div>';
        if (discountStr) {
          html += '<div class="fee-row" style="color:#10b981;"><span>Eligible Discounts:</span><span id="bestHeroDiscountAmt_' + data.sessionId + '">' + discountStr + '</span></div>';
        }
        html += '<div class="fee-row total-row"><span>Estimated Total Payable:</span><span id="bestHeroTotal_' + data.sessionId + '" style="color:#10b981; font-size:16px;">₹' + total + '</span></div>';
        html += '</div>';

        if (prop.budgetExceeded || prop.budgetSuggestion) {
          const advisoryMsg = prop.budgetSuggestion ? prop.budgetSuggestion.text : ('Estimated total ₹' + total + ' exceeds remaining daily budget.');
          html += '<div class="budget-alert-banner">';
          html += '🛡️ <b>Daily Budget Advisory:</b> ' + escapeHtml(advisoryMsg);
          html += '</div>';
        }

        html += '</div>'; // end best-choice-info
        html += '</div>'; // end best-choice-body

        // Bottom Breakdown & Biometric Authorization
        html += '<div class="best-choice-footer">';
        html += '<div class="proposal-breakdown" style="margin-bottom:10px;">';
        const userDisplayName = activeUser ? activeUser.displayName : (data.user ? data.user.displayName : 'Guest (Sign Up Required)');
        const userPin = activeUser ? (activeUser.defaultPincode || '') : (data.user ? data.user.pincode : '');
        html += '<span>Delivering on behalf of: <b>' + escapeHtml(userDisplayName) + '</b>' + (userPin ? ' (' + escapeHtml(userPin) + ')' : '') + '</span>';
        html += '<span style="font-size:13px; color:#94a3b8;">Est. Payable: <b style="color:#10b981; font-size:15px;">₹' + total + '</b></span>';
        html += '</div>';

        if (best.isPriceVerified === false || prop.isPriceVerified === false) {
          html += '<button class="btn-passkey" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;" disabled>';
          html += '⚠️ Checkout Blocked: Item price not verified by merchant integration';
          html += '</button>';
        } else if (prop.budgetExceeded) {
          html += '<button class="btn-passkey" style="background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24;" disabled title="Daily spend limit exceeded">';
          html += '⚠️ Cannot Authorize: Exceeds Daily Spend Limit (Adjust in Wallet or select cheaper alternative)';
          html += '</button>';
        } else if (activeUser && data.mandateBundle) {
          const mandateId = data.mandateBundle.mandateId || '';
          const challengeId = (data.mandateBundle.challenge && data.mandateBundle.challenge.challengeId) || '';
          html += '<button class="btn-passkey" id="passkeyBtn_' + data.sessionId + '" data-session="' + data.sessionId + '" data-mandate="' + mandateId + '" data-challenge="' + challengeId + '" data-amount="' + prop.totalAmountCents + '" onclick="triggerPasskeyFromBtn(this)">';
          html += '🔒 Authorize ₹' + total + ' with Biometric Passkey (Touch ID / Face ID)';
          html += '</button>';
        } else if (!activeUser) {
          html += '<button class="btn-passkey" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%);" id="passkeyBtn_' + data.sessionId + '" onclick="openSignupModal()">';
          html += '⚡ Sign Up with Clerk to Authorize Order (₹' + total + ')';
          html += '</button>';
        } else {
          html += '<button class="btn-passkey" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;" disabled>';
          html += '⚠️ ' + escapeHtml((data.turn && data.turn.error) || data.error || 'Authorization mandate unavailable');
          html += '</button>';
        }
        html += '</div>'; // end best-choice-footer

        html += '</div>'; // end best-choice-card
      }

      // 2. RENDER ALTERNATIVE OPTIONS SECTION WITH OFFICIAL LINKS (STRICTLY TOP 5)
      const topOptions = (allItems || []).slice(0, 5);
      if (topOptions.length > 0) {
        html += '<div class="alt-options-section">';
        html += '<div class="alt-options-header">';
        html += '<span>📦 Top 5 Verified Options & Alternatives</span>';
        html += '<span style="font-size:11px; color:var(--text-muted);">Strictly ranked by: 1. Price (Lowest) • 2. Quantity (In-Stock) • 3. Product Match • 4. Brand</span>';
        html += '</div>';

        html += '<div class="product-cards-row">';
        for (let idx = 0; idx < topOptions.length; idx++) {
          const item = topOptions[idx];
          const isSwiggy = item.platform === 'swiggy_instamart';
          const pName = isSwiggy ? 'Swiggy' : 'Zepto';
          const pColor = isSwiggy ? 'var(--swiggy)' : 'var(--zepto)';
          const price = (item.priceCents / 100).toFixed(2);
          const mrp = item.mrpCents ? (item.mrpCents / 100).toFixed(2) : null;
          const discount = (item.mrpCents && item.priceCents && item.mrpCents > item.priceCents)
            ? Math.round(((item.mrpCents - item.priceCents) / item.mrpCents) * 100)
            : null;
          const pUrl = item.productUrl || (isSwiggy
            ? 'https://www.swiggy.com/instamart/search?query=' + encodeURIComponent(item.name)
            : 'https://www.zeptonow.com/search?q=' + encodeURIComponent(item.name));
          const isCurrentBest = best && (best.id === item.id || best.name === item.name);

          html += '<div class="product-card' + (isCurrentBest ? ' card-active-best' : '') + '" id="prodCard_' + data.sessionId + '_' + idx + '">';
          html += '<div class="product-card-top-pill">';
          html += '<span style="color:' + pColor + '; font-size:10px; font-weight:700;">' + pName + '</span>';
          html += '<span class="eta-badge">' + (item.etaMinutes || (isSwiggy ? 14 : 10)) + 'm</span>';
          html += '</div>';

          html += '<div class="product-img">' + (item.imageUrl ? '<img src="' + item.imageUrl + '" alt="' + escapeHtml(item.name) + '">' : (isSwiggy ? '🥫' : '⚡')) + '</div>';
          html += '<div>';
          html += '<div class="product-brand">' + escapeHtml(item.brand || pName) + '</div>';
          html += '<div class="product-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>';
          if (item.unit) html += '<div class="product-unit">' + escapeHtml(item.unit) + '</div>';
          html += '</div>';

          html += '<div class="product-footer">';
          html += '<div class="price-box">';
          html += '<span class="live-price">₹' + price + '</span>';
          if (mrp && mrp !== price) html += '<span class="mrp-price">₹' + mrp + '</span>';
          if (discount) html += '<span class="discount-pill" style="font-size:9px; padding:1px 5px;">' + discount + '%</span>';
          html += '</div>';
          html += '</div>';

          html += '<div class="product-card-actions">';
          html += '<a href="' + pUrl + '" target="_blank" rel="noopener noreferrer" class="product-card-link">View Product ↗</a>';
          html += '<button class="btn-select-alt" data-session="' + data.sessionId + '" data-index="' + idx + '" onclick="handleSelectAlternative(this)">Select ➔</button>';
          html += '</div>';

          html += '</div>'; // end product-card
        }
        html += '</div>'; // end product-cards-row
        html += '</div>'; // end alt-options-section
      }

      html += '</div>'; // end msg-bubble
      div.innerHTML = html;
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }

    function handleSelectAlternative(btn) {
      if (!activeUser) {
        openSignupModal();
        appendAgentMessage('🔒 **Authentication Required:** You cannot select items or place orders without signing up. Please create an account or log in with Clerk to set your wallet budget and place orders.');
        return;
      }
      const sessionId = btn.getAttribute('data-session');
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (!currentTurnData) return;
      const allItems = [...(currentTurnData.swiggyItems || []), ...(currentTurnData.zeptoItems || [])];
      const selected = allItems[idx];
      if (!selected) return;

      const isSwiggy = selected.platform === 'swiggy_instamart';
      const platformName = isSwiggy ? 'Swiggy Instamart' : 'Zepto';
      const priceStr = (selected.priceCents / 100).toFixed(2);

      const titleEl = document.getElementById('bestHeroTitle_' + sessionId);
      const brandEl = document.getElementById('bestHeroBrand_' + sessionId);
      const unitEl = document.getElementById('bestHeroUnit_' + sessionId);
      const priceEl = document.getElementById('bestHeroPrice_' + sessionId);
      const mrpEl = document.getElementById('bestHeroMrp_' + sessionId);
      const imgEl = document.getElementById('bestHeroImg_' + sessionId);
      const linkEl = document.getElementById('bestHeroLink_' + sessionId);
      const reasonEl = document.getElementById('bestHeroReason_' + sessionId);
      const totalEl = document.getElementById('bestHeroTotal_' + sessionId);
      const passkeyBtn = document.getElementById('passkeyBtn_' + sessionId);

      if (titleEl) titleEl.textContent = selected.name;
      if (brandEl) brandEl.textContent = selected.brand || platformName;
      if (unitEl) {
        unitEl.innerHTML = selected.unit ? ('Size / Variant: <b>' + escapeHtml(selected.unit) + '</b>') : '';
      }
      if (priceEl) priceEl.textContent = '₹' + priceStr;
      if (mrpEl) mrpEl.textContent = selected.mrpCents ? ('₹' + (selected.mrpCents / 100).toFixed(2)) : '';
      if (imgEl && selected.imageUrl) imgEl.src = selected.imageUrl;

      // Update breakdown fields accurately
      const subEl = document.getElementById('bestHeroSubtotal_' + sessionId);
      const delivEl = document.getElementById('bestHeroDeliv_' + sessionId);
      const handEl = document.getElementById('bestHeroHandling_' + sessionId);
      const delivFeeCents = isSwiggy ? (selected.priceCents >= 9900 ? 0 : 2500) : (selected.priceCents >= 9900 ? 0 : 2000);
      const handFeeCents = isSwiggy ? 400 : 300;
      const newTotalCents = selected.priceCents + delivFeeCents + handFeeCents;
      const newTotalStr = (newTotalCents / 100).toFixed(2);

      if (subEl) subEl.textContent = '₹' + priceStr;
      if (delivEl) delivEl.innerHTML = delivFeeCents > 0 ? ('₹' + (delivFeeCents / 100).toFixed(2)) : '<span style="color:#10b981;">FREE</span>';
      if (handEl) handEl.textContent = '₹' + (handFeeCents / 100).toFixed(2);
      if (totalEl) totalEl.textContent = '₹' + newTotalStr;

      if (reasonEl) {
        reasonEl.innerHTML = '💡 <b>Selected by You:</b> Switched to <b>' + escapeHtml(selected.name) + '</b> from ' + platformName + ' with live dark store dispatch.';
      }
      if (linkEl && selected.productUrl) {
        linkEl.href = selected.productUrl;
        linkEl.textContent = '🔗 View Product on ' + platformName + ' ↗';
      }
      if (passkeyBtn) {
        passkeyBtn.setAttribute('data-amount', newTotalCents);
        passkeyBtn.innerHTML = '🔒 Authorize ₹' + newTotalStr + ' with Biometric Passkey (Touch ID / Face ID)';
      }

      document.querySelectorAll('[id^="prodCard_' + sessionId + '_"]').forEach(function(card) {
        card.classList.remove('card-active-best');
      });
      const activeCard = document.getElementById('prodCard_' + sessionId + '_' + idx);
      if (activeCard) activeCard.classList.add('card-active-best');

      const heroCard = document.getElementById('bestChoiceCard_' + sessionId);
      if (heroCard) heroCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function triggerPasskeyFromBtn(btn) {
      if (!activeUser) {
        openSignupModal();
        appendAgentMessage('🔒 **Authentication Required:** You cannot place or authorize orders without signing up. Please create an account or log in with Clerk to set your wallet budget and place orders.');
        return;
      }
      const sessionId = btn.getAttribute('data-session');
      const mandateId = btn.getAttribute('data-mandate');
      const challengeId = btn.getAttribute('data-challenge');
      const totalCents = parseInt(btn.getAttribute('data-amount') || '0', 10);
      if (!mandateId) {
        alert('Authorization mandate unavailable. Please request a fresh quote.');
        return;
      }
      triggerPasskeyCheckout(sessionId, mandateId, challengeId, totalCents);
    }

    async function triggerPasskeyCheckout(sessionId, mandateId, challengeId, totalCents) {
      if (!activeUser) {
        openSignupModal();
        appendAgentMessage('🔒 **Authentication Required:** You cannot place or authorize orders without signing up. Please create an account or log in with Clerk to set your wallet budget and place orders.');
        return;
      }
      const dialog = document.getElementById('biometricDialog');
      const desc = document.getElementById('biometricDesc');
      const chalEl = document.getElementById('biometricChallengeId');

      dialog.style.display = 'flex';
      desc.textContent = 'Authenticating Touch ID / Face ID passkey for ₹' + (totalCents/100).toFixed(2) + ' on behalf of ' + activeUser.displayName + '...';
      chalEl.textContent = 'Challenge: ' + challengeId;

      setTimeout(async () => {
        try {
          const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              mandateId,
              challengeId,
              userId: activeUser ? activeUser.id : undefined,
              signature: 'prava_fido2_biometric_verified_sig_' + Date.now()
            })
          });

          dialog.style.display = 'none';
          const checkoutData = await res.json();

          if (checkoutData.success) {
            renderOrderReceipt(checkoutData);
            try {
              const wRes = await fetch('/api/me/wallet');
              if (wRes.ok) {
                const wJson = await wRes.json();
                setUserUI(wJson.user, wJson.remainingSpendINR);
              }
            } catch (_) {}
          } else {
            alert('Checkout failed: ' + (checkoutData.error || 'Unknown error'));
            if (checkoutData.requiresAuth || checkoutData.requiresSignup) {
              openSignupModal();
            }
          }
        } catch (e) {
          dialog.style.display = 'none';
          alert('Passkey verification error: ' + e.message);
        }
      }, 1200);
    }

    function renderOrderReceipt(data) {
      const feed = document.getElementById('chatFeed');
      const div = document.createElement('div');
      div.className = 'msg msg-agent';

      const order = data.order || {};
      const total = order.totalAmountCents !== undefined
        ? (order.totalAmountCents / 100).toFixed(2)
        : (data.totalChargedCents !== undefined ? (data.totalChargedCents / 100).toFixed(2) : '0.00');
      const recipient = data.orderedFor || activeUser;

      let html = '<div class="msg-avatar">⚡</div><div class="msg-bubble">';
      html += '<div class="receipt-card">';
      html += '<div class="receipt-header">✓ Order Confirmed on ' + (order.merchantName || 'Swiggy Instamart') + '!</div>';
      html += '<div>Your quick-commerce order has been autonomously placed and confirmed on behalf of <b>' + escapeHtml(recipient.name) + '</b>.</div>';
      html += '<div class="receipt-grid">';
      html += '<div><b>Order ID:</b> ' + (order.orderId || 'ORD_CONFIRMED') + '</div>';
      html += '<div><b>Status:</b> Confirmed & Dispatched</div>';
      html += '<div><b>Total Paid:</b> ₹' + total + '</div>';
      html += '<div><b>Estimated Delivery:</b> ' + (order.etaMinutes || 20) + ' Mins</div>';
      html += '<div style="grid-column: span 2;"><b>Delivering to:</b> ' + escapeHtml(recipient.address) + ' (' + recipient.pincode + ')</div>';
      html += '</div>';
      html += '<div style="margin-top: 10px; font-size: 11px; color: #94a3b8;"><b>Prava AP2 Single-Use Token Reference:</b></div>';
      html += '<div class="token-proof">' + (data.pravaTokenRef || 'prava_tok_ref_verified') + '</div>';
      html += '</div>';
      html += '</div>';

      div.innerHTML = html;
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatMarkdown(text) {
      if (!text) return '';
      var safe = escapeHtml(text);
      safe = safe.split('**').map(function(seg, idx) {
        return idx % 2 === 1 ? '<b>' + seg + '</b>' : seg;
      }).join('');
      safe = safe.split('*').map(function(seg, idx) {
        return idx % 2 === 1 ? '<i>' + seg + '</i>' : seg;
      }).join('');
      var nl = String.fromCharCode(10);
      var cr = String.fromCharCode(13);
      var literalSlashN = String.fromCharCode(92) + 'n';
      safe = safe.split(literalSlashN).join('<br>');
      safe = safe.split(cr).join('');
      safe = safe.split(nl).join('<br>');
      return safe;
    }

    // Initialize
    loadCurrentUser();
  </script>
</body>
</html>`;
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
👤 Clerk Auth:        Enabled (Live Identity + Neon PostgreSQL)
========================================================================
`);
  });

  return server;
}

// If executed directly via CLI
if (process.argv[1] && process.argv[1].includes('dev-server')) {
  startDevServer();
}
