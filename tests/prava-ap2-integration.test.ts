/**
 * Prava AP2 Payment Layer Integration Test Suite
 *
 * Verifies:
 * 1. Prava v1 Session Creation (POST /v1/sessions)
 * 2. Prava Payment Result Polling (GET /v1/sessions/:id/payment-result)
 * 3. Status Reporting loop (POST /v1/sessions/:id/report-status -> APPROVED/DECLINED)
 * 4. Dev Server Endpoints:
 *    - GET /prava-sdk.js (Serves @prava-sdk/core client library)
 *    - POST /api/prava/create-session
 *    - POST /api/prava/execute-order
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PravaPaymentsClient,
  MockPravaPaymentsClient,
  getPravaClient,
  setPravaClient,
  resetPravaClient,
} from '../src/prava/client.js';
import { authProvider, ARJUN_USER } from '../src/auth/index.js';
import { AutonomousCommerceRunner } from '../src/agent/runner.js';
import { quickCommerceMcpManager } from '../src/mcp/mcp-manager.js';
import { SwiggyMcpClient } from '../src/mcp/swiggy-mcp.js';
import { ZeptoMcpClient } from '../src/mcp/zepto-mcp.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';
import { startDevServer } from '../src/dev-server.js';
import type { Server } from 'node:http';

describe('Prava AP2 Payment Layer Integration Suite', () => {
  let runner: AutonomousCommerceRunner;
  let server: Server;
  const testPort = 3915;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  beforeEach(() => {
    resetPravaClient();
    authProvider.reset();
    authProvider.seedVerifiedClerkProfiles();

    quickCommerceMcpManager.setClients(
      new SwiggyMcpClient(createTestSwiggyTransport()),
      new ZeptoMcpClient(createTestZeptoTransport())
    );

    runner = new AutonomousCommerceRunner();
    server = startDevServer(testPort);
  });

  afterEach(() => {
    server.close();
    resetPravaClient();
  });

  describe('1. Prava Client Core Lifecycle', () => {
    it('creates Prava session with structured cart items and returns iframeUrl', async () => {
      const client = getPravaClient();
      const session = await client.createPravaSession({
        userId: ARJUN_USER.id,
        userEmail: ARJUN_USER.email,
        merchantName: 'Zepto',
        totalAmount: 42.0,
        mcpCartId: 'cart_test_123',
        items: [{ name: 'Amul Milk 1L', quantity: 1, price: 42.0 }],
      });

      expect(session.session_id).toBeDefined();
      expect(session.session_token).toBeDefined();
      expect(session.iframe_url).toContain('prava.space');
    });

    it('polls payment result and receives minted credentials', async () => {
      const client = getPravaClient();
      const credentials = await client.pollPravaPaymentResult('ses_test_polling_123');

      expect(credentials.token).toBeDefined();
      expect(credentials.txnRefId).toBeDefined();
      expect(credentials.status).toBe('awaiting_result');
    });

    it('reports downstream transaction status back to Prava', async () => {
      const client = getPravaClient();
      const approved = await client.reportPravaTransactionStatus(
        'ses_test_123',
        'txn_ref_test_456',
        'APPROVED'
      );
      expect(approved).toBe(true);

      const declined = await client.reportPravaTransactionStatus(
        'ses_test_123',
        'txn_ref_test_456',
        'DECLINED'
      );
      expect(declined).toBe(true);
    });
  });

  describe('2. HTTP Endpoints for Prava AP2 Gateway', () => {
    it('serves /prava-sdk.js with JavaScript MIME type', async () => {
      const res = await fetch(`${baseUrl}/prava-sdk.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');
      const text = await res.text();
      expect(text).toContain('PravaSDK');
    });

    it('POST /api/prava/create-session initializes payment container', async () => {
      const res = await fetch(`${baseUrl}/api/prava/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ARJUN_USER.id,
          merchantName: 'Zepto',
          totalAmount: 29.26,
          items: [{ name: 'Milk 500ml', quantity: 1, price: 29.26 }],
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.sessionId).toBeDefined();
      expect(json.sessionToken).toBeDefined();
      expect(json.iframeUrl).toBeDefined();
      expect(json.publishableKey).toBeDefined();
    });

    it('POST /api/prava/create-session rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/prava/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'guest',
          totalAmount: 50.0,
        }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.requiresAuth).toBe(true);
    });

    it('completes the full end-to-end checkout loop via execute-order', async () => {
      // 1. Initialize shopping session & turn
      const session = await runner.initializeSession(ARJUN_USER.id);
      const turn = await runner.processShoppingTurn(
        session.sessionId,
        'order milk from zepto',
        { confirmed: true }
      );
      expect(turn.mandateBundle).toBeDefined();

      // 2. Create Prava session
      const createRes = await fetch(`${baseUrl}/api/prava/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: ARJUN_USER.id,
          sessionId: session.sessionId,
          mandateId: turn.mandateBundle!.mandateId,
          merchantName: 'Zepto',
          totalAmountCents: turn.mandateBundle!.amountCents,
        }),
      });
      const createData = (await createRes.json()) as any;
      expect(createData.success).toBe(true);

      // 3. Execute order using the Prava session
      const execRes = await runner.executePravaOrderCheckout(
        session.sessionId,
        createData.sessionId,
        turn.mandateBundle!.mandateId,
        ARJUN_USER.id
      );

      expect(execRes.success).toBe(true);
      expect(execRes.pravaTokenRef).toBeDefined();
      expect(execRes.txnRefId).toBeDefined();
      expect(execRes.order).toBeDefined();
      expect(execRes.order.orderId).toBeDefined();
    });
  });
});

