/**
 * Quick-Commerce MCP Manager
 * Orchestrates cross-platform product discovery, dark store inventory verification,
 * cart assembly, price/delivery comparison, and exposes unified MCP tools & plugins
 * to @agorio/sdk ShoppingAgent.
 */

import {
  DeliveryLocation,
  QuickCommerceBasketProposal,
  QuickCommerceItem,
  OrderCheckoutResult,
  McpToolDefinition,
  AgentPlugin,
  DeliveryEstimateResult,
} from './types.js';
import { swiggyMcpClient, SwiggyMcpClient } from './swiggy-mcp.js';
import { zeptoMcpClient, ZeptoMcpClient } from './zepto-mcp.js';

export interface MultiPlatformComparison {
  query: string;
  swiggyProposal?: QuickCommerceBasketProposal;
  zeptoProposal?: QuickCommerceBasketProposal;
  recommendedProposal: QuickCommerceBasketProposal;
  recommendationReason: string;
}

export class QuickCommerceMcpManager {
  private swiggy: SwiggyMcpClient;
  private zepto: ZeptoMcpClient;

  constructor(swiggy = swiggyMcpClient, zepto = zeptoMcpClient) {
    this.swiggy = swiggy;
    this.zepto = zepto;
  }

  public async initialize(): Promise<void> {
    await Promise.allSettled([this.swiggy.initialize(), this.zepto.initialize()]);
  }

  public getSwiggyClient(): SwiggyMcpClient {
    return this.swiggy;
  }

  public getZeptoClient(): ZeptoMcpClient {
    return this.zepto;
  }

  public setClients(swiggy: SwiggyMcpClient, zepto: ZeptoMcpClient): void {
    this.swiggy = swiggy;
    this.zepto = zepto;
  }

  /**
   * Returns all MCP tool definitions across both Swiggy and Zepto
   */
  public getAllMcpToolDefinitions(): McpToolDefinition[] {
    return [
      ...this.swiggy.getToolDefinitions(),
      ...this.zepto.getToolDefinitions(),
      {
        name: 'quick_commerce_compare_basket',
        description:
          'Compare total basket pricing, dark store availability, and ETA across Swiggy and Zepto to determine the optimal delivery option.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  quantity: { type: 'integer' },
                },
                required: ['name', 'quantity'],
              },
            },
            location: {
              type: 'object',
              properties: {
                address: { type: 'string' },
                pincode: { type: 'string' },
              },
              required: ['pincode'],
            },
          },
          required: ['items', 'location'],
        },
      },
    ];
  }

  /**
   * Expose aggregated tools as @agorio/sdk AgentPlugins for ShoppingAgent
   */
  public getShoppingAgentPlugins(): AgentPlugin[] {
    const swiggyPlugins = this.swiggy.getAgentPlugins();
    const zeptoPlugins = this.zepto.getAgentPlugins();

    const comparePlugin: AgentPlugin = {
      name: 'quick_commerce_compare_basket',
      description:
        'Compare total basket pricing, dark store availability, and ETA across Swiggy and Zepto to determine the optimal delivery option.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                quantity: { type: 'integer' },
              },
              required: ['name', 'quantity'],
            },
          },
          location: {
            type: 'object',
            properties: {
              address: { type: 'string' },
              pincode: { type: 'string' },
            },
            required: ['pincode'],
          },
        },
        required: ['items', 'location'],
      },
      handler: async (args) => {
        return this.compareAndAssembleBasket(
          args.items as Array<{ name: string; quantity: number }>,
          args.location as DeliveryLocation
        );
      },
    };

    return [...swiggyPlugins, ...zeptoPlugins, comparePlugin];
  }

  /**
   * Dispatch tool call dynamically by name
   */
  public async executeMcpTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName.startsWith('swiggy_')) {
      return this.swiggy.handleToolCall(toolName, args);
    }
    if (toolName.startsWith('zepto_') || this.zepto.findToolName([toolName])) {
      return this.zepto.handleToolCall(toolName, args);
    }
    if (toolName === 'quick_commerce_compare_basket') {
      return this.compareAndAssembleBasket(
        args.items as Array<{ name: string; quantity: number }>,
        args.location as DeliveryLocation,
        args.merchant as 'swiggy' | 'zepto' | undefined
      );
    }
    throw new Error(`Unknown MCP tool name: ${toolName}`);
  }

  /**
   * Search items across all connected quick-commerce MCP servers in parallel
   */
  public async searchAllMerchants(
    query: string,
    location?: DeliveryLocation
  ): Promise<{ swiggyItems: QuickCommerceItem[]; zeptoItems: QuickCommerceItem[] }> {
    const [swiggyItems, zeptoItems] = await Promise.all([
      this.swiggy.searchItems(query, location),
      this.zepto.searchProducts(query, location),
    ]);
    return { swiggyItems, zeptoItems };
  }

  /**
   * Verify dark store delivery feasibility across all platforms
   */
  public async checkDeliveryServiceability(
    location: DeliveryLocation
  ): Promise<{ swiggy: DeliveryEstimateResult; zepto: DeliveryEstimateResult }> {
    const [swiggy, zepto] = await Promise.all([
      this.swiggy.getDeliveryEstimate(location),
      this.zepto.getDeliveryEstimate(location),
    ]);
    return { swiggy, zepto };
  }

  /**
   * Assemble and compare carts across Swiggy and Zepto to find the lowest price and fastest ETA,
   * or directly build basket for an explicitly chosen merchant.
   */
  public async compareAndAssembleBasket(
    items: Array<{ name: string; quantity: number }>,
    location: DeliveryLocation,
    explicitMerchant?: 'swiggy' | 'zepto'
  ): Promise<MultiPlatformComparison> {
    // 1. Resolve items on Swiggy (if not explicitly Zepto)
    const swiggyCartItems: Array<{ itemId: string; quantity: number }> = [];
    let topSwiggyItem: QuickCommerceItem | undefined;
    if (explicitMerchant !== 'zepto') {
      for (const item of items) {
        try {
          const results = await this.swiggy.searchItems(item.name, location);
          if (results.length > 0) {
            swiggyCartItems.push({ itemId: results[0].id, quantity: item.quantity });
            if (!topSwiggyItem) topSwiggyItem = results[0];
          }
        } catch {
          // Ignore merchant error if fallback or other merchant available
        }
      }
    }

    // 2. Resolve items on Zepto (if not explicitly Swiggy)
    const zeptoCartItems: Array<{ itemId: string; quantity: number }> = [];
    let topZeptoItem: QuickCommerceItem | undefined;
    if (explicitMerchant !== 'swiggy') {
      for (const item of items) {
        try {
          const results = await this.zepto.searchProducts(item.name, location);
          if (results.length > 0) {
            zeptoCartItems.push({ itemId: results[0].id, quantity: item.quantity });
            if (!topZeptoItem) topZeptoItem = results[0];
          }
        } catch {
          // Ignore merchant error if fallback or other merchant available
        }
      }
    }

    // 3. Create proposals in parallel
    const [swiggyProposal, zeptoProposal] = await Promise.all([
      swiggyCartItems.length === items.length
        ? this.swiggy.createCart(swiggyCartItems, location)
        : undefined,
      zeptoCartItems.length === items.length
        ? this.zepto.createCart(zeptoCartItems, location)
        : undefined,
    ]);

    if (swiggyProposal && topSwiggyItem) {
      swiggyProposal.bestItem = topSwiggyItem;
    }
    if (zeptoProposal && topZeptoItem) {
      zeptoProposal.bestItem = topZeptoItem;
    }

    if (!swiggyProposal && !zeptoProposal) {
      throw new Error(`Items could not be found across dark stores for location ${location.pincode}`);
    }

    // 4. Decision boundary: user preference or rank by availability, price, and ETA
    let recommended: QuickCommerceBasketProposal;
    let reason = '';

    if (explicitMerchant === 'zepto' && zeptoProposal) {
      recommended = zeptoProposal;
      reason = 'User explicitly selected Zepto as preferred merchant.';
    } else if (explicitMerchant === 'swiggy' && swiggyProposal) {
      recommended = swiggyProposal;
      reason = 'User explicitly selected Swiggy as preferred merchant.';
    } else if (swiggyProposal && zeptoProposal) {
      if (zeptoProposal.totalAmountCents < swiggyProposal.totalAmountCents) {
        recommended = zeptoProposal;
        reason = `Zepto is cheaper (₹${(zeptoProposal.totalAmountCents / 100).toFixed(2)} vs ₹${(swiggyProposal.totalAmountCents / 100).toFixed(2)}) and delivers faster in ${zeptoProposal.etaMinutes} mins.`;
      } else if (zeptoProposal.totalAmountCents === swiggyProposal.totalAmountCents) {
        recommended = zeptoProposal.etaMinutes <= swiggyProposal.etaMinutes ? zeptoProposal : swiggyProposal;
        reason = `Equal price (₹${(recommended.totalAmountCents / 100).toFixed(2)}); chosen based on faster ETA (${recommended.etaMinutes} mins).`;
      } else {
        recommended = swiggyProposal;
        reason = `Swiggy Instamart is cheaper (₹${(swiggyProposal.totalAmountCents / 100).toFixed(2)} vs ₹${(zeptoProposal.totalAmountCents / 100).toFixed(2)}).`;
      }
    } else {
      recommended = (zeptoProposal || swiggyProposal)!;
      reason = `Only ${recommended.merchantName} has all requested items in stock at dark store.`;
    }

    if (!recommended.bestItem) {
      recommended.bestItem = recommended.platform === 'zepto' ? topZeptoItem : topSwiggyItem;
    }

    return {
      query: items.map((i) => `${i.quantity}x ${i.name}`).join(', '),
      swiggyProposal,
      zeptoProposal,
      recommendedProposal: recommended,
      recommendationReason: reason,
    };
  }

  /**
   * Execute checkout on the chosen platform using single-use Prava token
   */
  public async executePlatformCheckout(
    platform: 'swiggy_instamart' | 'zepto',
    cartId: string,
    paymentTokenRef: string
  ): Promise<OrderCheckoutResult> {
    if (platform === 'swiggy_instamart') {
      return this.swiggy.executeCheckout(cartId, paymentTokenRef);
    } else {
      return this.zepto.executeCheckout(cartId, paymentTokenRef);
    }
  }
}

export const quickCommerceMcpManager = new QuickCommerceMcpManager();
