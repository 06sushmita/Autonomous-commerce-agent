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
   * Assemble and compare carts across Swiggy and Zepto with high accuracy.
   * Leverages parallel resolution, semantic filtering, and complete aggregate data context.
   */
  public async compareAndAssembleBasket(
    items: Array<{ name: string; quantity: number }>,
    location: DeliveryLocation,
    explicitMerchant?: 'swiggy' | 'zepto'
  ): Promise<MultiPlatformComparison> {
    
    // Helper to find the absolute best item matching the user target name using a simple string score
    const selectBestMatchedItem = (results: QuickCommerceItem[], targetName: string): QuickCommerceItem | undefined => {
      if (!results || results.length === 0) return undefined;
      
      const cleanTarget = targetName.toLowerCase();
      let bestItem = results[0];
      let highestScore = 0;

      for (const item of results) {
        const cleanItemName = item.name.toLowerCase();
        let currentScore = 0;

        // Weight exact brand/substring matches
        if (cleanItemName.includes(cleanTarget)) currentScore += 10;
        
        // Match specific volume tokens like "1l", "500ml", "brown"
        const tokens = cleanTarget.split(/\s+/);
        tokens.forEach(token => {
          if (cleanItemName.includes(token)) currentScore += 2;
        });

        if (currentScore > highestScore) {
          highestScore = currentScore;
          bestItem = item;
        }
      }
      return bestItem;
    };

    // 1. Resolve items on Swiggy in Parallel (if not explicitly Zepto)
    const swiggyCartItems: Array<{ itemId: string; quantity: number }> = [];
    const swiggyResolvedItems: QuickCommerceItem[] = [];

    if (explicitMerchant !== 'zepto') {
      const swiggyPromises = items.map(async (item) => {
        try {
          const results = await this.swiggy.searchItems(item.name, location);
          const bestMatch = selectBestMatchedItem(results, item.name);
          if (bestMatch) {
            return { itemId: bestMatch.id, quantity: item.quantity, rawItem: bestMatch };
          }
        } catch (err) {
          // Fail silently per item to allow graceful fallback paths
        }
        return null;
      });

      const swiggyResults = await Promise.all(swiggyPromises);
      swiggyResults.forEach((res) => {
        if (res) {
          swiggyCartItems.push({ itemId: res.itemId, quantity: res.quantity });
          swiggyResolvedItems.push(res.rawItem);
        }
      });
    }

    // 2. Resolve items on Zepto in Parallel (if not explicitly Swiggy)
    const zeptoCartItems: Array<{ itemId: string; quantity: number }> = [];
    const zeptoResolvedItems: QuickCommerceItem[] = [];

    if (explicitMerchant !== 'swiggy') {
      const zeptoPromises = items.map(async (item) => {
        try {
          const results = await this.zepto.searchProducts(item.name, location);
          const bestMatch = selectBestMatchedItem(results, item.name);
          if (bestMatch) {
            return { itemId: bestMatch.id, quantity: item.quantity, rawItem: bestMatch };
          }
        } catch (err) {
          // Fail silently per item to allow graceful fallback paths
        }
        return null;
      });

      const zeptoResults = await Promise.all(zeptoPromises);
      zeptoResults.forEach((res) => {
        if (res) {
          zeptoCartItems.push({ itemId: res.itemId, quantity: res.quantity });
          zeptoResolvedItems.push(res.rawItem);
        }
      });
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

    // FIX: Attach ALL resolved items to the final proposal for spotlight evaluation, not just the first loop hit
    if (swiggyProposal && swiggyResolvedItems.length > 0) {
      swiggyProposal.resolvedItemsContext = swiggyResolvedItems; 
      swiggyProposal.bestItem = swiggyResolvedItems[0]; // Retain for typing backwards compatibility
    }
    if (zeptoProposal && zeptoResolvedItems.length > 0) {
      zeptoProposal.resolvedItemsContext = zeptoResolvedItems;
      zeptoProposal.bestItem = zeptoResolvedItems[0]; 
    }

    if (!swiggyProposal && !zeptoProposal) {
      throw new Error(`Items could not be completely fulfilled across dark stores for location ${location.pincode}`);
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
      recommended.bestItem = recommended.platform === 'zepto' ? zeptoResolvedItems[0] : swiggyResolvedItems[0];
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
