import { describe, it, expect, beforeEach } from 'vitest';
import {
  SwiggyMcpClient,
  ZeptoMcpClient,
  QuickCommerceMcpManager,
  MockMcpTransport,
  RemoteHttpMcpTransport,
  StdioMcpTransport,
  McpTransportFactory,
  DeliveryLocation,
} from '../src/index.js';
import { createTestSwiggyTransport, createTestZeptoTransport } from './fixtures/test-mcp-transports.js';
import * as libMcp from '../lib/mcp/mcp-manager.js';
import * as libSwiggy from '../lib/mcp/swiggy-mcp.js';
import * as libZepto from '../lib/mcp/zepto-mcp.js';
import * as libTransport from '../lib/mcp/transport.js';

describe('Phase 3: Modular Swiggy & Zepto MCP Clients', () => {
  const blrLocation: DeliveryLocation = {
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
    pincode: '560103',
    city: 'Bengaluru',
    latitude: 12.9298,
    longitude: 77.6835,
  };

  describe('1. Modular MCP Transport Layer', () => {
    it('initializes and executes tool calls on MockMcpTransport', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();

      expect(mockTransport.isConnected()).toBe(true);
      expect(mockTransport.getTransportType()).toBe('mock');

      mockTransport.registerToolHandler('echo_test', async (args) => {
        return { echoed: args.message };
      });

      const tools = await mockTransport.listTools();
      expect(tools).toContain('echo_test');

      const result = await mockTransport.callTool<{ echoed: string }>('echo_test', {
        message: 'hello quick commerce',
      });
      expect(result.echoed).toBe('hello quick commerce');
    });

    it('simulates error conditions in MockMcpTransport for resilience testing', async () => {
      const mockTransport = new MockMcpTransport();
      await mockTransport.initialize();
      mockTransport.registerToolHandler('flaky_tool', async () => ({ ok: true }));

      mockTransport.simulateError('flaky_tool', 'Dark store connection reset by peer');

      await expect(mockTransport.callTool('flaky_tool', {})).rejects.toThrow(
        'Dark store connection reset by peer'
      );

      mockTransport.clearSimulatedError('flaky_tool');
      const recovered = await mockTransport.callTool<{ ok: boolean }>('flaky_tool', {});
      expect(recovered.ok).toBe(true);
    });

    it('instantiates StdioMcpTransport with command configuration', () => {
      const stdio = new StdioMcpTransport({
        command: 'node',
        args: ['-v'],
      });
      expect(stdio.getTransportType()).toBe('stdio');
      expect(stdio.isConnected()).toBe(false);
    });

    it('creates appropriate transport via McpTransportFactory', () => {
      const mock = McpTransportFactory.createTransport({ mode: 'mock' });
      expect(mock.getTransportType()).toBe('mock');

      const stdio = McpTransportFactory.createTransport({
        mode: 'stdio',
        command: 'node',
      });
      expect(stdio.getTransportType()).toBe('stdio');

      const fallback = McpTransportFactory.createTransport({
        endpoint: 'https://placeholder.endpoint.local',
      });
      expect(fallback.getTransportType()).toBe('mock');
    });
  });

  describe('2. Swiggy MCP Client (swiggy-mcp.ts)', () => {
    let swiggy: SwiggyMcpClient;

    beforeEach(async () => {
      swiggy = new SwiggyMcpClient(createTestSwiggyTransport());
      await swiggy.initialize();
    });

    it('strictly enforces real-time live connection and rejects stored mock data when no transport is provided', async () => {
      const liveClient = new SwiggyMcpClient();
      await expect(liveClient.searchItems('milk')).rejects.toThrow(
        /Real-time Swiggy MCP connection unavailable/
      );
    });

    it('searches Swiggy Instamart catalog with location context', async () => {
      const items = await swiggy.searchItems('milk', blrLocation);
      expect(items.length).toBeGreaterThan(0);
      const milk = items[0];
      expect(milk.platform).toBe('swiggy_instamart');
      expect(milk.name).toContain('Nandini');
      expect(milk.priceCents).toBe(4200); // ₹42.00
      expect(milk.currency).toBe('INR');
      expect(milk.inStock).toBe(true);
    });

    it('fetches detailed item specifications including nutrition and FSSAI license', async () => {
      const details = await swiggy.getItemDetails('swiggy_im_nandini_milk_1l');
      expect(details).toBeDefined();
      expect(details!.brand).toBe('Nandini (KMF)');
      expect(details!.shelfLifeDays).toBe(2);
      expect(details!.packSize).toBe('1000 ml pouch');
      expect(details!.nutritionalInfo).toBeDefined();
      expect(details!.nutritionalInfo!['Protein']).toBe('3.1 g');
      expect(details!.countryOfOrigin).toBe('India');
      expect(details!.fssaiLicense).toBe('10012043000058');
    });

    it('calculates delivery estimate and checks dark store feasibility', async () => {
      const estimate = await swiggy.getDeliveryEstimate(blrLocation);
      expect(estimate.serviceable).toBe(true);
      expect(estimate.platform).toBe('swiggy_instamart');
      expect(estimate.pincode).toBe('560103');
      expect(estimate.etaMinutes).toBe(14);
      expect(estimate.deliveryFeeCents).toBe(2500); // ₹25 standard fee
      expect(estimate.freeDeliveryThresholdCents).toBe(19900); // ₹199 threshold
      expect(estimate.darkStoreName).toContain('Swiggy Instamart Pod');
    });

    it('assembles cart with 5% GST and conditional free delivery above ₹199', async () => {
      // 1. Small cart below ₹199 -> incurs ₹25 delivery fee
      const smallCart = await swiggy.createCart(
        [{ itemId: 'swiggy_im_nandini_milk_1l', quantity: 2 }], // 2 * ₹42 = ₹84 (8400 paise)
        blrLocation
      );
      expect(smallCart.subtotalCents).toBe(8400);
      expect(smallCart.deliveryFeeCents).toBe(2500); // ₹25
      expect(smallCart.taxCents).toBe(Math.round(8400 * 0.05)); // 420 paise (₹4.20)
      expect(smallCart.totalAmountCents).toBe(8400 + 2500 + 420); // 11320 paise (₹113.20)

      // 2. Large cart above ₹199 -> free delivery (₹0)
      const largeCart = await swiggy.createCart(
        [
          { itemId: 'swiggy_im_nandini_milk_1l', quantity: 4 }, // ₹168
          { itemId: 'swiggy_im_amul_butter_100g', quantity: 1 }, // ₹58
        ], // subtotal = ₹226 (22600 paise)
        blrLocation
      );
      expect(largeCart.subtotalCents).toBe(22600);
      expect(largeCart.deliveryFeeCents).toBe(0); // Free delivery
      expect(largeCart.totalAmountCents).toBe(22600 + Math.round(22600 * 0.05));
    });

    it('supports cart updates and fetching cart by ID', async () => {
      const cart = await swiggy.createCart(
        [{ itemId: 'swiggy_im_britannia_brown_bread', quantity: 1 }],
        blrLocation
      );
      const fetched = await swiggy.getCart(cart.cartId);
      expect(fetched).toBeDefined();
      expect(fetched!.cartId).toBe(cart.cartId);

      const updated = await swiggy.updateCart(
        cart.cartId,
        [{ itemId: 'swiggy_im_britannia_brown_bread', quantity: 3 }],
        blrLocation
      );
      expect(updated.items[0].quantity).toBe(3);
    });

    it('executes checkout using single-use Prava payment token', async () => {
      const cart = await swiggy.createCart(
        [{ itemId: 'swiggy_im_nandini_milk_1l', quantity: 1 }],
        blrLocation
      );
      const result = await swiggy.executeCheckout(cart.cartId, 'prv_tok_mock_swiggy_01');
      expect(result.success).toBe(true);
      expect(result.orderId).toContain('swiggy_ord_');
      expect(result.trackingUrl).toContain('swiggy.com/orders/');
      expect(result.receiptSummary.platform).toBe('Swiggy Instamart');
    });

    it('rejects checkout without payment token', async () => {
      await expect(swiggy.executeCheckout('cart_test', '')).rejects.toThrow(
        'valid single-use Prava payment token'
      );
    });

    it('exposes valid MCP tool definitions and AgentPlugins for ShoppingAgent', () => {
      const defs = swiggy.getToolDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(5);
      const toolNames = defs.map((d) => d.name);
      expect(toolNames).toContain('swiggy_im_search_items');
      expect(toolNames).toContain('swiggy_im_get_item_details');
      expect(toolNames).toContain('swiggy_im_delivery_estimate');
      expect(toolNames).toContain('swiggy_im_create_cart');
      expect(toolNames).toContain('swiggy_im_checkout');

      const plugins = swiggy.getAgentPlugins();
      expect(plugins.length).toBe(defs.length);
      expect(typeof plugins[0].handler).toBe('function');
    });
  });

  describe('3. Zepto MCP Client (zepto-mcp.ts)', () => {
    let zepto: ZeptoMcpClient;

    beforeEach(async () => {
      zepto = new ZeptoMcpClient(createTestZeptoTransport());
      await zepto.initialize();
    });

    it('strictly enforces real-time live connection and rejects stored mock data when no transport is provided', async () => {
      const liveClient = new ZeptoMcpClient();
      await expect(liveClient.searchProducts('bread')).rejects.toThrow(
        /Real-time Zepto MCP connection unavailable/
      );
    });

    it('searches Zepto dark-store catalog', async () => {
      const items = await zepto.searchProducts('bread', blrLocation);
      expect(items.length).toBeGreaterThan(0);
      const bread = items[0];
      expect(bread.platform).toBe('zepto');
      expect(bread.name).toContain('The Health Factory');
      expect(bread.priceCents).toBe(5200); // ₹52.00
      expect(bread.currency).toBe('INR');
      expect(bread.inStock).toBe(true);
    });

    it('verifies real-time dark store stock levels with inventory check', async () => {
      const inStockCheck = await zepto.checkInventory('zepto_nandini_toned_milk_1l', 2);
      expect(inStockCheck.inStock).toBe(true);
      expect(inStockCheck.availableQuantity).toBeGreaterThanOrEqual(2);
      expect(inStockCheck.lowStockWarning).toBe(false);

      const nonExistent = await zepto.checkInventory('zepto_item_unknown', 1);
      expect(nonExistent.inStock).toBe(false);
      expect(nonExistent.availableQuantity).toBe(0);
    });

    it('computes 10-minute delivery estimate and ₹149 free delivery threshold', async () => {
      const estimate = await zepto.getDeliveryEstimate(blrLocation);
      expect(estimate.serviceable).toBe(true);
      expect(estimate.platform).toBe('zepto');
      expect(estimate.etaMinutes).toBe(10); // Zepto 10-minute guarantee
      expect(estimate.deliveryFeeCents).toBe(2000); // ₹20 standard fee
      expect(estimate.freeDeliveryThresholdCents).toBe(14900); // ₹149 threshold
      expect(estimate.darkStoreName).toContain('Zepto Dark Store');
    });

    it('assembles cart with 5% GST and conditional free delivery above ₹149', async () => {
      // 1. Below ₹149 -> ₹20 delivery fee
      const smallCart = await zepto.createCart(
        [{ itemId: 'zepto_nandini_toned_milk_1l', quantity: 2 }], // 2 * ₹42 = ₹84
        blrLocation
      );
      expect(smallCart.subtotalCents).toBe(8400);
      expect(smallCart.deliveryFeeCents).toBe(2000);
      expect(smallCart.totalAmountCents).toBe(8400 + 2000 + Math.round(8400 * 0.05));
      expect(smallCart.etaMinutes).toBe(10);

      // 2. Above ₹149 -> ₹0 delivery fee
      const largeCart = await zepto.createCart(
        [
          { itemId: 'zepto_nandini_toned_milk_1l', quantity: 2 }, // ₹84
          { itemId: 'zepto_eggoz_farm_eggs_6', quantity: 1 }, // ₹54
          { itemId: 'zepto_amul_butter_100g', quantity: 1 }, // ₹57
        ], // ₹195
        blrLocation
      );
      expect(largeCart.subtotalCents).toBe(19500);
      expect(largeCart.deliveryFeeCents).toBe(0);
      expect(largeCart.totalAmountCents).toBe(19500 + Math.round(19500 * 0.05));
    });

    it('executes checkout session using Prava single-use token', async () => {
      const cart = await zepto.createCart(
        [{ itemId: 'zepto_nandini_toned_milk_1l', quantity: 1 }],
        blrLocation
      );
      const checkout = await zepto.executeCheckout(cart.cartId, 'prv_tok_mock_zepto_01');
      expect(checkout.success).toBe(true);
      expect(checkout.orderId).toContain('zepto_ord_');
      expect(checkout.trackingUrl).toContain('zeptonow.com/order/');
      expect(checkout.etaMinutes).toBe(10);
      expect(checkout.receiptSummary.platform).toBe('Zepto');
    });

    it('exposes valid MCP tool definitions and AgentPlugins for ShoppingAgent', () => {
      const defs = zepto.getToolDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(5);
      const names = defs.map((d) => d.name);
      expect(names).toContain('zepto_search_products');
      expect(names).toContain('zepto_inventory_check');
      expect(names).toContain('zepto_delivery_estimate');
      expect(names).toContain('zepto_create_cart');
      expect(names).toContain('zepto_checkout');

      const plugins = zepto.getAgentPlugins();
      expect(plugins.length).toBe(defs.length);
    });
  });

  describe('4. Quick-Commerce MCP Manager (mcp-manager.ts)', () => {
    let manager: QuickCommerceMcpManager;

    beforeEach(async () => {
      manager = new QuickCommerceMcpManager(
        new SwiggyMcpClient(createTestSwiggyTransport()),
        new ZeptoMcpClient(createTestZeptoTransport())
      );
      await manager.initialize();
    });

    it('aggregates all tool definitions and plugins across merchants', () => {
      const allDefs = manager.getAllMcpToolDefinitions();
      const names = allDefs.map((d) => d.name);
      expect(names).toContain('swiggy_im_search_items');
      expect(names).toContain('zepto_search_products');
      expect(names).toContain('quick_commerce_compare_basket');

      const plugins = manager.getShoppingAgentPlugins();
      expect(plugins.length).toBe(allDefs.length);
    });

    it('dispatches tool calls dynamically via executeMcpTool', async () => {
      const swiggySearch = (await manager.executeMcpTool('swiggy_im_search_items', {
        query: 'milk',
      })) as any[];
      expect(swiggySearch.length).toBeGreaterThan(0);

      const zeptoSearch = (await manager.executeMcpTool('zepto_search_products', {
        query: 'bread',
      })) as any[];
      expect(zeptoSearch.length).toBeGreaterThan(0);
    });

    it('searches all merchants in parallel', async () => {
      const { swiggyItems, zeptoItems } = await manager.searchAllMerchants('milk', blrLocation);
      expect(swiggyItems.length).toBeGreaterThan(0);
      expect(zeptoItems.length).toBeGreaterThan(0);
      expect(swiggyItems[0].platform).toBe('swiggy_instamart');
      expect(zeptoItems[0].platform).toBe('zepto');
    });

    it('checks delivery serviceability across all connected dark stores', async () => {
      const { swiggy, zepto } = await manager.checkDeliveryServiceability(blrLocation);
      expect(swiggy.serviceable).toBe(true);
      expect(zepto.serviceable).toBe(true);
      expect(zepto.etaMinutes).toBe(10);
      expect(swiggy.etaMinutes).toBe(14);
    });

    it('assembles and compares multi-platform basket, recommending optimal merchant with reason', async () => {
      const comparison = await manager.compareAndAssembleBasket(
        [
          { name: 'milk', quantity: 1 },
          { name: 'bread', quantity: 1 },
        ],
        blrLocation
      );

      expect(comparison.swiggyProposal).toBeDefined();
      expect(comparison.zeptoProposal).toBeDefined();
      expect(comparison.recommendedProposal).toBeDefined();
      expect(comparison.recommendationReason).toBeTruthy();

      // Ensure platform checkout works via manager
      const checkout = await manager.executePlatformCheckout(
        comparison.recommendedProposal.platform as 'swiggy_instamart' | 'zepto',
        comparison.recommendedProposal.cartId,
        'prv_tok_manager_test'
      );
      expect(checkout.success).toBe(true);
    });
  });

  describe('5. Library Re-Exports & Monorepo Path Parity', () => {
    it('verifies lib/mcp/* exports match src/mcp/*', () => {
      expect(libMcp.QuickCommerceMcpManager).toBe(QuickCommerceMcpManager);
      expect(libSwiggy.SwiggyMcpClient).toBe(SwiggyMcpClient);
      expect(libZepto.ZeptoMcpClient).toBe(ZeptoMcpClient);
      expect(libTransport.McpTransportFactory).toBe(McpTransportFactory);
    });
  });
});
