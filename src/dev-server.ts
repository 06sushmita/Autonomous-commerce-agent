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
} from './index.js';

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
      const user = authProvider.getActiveUser();
      const spend = spendTracker.getUserSpendProfile(user.id, user.dailySpendLimitCents);
      const { password, ...safeUser } = user;
      return sendJson(200, {
        user: safeUser,
        remainingSpendINR: (spend.remainingDailySpendCents / 100).toFixed(2),
      });
    }

    // 3. Authentication: List Known Users (for quick preset switching)
    if (method === 'GET' && url.pathname === '/api/auth/users') {
      const users = authProvider.listUsers();
      return sendJson(200, { users });
    }

    // 4. Authentication: Log In
    if (method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson();
      const { emailOrPhone, password } = body;
      if (!emailOrPhone) {
        return sendJson(400, { error: 'Email or phone number is required.' });
      }
      try {
        const user = authProvider.loginUser(emailOrPhone, password);
        const { password: _, ...safeUser } = user;
        return sendJson(200, { success: true, user: safeUser });
      } catch (e: any) {
        return sendJson(401, { error: e.message || 'Login failed.' });
      }
    }

    // 5. Authentication: Sign Up
    if (method === 'POST' && url.pathname === '/api/auth/signup') {
      const body = await readJson();
      try {
        const newUser = authProvider.registerUser({
          displayName: body.displayName,
          email: body.email,
          phone: body.phone,
          password: body.password,
          address: body.address,
          pincode: body.pincode,
          dailySpendLimitINR: body.dailySpendLimitINR ? parseFloat(body.dailySpendLimitINR) : 5000,
        });
        const { password: _, ...safeUser } = newUser;
        return sendJson(201, { success: true, user: safeUser });
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
        return sendJson(200, { success: true, user: safeUser });
      } catch (e: any) {
        return sendJson(404, { error: e.message });
      }
    }

    // 7. Real-Time Chatbot Endpoint (Natural Language -> Live Swiggy + Zepto Fetch -> Mandate)
    if (method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson();
      const query = (body.message || body.query || 'milk').trim();
      const user = body.userId
        ? await authProvider.getAuthenticatedUser(body.userId)
        : authProvider.getActiveUser();

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
        turn = await autonomousCommerceRunner.processShoppingTurn(sessionId, query);
      } catch (err: any) {
        errorMsg = err.message;
      }

      // Ensure all items have official product links
      const swiggyItems = searchResults.swiggyItems.map((item) => ({
        ...item,
        productUrl:
          item.productUrl ||
          `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(item.name)}`,
      }));

      const zeptoItems = searchResults.zeptoItems.map((item) => ({
        ...item,
        productUrl:
          item.productUrl ||
          `https://www.zeptonow.com/search?q=${encodeURIComponent(item.name)}`,
      }));

      // Determine the single best choice item
      const bestItem =
        turn?.proposal?.bestItem ||
        (turn?.proposal?.items?.[0]
          ? {
              id: turn.proposal.items[0].itemId,
              name: turn.proposal.items[0].name,
              platform: turn.proposal.platform,
              merchantName: turn.proposal.merchantName,
              priceCents: turn.proposal.items[0].unitPriceCents,
              mrpCents: turn.proposal.items[0].mrpCents,
              imageUrl: turn.proposal.items[0].imageUrl,
              productUrl: turn.proposal.items[0].productUrl,
              unit: turn.proposal.items[0].unit,
              brand: turn.proposal.items[0].brand,
              etaMinutes: turn.proposal.etaMinutes,
            }
          : undefined) ||
        swiggyItems[0] ||
        zeptoItems[0];

      if (bestItem && !bestItem.productUrl) {
        bestItem.productUrl =
          bestItem.platform === 'zepto'
            ? `https://www.zeptonow.com/search?q=${encodeURIComponent(bestItem.name)}`
            : `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(bestItem.name)}`;
      }

      if (turn?.proposal) {
        turn.proposal.bestItem = bestItem;
      }

      // Format clean, conversational AI response
      const swiggyCount = swiggyItems.length;
      const zeptoCount = zeptoItems.length;

      let reply = `I searched both **Swiggy Instamart** and **Zepto** in real time for **"${query}"** for delivery to **${user.defaultAddress}**.\n\n`;

      if (swiggyCount > 0 || zeptoCount > 0) {
        reply += `Found **${swiggyCount} live items on Swiggy** and **${zeptoCount} live items on Zepto**.\n`;
      }

      if (turn && turn.proposal) {
        const titleStr = bestItem ? `**${bestItem.name}**` : 'Selected Items';
        reply += `\n⭐ **Agent's Top Choice:** ${titleStr}\n`;
        reply += `💡 **Reason:** ${turn.recommendationReason}\n`;
        reply += `Total payable is **₹${(turn.proposal.totalAmountCents / 100).toFixed(2)}** with an estimated delivery time of **${turn.proposal.etaMinutes} minutes**.\n\n`;
        reply += `Please review the spotlight top choice below and authorize on behalf of **${user.displayName}** using your Biometric Passkey.`;
      } else if (errorMsg) {
        reply += `\n⚠️ Note: ${errorMsg}`;
      }

      return sendJson(200, {
        reply,
        sessionId,
        swiggyItems,
        zeptoItems,
        bestItem,
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
      const { sessionId, mandateId } = body;
      const user = authProvider.getActiveUser();

      if (!sessionId || !mandateId) {
        return sendJson(400, { error: 'Missing sessionId or mandateId' });
      }

      const result = await autonomousCommerceRunner.authorizeAndExecuteCheckout(
        sessionId,
        mandateId,
        {
          mandateId,
          challengeId: body.challengeId || 'prava_chal_live',
          clientDataJSON: Buffer.from('prava_fido2_client_data').toString('base64url'),
          authenticatorData: Buffer.from('prava_fido2_auth_data').toString('base64url'),
          signature: body.signature || 'prava_biometric_passkey_sig',
        }
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

    <button class="user-profile-btn" onclick="openAuthModal()">
      <div class="user-avatar" id="navAvatar">SM</div>
      <div class="user-info">
        <div class="user-name" id="navUserName">Sushmita Mishra <span style="font-size:10px;">▼</span></div>
        <div class="user-loc" id="navUserLoc">📍 Dombivli West (421202)</div>
      </div>
    </button>
  </header>

  <!-- Main Content Layout -->
  <div class="main-layout">
    <!-- Active Context Info -->
    <div class="context-banner">
      <div class="context-left">
        <span>👤 Ordering on behalf of: <b id="bannerUserName">Sushmita Mishra</b></span>
        <span>•</span>
        <span>📍 Delivery: <b id="bannerUserAddress">A/30, Sai Anant Darshan, Dombivli West (421202)</b></span>
        <span>•</span>
        <span>🛡️ Limit: <b id="bannerUserLimit">₹5,000.00 / day</b></span>
      </div>
      <button class="btn-auth-switch" onclick="openAuthModal()">Switch / Sign Up</button>
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
          <span class="chip" onclick="quickSend('Maggi Hot & Sweet Chilli Tomato Sauce')">🥫 Maggi Sauce</span>
          <span class="chip" onclick="quickSend('Find me 1L Nandini milk and brown bread in under 15 mins')">🥛 1L Milk & Bread</span>
          <span class="chip" onclick="quickSend('Search Amul butter and eggs')">🧈 Amul Butter & Eggs</span>
          <span class="chip" onclick="quickSend('Compare Swiggy vs Zepto for milk')">⚡ Compare Swiggy vs Zepto</span>
          <span class="chip" onclick="quickSend('Find Maggi noodles and Coke')">🍜 Maggi & Coke</span>
        </div>
        <div class="input-wrapper">
          <input type="text" id="userInput" class="chat-input" placeholder="Search groceries or order items (e.g. 'Maggi sauce', '1L milk', 'Amul butter')..." onkeydown="if(event.key==='Enter') sendMessage()">
          <button class="btn-send" id="sendBtn" onclick="sendMessage()">Send ➔</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Auth Modal (Login & Sign Up) -->
  <div class="modal-overlay" id="authModal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>User Account & Delivery Profile</h2>
        <button class="modal-close" onclick="closeAuthModal()">✕</button>
      </div>

      <div class="modal-tabs">
        <button class="tab-btn active" id="tabLoginBtn" onclick="switchAuthTab('login')">Log In</button>
        <button class="tab-btn" id="tabSignupBtn" onclick="switchAuthTab('signup')">Sign Up (New User)</button>
      </div>

      <!-- Log In Form -->
      <div class="modal-body" id="loginTab">
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Select a verified profile or enter your credentials. The autonomous agent will order using this user's dark store address and spending limit.
        </p>

        <div style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px;">Quick Presets:</div>
        <div class="quick-preset-cards">
          <div class="preset-card" onclick="quickLogin('sushmita.mishra@example.com', 'password123')">
            <div class="preset-name">Sushmita Mishra</div>
            <div class="preset-loc">📍 Dombivli West (421202)</div>
            <div style="font-size: 10px; color: #10b981; margin-top: 4px;">✓ Swiggy Verified</div>
          </div>
          <div class="preset-card" onclick="quickLogin('arjun.sharma@example.com', 'password123')">
            <div class="preset-name">Arjun Sharma</div>
            <div class="preset-loc">📍 Bellandur, Bengaluru (560103)</div>
            <div style="font-size: 10px; color: #3b82f6; margin-top: 4px;">✓ Bengaluru Profile</div>
          </div>
        </div>

        <div class="form-group">
          <label>Email or Mobile Number</label>
          <input type="text" id="loginEmail" placeholder="sushmita.mishra@example.com or 9820002845">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="loginPassword" placeholder="••••••••" value="password123">
        </div>
        <button class="btn-submit" onclick="submitLogin()">Log In & Set Active User</button>
      </div>

      <!-- Sign Up Form -->
      <div class="modal-body" id="signupTab" style="display: none;">
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" id="signupName" placeholder="e.g. Priya Patel">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label>Email Address</label>
            <input type="email" id="signupEmail" placeholder="priya@example.com">
          </div>
          <div class="form-group">
            <label>Indian Mobile (+91)</label>
            <input type="tel" id="signupPhone" placeholder="98XXXXXXXX">
          </div>
        </div>
        <div class="form-group">
          <label>Delivery Address (Building, Street, Area)</label>
          <input type="text" id="signupAddress" placeholder="Flat 204, Galaxy Heights, Powai, Mumbai">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label>Pincode</label>
            <input type="text" id="signupPincode" placeholder="400076">
          </div>
          <div class="form-group">
            <label>Daily Spend Limit (₹)</label>
            <input type="number" id="signupLimit" value="5000">
          </div>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="signupPassword" placeholder="Create a password" value="password123">
        </div>
        <button class="btn-submit" onclick="submitSignup()">Create Account & Start Ordering</button>
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

    // Load initial user
    async function loadCurrentUser() {
      try {
        const res = await fetch('/api/auth/current');
        const data = await res.json();
        if (data.user) {
          setUserUI(data.user);
        }
      } catch (e) {
        console.error('Failed to load user:', e);
      }
    }

    function setUserUI(user) {
      activeUser = user;
      const initials = user.displayName
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);

      document.getElementById('navAvatar').textContent = initials;
      document.getElementById('navUserName').innerHTML = user.displayName + ' <span style="font-size:10px;">▼</span>';
      document.getElementById('navUserLoc').textContent = '📍 ' + (user.defaultPincode || 'India');

      document.getElementById('bannerUserName').textContent = user.displayName;
      document.getElementById('bannerUserAddress').textContent = user.defaultAddress + ' (' + user.defaultPincode + ')';
      document.getElementById('bannerUserLimit').textContent = '₹' + ((user.dailySpendLimitCents || 500000) / 100).toFixed(2) + ' / day';
    }

    function openAuthModal() {
      document.getElementById('authModal').style.display = 'flex';
    }
    function closeAuthModal() {
      document.getElementById('authModal').style.display = 'none';
    }

    function switchAuthTab(tab) {
      if (tab === 'login') {
        document.getElementById('loginTab').style.display = 'block';
        document.getElementById('signupTab').style.display = 'none';
        document.getElementById('tabLoginBtn').classList.add('active');
        document.getElementById('tabSignupBtn').classList.remove('active');
      } else {
        document.getElementById('loginTab').style.display = 'none';
        document.getElementById('signupTab').style.display = 'block';
        document.getElementById('tabSignupBtn').classList.add('active');
        document.getElementById('tabLoginBtn').classList.remove('active');
      }
    }

    async function quickLogin(email, password) {
      document.getElementById('loginEmail').value = email;
      document.getElementById('loginPassword').value = password;
      await submitLogin();
    }

    async function submitLogin() {
      const emailOrPhone = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value.trim();
      if (!emailOrPhone) {
        alert('Please enter your email or phone number');
        return;
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
          appendAgentMessage('Switched active user to **' + data.user.displayName + '**. Any new orders will be delivered to **' + data.user.defaultAddress + ' (' + data.user.defaultPincode + ')**.');
        } else {
          alert(data.error || 'Login failed');
        }
      } catch (e) {
        alert('Login request failed: ' + e.message);
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

      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, email, phone, address, pincode, dailySpendLimitINR: limit, password })
        });
        const data = await res.json();
        if (data.success && data.user) {
          setUserUI(data.user);
          closeAuthModal();
          appendAgentMessage('Welcome **' + data.user.displayName + '**! Your account has been registered with delivery address **' + data.user.defaultAddress + ' (' + data.user.defaultPincode + ')**. Tell me what you would like to order!');
        } else {
          alert(data.error || 'Registration failed');
        }
      } catch (e) {
        alert('Sign up request failed: ' + e.message);
      }
    }

    function quickSend(text) {
      document.getElementById('userInput').value = text;
      sendMessage();
    }

    async function sendMessage() {
      const input = document.getElementById('userInput');
      const text = input.value.trim();
      if (!text) return;

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
      const best = data.bestItem || (data.proposal && data.proposal.bestItem) || allItems[0];

      // 1. RENDER "THE ONE BEST CHOICE" SPOTLIGHT HERO CARD
      if (best && data.proposal) {
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
        html += '<span style="border: 1px solid ' + platformColor + '; color: ' + platformColor + '; background: rgba(0,0,0,0.3); font-size:11px; padding:3px 10px; border-radius:12px; font-weight:700; display:inline-flex; align-items:center; gap:6px;">';
        html += '<span class="status-dot" style="background:' + platformColor + ';"></span> ' + platformName;
        html += '</span>';
        html += '<span class="eta-badge" style="background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); font-weight:700;">⚡ ' + eta + ' MINS DELIVERY</span>';
        html += '</div>';

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
        html += '</div>';

        html += '<div class="best-choice-links-row">';
        html += '<a href="' + productUrl + '" id="bestHeroLink_' + data.sessionId + '" target="_blank" rel="noopener noreferrer" class="btn-product-external">';
        html += '🔗 View Product on ' + platformName + ' ↗';
        html += '</a>';
        html += '</div>';

        html += '<div class="best-choice-reason" id="bestHeroReason_' + data.sessionId + '">';
        html += '💡 <b>Why this is your best choice:</b> ' + escapeHtml(data.recommendationReason || 'Optimal combination of dark store availability, lowest price, and fastest guaranteed ETA.');
        html += '</div>';

        html += '</div>'; // end best-choice-info
        html += '</div>'; // end best-choice-body

        // Bottom Breakdown & Biometric Authorization
        html += '<div class="best-choice-footer">';
        html += '<div class="proposal-breakdown" style="margin-bottom:10px;">';
        html += '<span>Delivering on behalf of: <b>' + escapeHtml(data.user.displayName) + '</b> (' + data.user.pincode + ')</span>';
        html += '<span style="font-size:15px;">Total Payable: <b id="bestHeroTotal_' + data.sessionId + '" style="color:#10b981;">₹' + total + '</b></span>';
        html += '</div>';

        html += '<button class="btn-passkey" id="passkeyBtn_' + data.sessionId + '" data-session="' + data.sessionId + '" data-mandate="' + data.mandateBundle.mandateId + '" data-challenge="' + data.mandateBundle.challenge.challengeId + '" data-amount="' + prop.totalAmountCents + '" onclick="triggerPasskeyFromBtn(this)">';
        html += '🔒 Authorize ₹' + total + ' with Biometric Passkey (Touch ID / Face ID)';
        html += '</button>';
        html += '</div>'; // end best-choice-footer

        html += '</div>'; // end best-choice-card
      }

      // 2. RENDER ALTERNATIVE OPTIONS SECTION WITH OFFICIAL LINKS
      if (allItems.length > 0) {
        html += '<div class="alt-options-section">';
        html += '<div class="alt-options-header">';
        html += '<span>📦 All Matching Products & Sizes (' + allItems.length + ')</span>';
        html += '<span style="font-size:11px; color:var(--text-muted);">Click "Select" to make any item your best choice</span>';
        html += '</div>';

        html += '<div class="product-cards-row">';
        for (let idx = 0; idx < allItems.length; idx++) {
          const item = allItems[idx];
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
      if (totalEl) totalEl.textContent = '₹' + priceStr;
      if (reasonEl) {
        reasonEl.innerHTML = '💡 <b>Selected by You:</b> Switched to <b>' + escapeHtml(selected.name) + '</b> from ' + platformName + ' with live dark store dispatch.';
      }
      if (linkEl && selected.productUrl) {
        linkEl.href = selected.productUrl;
        linkEl.textContent = '🔗 View Product on ' + platformName + ' ↗';
      }
      if (passkeyBtn) {
        passkeyBtn.setAttribute('data-amount', selected.priceCents);
        passkeyBtn.innerHTML = '🔒 Authorize ₹' + priceStr + ' with Biometric Passkey (Touch ID / Face ID)';
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
      const sessionId = btn.getAttribute('data-session');
      const mandateId = btn.getAttribute('data-mandate');
      const challengeId = btn.getAttribute('data-challenge');
      const totalCents = parseInt(btn.getAttribute('data-amount') || '0', 10);
      triggerPasskeyCheckout(sessionId, mandateId, challengeId, totalCents);
    }

    async function triggerPasskeyCheckout(sessionId, mandateId, challengeId, totalCents) {
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
              signature: 'prava_fido2_biometric_verified_sig_' + Date.now()
            })
          });

          dialog.style.display = 'none';
          const checkoutData = await res.json();

          if (checkoutData.success) {
            renderOrderReceipt(checkoutData);
          } else {
            alert('Checkout failed: ' + (checkoutData.error || 'Unknown error'));
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
      const total = ((order.totalAmountCents || 5400) / 100).toFixed(2);
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
  authProvider.seedUser({ ...SUSHMITA_USER });
  authProvider.setActiveUser(SUSHMITA_USER.id);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`Internal Server Error: ${String(err)}`);
    });
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
👤 Active User:       Sushmita Mishra (Dombivli West 421202)
========================================================================
`);
  });

  return server;
}

// If executed directly via CLI
if (process.argv[1] && process.argv[1].includes('dev-server')) {
  startDevServer();
}
