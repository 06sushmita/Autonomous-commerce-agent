import { describe, it, expect, beforeEach } from 'vitest';
import {
  ZeptoMcpClient,
  MockMcpTransport,
  RemoteHttpMcpTransport,
  DeliveryLocation,
  QuickCommerceItem,
  QuickCommerceMcpManager,
  SwiggyMcpClient,
} from '../src/index.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';

describe('Zepto MCP Server Integration & Verification Suite', () => {
  const blrLocation: DeliveryLocation = {
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
    pincode: '560103',
    city: 'Bengaluru',
    latitude: 12.9298,
    longitude: 77.6835,
  };

  describe('1. MCP Connection and Dynamic Tool Discovery', () => {
    it('discovers tools dynamically from MCP server and generates agent plugins', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();

      // Register dynamic UCP tools as returned by live Zepto MCP server
      mockTransport.registerToolDefinition(
        {
          name: 'dev.ucp.shopping.catalog.search',
          description: 'Universal Commerce Protocol product catalog search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
        async (args) => {
          return {
            items: [
              {
                id: 'zepto_amul_butter',
                platform: 'zepto',
                merchantName: 'Zepto',
                name: 'Amul Butter 100g',
                priceCents: 5800,
                currency: 'INR',
                inStock: true,
              },
            ],
          };
        }
      );

      mockTransport.registerToolDefinition(
        {
          name: 'dev.ucp.shopping.cart.manage',
          description: 'Universal Commerce Protocol cart management',
          parameters: {
            type: 'object',
            properties: {
              items: { type: 'array' },
            },
            required: ['items'],
          },
        },
        async (args: any) => {
          return {
            cartId: 'ucp_cart_123',
            platform: 'zepto',
            merchantName: 'Zepto',
            items: args.items,
            subtotalCents: 5800,
            deliveryFeeCents: 2000,
            taxCents: 290,
            totalAmountCents: 8090,
            currency: 'INR',
            etaMinutes: 10,
            deliveryAddress: blrLocation,
            isAvailable: true,
          };
        }
      );

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      const discovered = await client.discoverTools();
      expect(discovered.length).toBe(2);
      expect(discovered.map((d) => d.name)).toContain('dev.ucp.shopping.catalog.search');
      expect(discovered.map((d) => d.name)).toContain('dev.ucp.shopping.cart.manage');

      // Verify AgentPlugins are generated dynamically from discovered tools
      const plugins = client.getAgentPlugins();
      expect(plugins.length).toBe(2);
      expect(plugins[0].name).toBe('dev.ucp.shopping.catalog.search');
      expect(typeof plugins[0].handler).toBe('function');

      // Verify searchProducts resolves dynamic catalog search tool
      const searchResults = await client.searchProducts('butter', blrLocation);
      expect(searchResults.length).toBe(1);
      expect(searchResults[0].name).toBe('Amul Butter 100g');
    });
  });

  describe('2. Authentication Failure and Expired Sessions', () => {
    it('reports clear actionable error when unauthenticated or token is expired', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();

      mockTransport.simulateError(
        'zepto_search_products',
        'Authentication failed for MCP endpoint at https://mcp.zepto.co.in/mcp: 401 Unauthorized or expired token. Run "npm run auth:zepto" to authenticate.'
      );

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      await expect(client.searchProducts('milk', blrLocation)).rejects.toThrow(
        /401 Unauthorized or expired token.*npm run auth:zepto/
      );
    });

    it('rejects live remote initialization if endpoint returns 401 Unauthorized', async () => {
      const remote = new RemoteHttpMcpTransport({
        endpoint: 'https://mcp.zepto.co.in/mcp',
        authToken: 'Bearer invalid_or_expired_token',
        timeoutMs: 5000,
      });

      await expect(remote.initialize()).rejects.toThrow(
        /401 Unauthorized or expired token/
      );
    });
  });

  describe('3. Tool Errors and Network Timeouts', () => {
    it('handles dark-store connection timeout cleanly', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();
      mockTransport.setSimulatedLatency(50);
      mockTransport.simulateError('zepto_inventory_check', 'MCP tool call "zepto_inventory_check" timed out after 15000ms.');

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      await expect(client.checkInventory('item_999')).rejects.toThrow(/timed out/);
    });

    it('propagates dark store tool errors transparently without mock masking', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();
      mockTransport.simulateError('zepto_create_cart', 'Dark store pincode 560103 temporarily unserviceable due to rain surge');

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      await expect(
        client.createCart([{ itemId: 'item_1', quantity: 1 }], blrLocation)
      ).rejects.toThrow(/rain surge/);
    });
  });

  describe('4. Item and Quantity Handling', () => {
    let client: ZeptoMcpClient;

    beforeEach(async () => {
      client = new ZeptoMcpClient(createTestZeptoTransport());
      await client.initialize();
    });

    it('correctly calculates subtotal, taxes, and fees across multiple items and quantities', async () => {
      const cart = await client.createCart(
        [
          { itemId: 'zepto_nandini_toned_milk_1l', quantity: 3 }, // 3 * ₹42 = ₹126
          { itemId: 'zepto_health_factory_brown_bread', quantity: 2 }, // 2 * ₹52 = ₹104
        ], // Subtotal = ₹230 (23000 paise)
        blrLocation
      );

      expect(cart.items.length).toBe(2);
      expect(cart.items[0].quantity).toBe(3);
      expect(cart.items[1].quantity).toBe(2);
      expect(cart.subtotalCents).toBe(23000);
      // Above ₹149 threshold -> ₹0 delivery fee
      expect(cart.deliveryFeeCents).toBe(0);
      expect(cart.taxCents).toBe(Math.round(23000 * 0.05)); // 1150 paise (₹11.50)
      expect(cart.totalAmountCents).toBe(23000 + 1150);
    });
  });

  describe('5. Cart Retrieval and Total Calculation', () => {
    let client: ZeptoMcpClient;

    beforeEach(async () => {
      client = new ZeptoMcpClient(createTestZeptoTransport());
      await client.initialize();
    });

    it('stores created cart and retrieves exact breakdown by cart ID', async () => {
      const cart = await client.createCart(
        [{ itemId: 'zepto_nandini_toned_milk_1l', quantity: 1 }],
        blrLocation
      );

      const retrieved = await client.getCart(cart.cartId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.cartId).toBe(cart.cartId);
      expect(retrieved!.items[0].itemId).toBe('zepto_nandini_toned_milk_1l');
      expect(retrieved!.totalAmountCents).toBe(cart.totalAmountCents);

      // Clearing cart
      await client.clearCart(cart.cartId);
      const afterClear = await client.getCart(cart.cartId);
      expect(afterClear).toBeNull();
    });
  });

  describe('6. User Confirmation Before Order Placement', () => {
    let client: ZeptoMcpClient;

    beforeEach(async () => {
      client = new ZeptoMcpClient(createTestZeptoTransport());
      await client.initialize();
    });

    it('rejects order placement if explicit user confirmation is not provided', async () => {
      await expect(
        client.placeOrder({
          cartId: 'cart_test_01',
          userConfirmed: false,
          paymentMethod: 'cod',
          deliveryLocation: blrLocation,
        })
      ).rejects.toThrow(/Explicit user confirmation is required before placing real Zepto order/);
    });

    it('successfully places order when explicit confirmation is given', async () => {
      const order = await client.placeOrder({
        cartId: 'cart_test_01',
        userConfirmed: true,
        paymentMethod: 'cod',
        deliveryLocation: blrLocation,
      });

      expect(order.success).toBe(true);
      expect(order.orderId).toContain('zepto_ord_');
      expect(order.etaMinutes).toBe(10);
      expect(order.receiptSummary.platform).toBe('Zepto');
    });
  });

  describe('7. Failed or Ambiguous Order Results', () => {
    it('refuses to report success when order status is pending or ambiguous', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();

      // Simulate ambiguous order response without confirmed status
      mockTransport.registerToolHandler('zepto_checkout', async () => ({
        success: false,
        status: 'pending_payment',
        message: 'Awaiting user action on UPI payment link',
      }));

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      await expect(
        client.placeOrder({
          cartId: 'cart_ambiguous',
          userConfirmed: true,
          paymentMethod: 'upi',
          deliveryLocation: blrLocation,
        })
      ).rejects.toThrow(/Zepto order placement failed or returned unconfirmed status/);
    });

    it('refuses to report success if server response lacks orderId', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();

      mockTransport.registerToolHandler('zepto_checkout', async () => ({
        success: true,
        // Missing orderId
      }));

      const client = new ZeptoMcpClient(mockTransport);
      await client.initialize();

      await expect(
        client.placeOrder({
          cartId: 'cart_missing_id',
          userConfirmed: true,
          paymentMethod: 'cod',
        })
      ).rejects.toThrow(/Zepto order placement failed or returned unconfirmed status/);
    });
  });

  describe('8. Ensuring Swiggy Integration Remains Fully Functional', () => {
    it('keeps Swiggy Instamart completely functional alongside Zepto', async () => {
      const swiggyTransport = createTestSwiggyTransport();
      const zeptoTransport = createTestZeptoTransport();

      const swiggy = new SwiggyMcpClient(swiggyTransport);
      const zepto = new ZeptoMcpClient(zeptoTransport);

      const manager = new QuickCommerceMcpManager(swiggy, zepto);
      await manager.initialize();

      // 1. Swiggy search works
      const swiggySearch = await swiggy.searchItems('milk', blrLocation);
      expect(swiggySearch.length).toBeGreaterThan(0);
      expect(swiggySearch[0].platform).toBe('swiggy_instamart');

      // 2. Zepto search works
      const zeptoSearch = await zepto.searchProducts('bread', blrLocation);
      expect(zeptoSearch.length).toBeGreaterThan(0);
      expect(zeptoSearch[0].platform).toBe('zepto');

      // 3. User explicit merchant selection routes to Zepto
      const zeptoOnly = await manager.compareAndAssembleBasket(
        [{ name: 'bread', quantity: 1 }],
        blrLocation,
        'zepto'
      );
      expect(zeptoOnly.recommendedProposal.platform).toBe('zepto');
      expect(zeptoOnly.recommendationReason).toContain('explicitly selected Zepto');

      // 4. User explicit merchant selection routes to Swiggy
      const swiggyOnly = await manager.compareAndAssembleBasket(
        [{ name: 'milk', quantity: 1 }],
        blrLocation,
        'swiggy'
      );
      expect(swiggyOnly.recommendedProposal.platform).toBe('swiggy_instamart');
      expect(swiggyOnly.recommendationReason).toContain('explicitly selected Swiggy');
    });
  });
});
