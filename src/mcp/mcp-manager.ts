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
  ProductMatchResult,
  ConstrainedGroceryItem,
  ConstraintValidationSummary,
} from './types.js';
import { swiggyMcpClient, SwiggyMcpClient } from './swiggy-mcp.js';
import { zeptoMcpClient, ZeptoMcpClient } from './zepto-mcp.js';

export interface MultiPlatformComparison {
  query: string;
  swiggyProposal?: QuickCommerceBasketProposal;
  zeptoProposal?: QuickCommerceBasketProposal;
  recommendedProposal: QuickCommerceBasketProposal;
  recommendationReason: string;
  priceSource: string;
  priceFreshness: string;
  productMatches?: Record<string, ProductMatchResult[]>;
  feesBreakdown?: {
    swiggy?: {
      subtotalCents: number;
      deliveryFeeCents: number;
      handlingFeeCents: number;
      taxesCents: number;
      discountCents: number;
      totalAmountCents: number;
    };
    zepto?: {
      subtotalCents: number;
      deliveryFeeCents: number;
      handlingFeeCents: number;
      taxesCents: number;
      discountCents: number;
      totalAmountCents: number;
    };
  };
  isEstimate: boolean;
  unavailableFields?: string[];
  splitBasketSupported?: boolean;
}

export interface NormalizedUnit {
  type: 'volume' | 'weight' | 'count';
  baseValue: number; // in ml, g, or count
  unitString: string;
}

/**
 * Normalizes units for comparison so equivalent package sizes can be matched accurately.
 * Never treats different package sizes (e.g. 500ml vs 1L) as identical.
 */
export function parseAndNormalizeUnit(text?: string): NormalizedUnit | null {
  if (!text) return null;
  const clean = text.toLowerCase();

  // Volume: Liters / Milliliters
  const lMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:l|ltr|litre|liter|litres|liters)\b/);
  if (lMatch) {
    return { type: 'volume', baseValue: Math.round(parseFloat(lMatch[1]) * 1000), unitString: `${lMatch[1]} L` };
  }
  const mlMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:ml|millilitre|milliliter)\b/);
  if (mlMatch) {
    return { type: 'volume', baseValue: Math.round(parseFloat(mlMatch[1])), unitString: `${mlMatch[1]} ml` };
  }

  // Weight: Kilograms / Grams
  const kgMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilo|kilogram|kilograms)\b/);
  if (kgMatch) {
    return { type: 'weight', baseValue: Math.round(parseFloat(kgMatch[1]) * 1000), unitString: `${kgMatch[1]} kg` };
  }
  const gMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/);
  if (gMatch) {
    return { type: 'weight', baseValue: Math.round(parseFloat(gMatch[1])), unitString: `${gMatch[1]} g` };
  }

  // Count: pcs / pieces / eggs / pack
  const pcsMatch = clean.match(/(\d+)\s*(?:pcs|pieces?|eggs?|count|pack|units?)\b/);
  if (pcsMatch) {
    return { type: 'count', baseValue: parseInt(pcsMatch[1], 10), unitString: `${pcsMatch[1]} pcs` };
  }

  return null;
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
          'Compare total basket pricing, dark store availability, and ETA across Swiggy and Zepto to determine the optimal delivery option enforcing product brand, cost, quantity, and time constraints.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Product item name (e.g. "milk", "bread")' },
                  brand: { type: 'string', description: 'Target product brand constraint (e.g. "Nandini", "Amul")' },
                  maxCostCents: { type: 'integer', description: 'Max acceptable price in paise (e.g. 5000 = ₹50.00)' },
                  quantity: { type: 'integer', description: 'Requested quantity units' },
                  maxEtaMinutes: { type: 'integer', description: 'Maximum delivery time constraint in minutes' },
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
        'Compare total basket pricing, dark store availability, and ETA across Swiggy and Zepto to determine the optimal delivery option enforcing product brand, cost, quantity, and time constraints.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Product item name' },
                brand: { type: 'string', description: 'Target brand constraint' },
                maxCostCents: { type: 'integer', description: 'Max acceptable price in paise' },
                quantity: { type: 'integer', description: 'Requested quantity' },
                maxEtaMinutes: { type: 'integer', description: 'Maximum delivery time in minutes' },
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
          args.items as Array<ConstrainedGroceryItem>,
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
  /**
   * Filter and rank items strictly enforcing the user's priority hierarchy:
   * 1. Price ("prize"): Verified live price, budget limit compliance, and lowest unit price first
   * 2. Quantity: In-stock status, stock availability, and package size match
   * 3. Product: Core grocery item/noun match and relevance
   * 4. Brand: Requested brand fidelity
   *
   * Slices to the top N items (default: 5) to guarantee the agent never returns 50-100 raw items.
   */
  public rankTopItems(
    items: QuickCommerceItem[],
    options?: {
      query?: string;
      targetBrand?: string;
      requestedQuantity?: number;
      maxCostCents?: number;
      limit?: number;
    }
  ): QuickCommerceItem[] {
    if (!items || items.length === 0) return [];

    const limit = options?.limit ?? 5;
    const query = (options?.query || '').toLowerCase().trim();
    const targetBrand = options?.targetBrand?.toLowerCase();
    const maxCost = options?.maxCostCents;

    // Extract core tokens for product relevance
    const cleanQuery = query
      .replace(/\b(?:\d+\s*(?:l|ltr|litre|liter|litres|liters|ml|g|gm|kg|pcs?|pieces?|pack|packets?|box|carton))\b/gi, '')
      .replace(/(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)?\s*\d+(?:\.\d+)?/gi, '')
      .trim();
    const stem = (s: string) => (s.endsWith('s') && s.length > 3 ? s.slice(0, -1) : s);
    const coreTokens = cleanQuery
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length > 2 && !['and', 'for', 'the', 'with', 'item', 'product', 'fresh', 'best', 'good'].includes(t));

    // Deduplicate by item.id or item.name
    const seen = new Set<string>();
    const uniqueItems: QuickCommerceItem[] = [];
    for (const it of items) {
      const key = `${it.platform}_${it.id || it.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueItems.push(it);
      }
    }

    // Sort according to 4-tier constraint hierarchy: Price, Quantity, Product, Brand
    const sorted = [...uniqueItems].sort((a, b) => {
      // 0. Live verification gate (fail-closed, no mock/unverified items)
      const aVerified = a.isPriceVerified !== false && a.priceCents > 0;
      const bVerified = b.isPriceVerified !== false && b.priceCents > 0;
      if (aVerified !== bVerified) return aVerified ? -1 : 1;

      // 1. Core Product relevance (filter out totally irrelevant products first)
      if (coreTokens.length > 0) {
        const aCore = coreTokens.some((tok) => {
          const st = stem(tok);
          return (
            a.name.toLowerCase().includes(tok) ||
            a.name.toLowerCase().includes(st) ||
            (a.category || '').toLowerCase().includes(tok)
          );
        });
        const bCore = coreTokens.some((tok) => {
          const st = stem(tok);
          return (
            b.name.toLowerCase().includes(tok) ||
            b.name.toLowerCase().includes(st) ||
            (b.category || '').toLowerCase().includes(tok)
          );
        });
        if (aCore !== bCore) return aCore ? -1 : 1;
      }

      // 2. Quantity & Stock Availability: In-stock strictly before out-of-stock
      const aStock = Boolean(a.inStock !== false);
      const bStock = Boolean(b.inStock !== false);
      if (aStock !== bStock) return aStock ? -1 : 1;

      // 3. Brand match (if target brand was requested)
      if (targetBrand) {
        const aBrand = (a.brand || '').toLowerCase().includes(targetBrand) || a.name.toLowerCase().includes(targetBrand);
        const bBrand = (b.brand || '').toLowerCase().includes(targetBrand) || b.name.toLowerCase().includes(targetBrand);
        if (aBrand !== bBrand) return aBrand ? -1 : 1;
      }

      // 4. Price ("prize") constraint: Items within budget rank before items exceeding budget
      if (maxCost) {
        const aUnderBudget = a.priceCents <= maxCost;
        const bUnderBudget = b.priceCents <= maxCost;
        if (aUnderBudget !== bUnderBudget) return aUnderBudget ? -1 : 1;
      }

      // 5. Lowest unit price comes first
      if (a.priceCents !== b.priceCents) {
        return a.priceCents - b.priceCents;
      }

      // 6. Quantity available tie-breaker
      const aQty = a.quantityAvailable || 20;
      const bQty = b.quantityAvailable || 20;
      if (aQty !== bQty) return bQty - aQty;

      return 0;
    });

    return sorted.slice(0, limit);
  }

  /**
   * Search items across all connected quick-commerce MCP servers in parallel.
   * Ranks results using the 4-tier constraint hierarchy (Price, Quantity, Product, Brand)
   * and limits to the top 5 highest-accuracy items per platform.
   */
  public async searchAllMerchants(
    query: string,
    location?: DeliveryLocation
  ): Promise<{ swiggyItems: QuickCommerceItem[]; zeptoItems: QuickCommerceItem[] }> {
    // If query contains multiple items (e.g. "Amul butter and eggs"), search each sub-item independently
    const clean = query
      .replace(/(?:[\r\n]+|\.\s+)(?:if\s+i\s+(?:am\s+)?asking|please\s+(?:show|give|make|pick)|make\s+sure|i\s+want\s+best|give\s+me\s+best).+$/is, '')
      .replace(/^(?:find|search|get|order|buy|show|look for|fetch|i want|please get me|bring me)\s+(?:me\s+)?/i, '')
      .replace(/\s+(?:in under \d+ mins?|in \d+ mins?|under \d+ mins?|fast|urgent|quickly|asap|from swiggy|from zepto|near me)\.?$/i, '')
      .replace(/\s+(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)?\s*\d+(?:\.\d+)?\s*(?:rs|rupees|inr)?/gi, '')
      .trim();

    const segments = clean
      .split(/(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i)
      .map((s) => s.trim())
      .filter(Boolean);

    if (segments.length > 1) {
      const perSegmentSearches = await Promise.all(
        segments.map((seg) =>
          Promise.all([
            this.swiggy.searchItems(seg, location).catch(() => []),
            this.zepto.searchProducts(seg, location).catch(() => []),
          ])
        )
      );

      const swiggyItems: QuickCommerceItem[] = [];
      const zeptoItems: QuickCommerceItem[] = [];
      const swiggySeen = new Set<string>();
      const zeptoSeen = new Set<string>();

      for (const [swiggyRes, zeptoRes] of perSegmentSearches) {
        for (const item of swiggyRes) {
          if (!swiggySeen.has(item.id)) {
            swiggySeen.add(item.id);
            swiggyItems.push(item);
          }
        }
        for (const item of zeptoRes) {
          if (!zeptoSeen.has(item.id)) {
            zeptoSeen.add(item.id);
            zeptoItems.push(item);
          }
        }
      }

      return {
        swiggyItems: this.rankTopItems(swiggyItems, { query: clean, limit: 5 }),
        zeptoItems: this.rankTopItems(zeptoItems, { query: clean, limit: 5 }),
      };
    }

    const [swiggyRaw, zeptoRaw] = await Promise.all([
      this.swiggy.searchItems(clean || query, location).catch(() => []),
      this.zepto.searchProducts(clean || query, location).catch(() => []),
    ]);

    return {
      swiggyItems: this.rankTopItems(swiggyRaw, { query: clean || query, limit: 5 }),
      zeptoItems: this.rankTopItems(zeptoRaw, { query: clean || query, limit: 5 }),
    };
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
   * Match equivalent products using brand, package size, quantity, availability and unit price.
   * Normalizes units for comparison, but never compares different package sizes as if they were identical.
   */
  /**
   * Match equivalent products using brand, package size, quantity, availability, unit price, and delivery ETA constraints.
   * Normalizes units for comparison, but never compares different package sizes as if they were identical.
   * Strictly enforces that brand, cost limit, quantity/stock, time SLA, and live price are acceptable.
   */
  public matchEquivalentProduct(
    requested: {
      name: string;
      quantity: number;
      brand?: string;
      maxCostCents?: number;
      maxEtaMinutes?: number;
    },
    availableItems: QuickCommerceItem[],
    darkStoreEtaMinutes?: number
  ): ProductMatchResult {
    const requestedLower = requested.name.toLowerCase();
    const requestedUnit = parseAndNormalizeUnit(requested.name);

    // Detect requested brand if mentioned in query or explicitly provided
    const knownBrands = [
      'nandini',
      'amul',
      'britannia',
      'eggoz',
      'the health factory',
      'health factory',
      'milky mist',
      'mother dairy',
      'fortune',
      'aashirvaad',
      'nestle',
      'cadbury',
      'safal',
      'suguna',
    ];
    const detectedBrand = knownBrands.find((b) => requestedLower.includes(b));
    const targetBrand = requested.brand || detectedBrand;

    // Extract core product keywords (excluding brand and common volume/count units)
    const brandPattern = targetBrand ? new RegExp(`\\b${targetBrand.toLowerCase()}\\b`, 'gi') : null;
    const strippedName = (brandPattern ? requestedLower.replace(brandPattern, '') : requestedLower)
      .replace(/\b(?:\d+\s*(?:l|ltr|litre|liter|litres|liters|ml|g|gm|kg|pcs?|pieces?|pack|packets?|box|carton))\b/gi, '')
      .trim();

    const stem = (s: string) => (s.endsWith('s') && s.length > 3 ? s.slice(0, -1) : s);
    const coreTokens = strippedName
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length > 2 && !['and', 'for', 'the', 'with', 'item', 'product', 'fresh', 'best', 'good'].includes(t));

    if (!availableItems || availableItems.length === 0) {
      return {
        requestedName: requested.name,
        requestedBrand: targetBrand,
        requestedQuantity: requested.quantity,
        maxCostCents: requested.maxCostCents,
        maxEtaMinutes: requested.maxEtaMinutes,
        brandMatch: false,
        packageSizeMatch: false,
        isVerified: false,
        inStock: false,
        status: 'missing',
        notes: 'No items found for product query.',
        rejectionReason: `No items found matching "${requested.name}".`,
      };
    }

    let bestItem: QuickCommerceItem | undefined;
    let highestScore = -Infinity;
    let bestBrandMatch = false;
    let bestSizeMatch = false;
    let bestCostMatch = true;

    for (const item of availableItems) {
      const itemNameLower = item.name.toLowerCase();
      const itemBrandLower = (item.brand || '').toLowerCase();
      const itemCategoryLower = (item.category || '').toLowerCase();
      const itemUnit = parseAndNormalizeUnit(item.unit || item.packSize || item.name);

      let score = 0;

      // 0. Core product category/name match (prevents brand false positives like Mango Lassi when user asked for Milk)
      if (coreTokens.length > 0) {
        const coreMatched = coreTokens.some((tok) => {
          const st = stem(tok);
          return (
            itemNameLower.includes(tok) ||
            itemNameLower.includes(st) ||
            itemCategoryLower.includes(tok) ||
            itemCategoryLower.includes(st)
          );
        });
        if (coreMatched) {
          score += 140; // Strong bonus for matching core product category
        } else {
          score -= 1000; // Strong penalty: product name does not match requested grocery item
        }
      }

      // 1. In-stock requirement
      if (item.inStock === false) {
        score -= 300;
      } else {
        score += 30;
      }

      // 2. Verified price requirement (STRICT: no unverified or mock data)
      if (item.isPriceVerified === false || !item.priceCents || item.priceCents <= 0) {
        score -= 500;
      } else {
        score += 30;
      }

      // 3. Brand match scoring
      const brandMatched = Boolean(
        targetBrand &&
        (itemNameLower.includes(targetBrand.toLowerCase()) || itemBrandLower.includes(targetBrand.toLowerCase()))
      );
      if (targetBrand) {
        if (brandMatched) {
          score += 150; // Strong bonus for matching requested brand
        } else {
          score -= 300; // Strong penalty for non-matching brand
        }
      }

      // 4. Cost constraint scoring (Price is the primary optimization constraint)
      let costMatched = true;
      if (item.priceCents && item.priceCents > 0) {
        // Prioritize lowest verified unit price
        score += Math.max(0, 50000 - item.priceCents) / 250;
      }
      if (requested.maxCostCents && item.priceCents) {
        if (item.priceCents <= requested.maxCostCents) {
          score += 80;
        } else {
          score -= 500; // Strongly deprioritize items exceeding budget
          costMatched = false;
        }
      }

      // 5. Package size match scoring
      let sizeMatched = false;
      if (requestedUnit) {
        if (itemUnit && itemUnit.type === requestedUnit.type) {
          if (itemUnit.baseValue === requestedUnit.baseValue) {
            sizeMatched = true;
            score += 70; // Exact package size match
          } else {
            // Material size mismatch: do not treat as identical
            score -= 100;
          }
        } else {
          score -= 50;
        }
      } else {
        // No specific size requested; any standard size is acceptable
        sizeMatched = true;
      }

      // Substring & token overlap matching
      if (itemNameLower.includes(requestedLower)) {
        score += 40;
      }
      const tokens = requestedLower.split(/\s+/).filter((t) => t.length > 1);
      for (const token of tokens) {
        if (itemNameLower.includes(token)) score += 10;
      }

      if (score > highestScore) {
        highestScore = score;
        bestItem = item;
        bestBrandMatch = brandMatched;
        bestSizeMatch = sizeMatched;
        bestCostMatch = costMatched;
      }
    }

    if (!bestItem) {
      return {
        requestedName: requested.name,
        requestedBrand: targetBrand,
        requestedQuantity: requested.quantity,
        brandMatch: false,
        packageSizeMatch: false,
        isVerified: false,
        inStock: false,
        status: 'missing',
        rejectionReason: `No acceptable item found for "${requested.name}".`,
      };
    }

    const isVerified = Boolean(bestItem.isPriceVerified !== false && bestItem.priceCents > 0);
    const inStock = Boolean(bestItem.inStock !== false && isVerified);
    const effectiveEta = darkStoreEtaMinutes ?? bestItem.etaMinutes ?? 20;

    // Strict multi-constraint verification: ALL 5 MUST BE ACCEPTABLE
    let status: ProductMatchResult['status'] = 'verified_match';
    let rejectionReason: string | undefined;

    const itemCatLower = (bestItem.category || '').toLowerCase();
    const bestItemNameLower = bestItem.name.toLowerCase();
    const coreProductMatches = coreTokens.length === 0 || coreTokens.some((tok) => {
      const st = stem(tok);
      return (
        bestItemNameLower.includes(tok) ||
        bestItemNameLower.includes(st) ||
        itemCatLower.includes(tok) ||
        itemCatLower.includes(st)
      );
    });

    if (!isVerified) {
      status = 'unverified';
      rejectionReason = `Live price for "${bestItem.name}" is unverified.`;
    } else if (!inStock) {
      status = 'out_of_stock';
      rejectionReason = `Item "${bestItem.name}" is currently out of stock at this dark store.`;
    } else if (!coreProductMatches) {
      status = 'missing';
      rejectionReason = `No acceptable item matching "${requested.name}" found in catalog (closest item "${bestItem.name}" does not match requested product).`;
    } else if (targetBrand && !bestBrandMatch) {
      status = 'brand_mismatch';
      rejectionReason = `Requested brand "${targetBrand}" is not available. Found "${bestItem.brand || bestItem.name}".`;
    } else if (requested.maxCostCents && bestItem.priceCents > requested.maxCostCents) {
      status = 'cost_exceeded';
      rejectionReason = `Item cost (₹${(bestItem.priceCents / 100).toFixed(2)}) exceeds maximum budget limit of ₹${(requested.maxCostCents / 100).toFixed(2)}.`;
    } else if (requested.maxEtaMinutes && effectiveEta > requested.maxEtaMinutes) {
      status = 'eta_exceeded';
      rejectionReason = `Delivery ETA (${effectiveEta} mins) exceeds required delivery constraint (${requested.maxEtaMinutes} mins).`;
    } else if (requestedUnit && !bestSizeMatch) {
      status = 'size_mismatch';
      rejectionReason = `Package size does not match requested unit ${requestedUnit.unitString}.`;
    }

    return {
      requestedName: requested.name,
      requestedBrand: targetBrand,
      requestedQuantity: requested.quantity,
      requestedUnit: requestedUnit?.unitString,
      maxCostCents: requested.maxCostCents,
      maxEtaMinutes: requested.maxEtaMinutes,
      matchedItem: bestItem,
      brandMatch: targetBrand ? bestBrandMatch : true,
      packageSizeMatch: bestSizeMatch,
      costMatch: requested.maxCostCents ? bestItem.priceCents <= requested.maxCostCents : true,
      etaMatch: requested.maxEtaMinutes ? effectiveEta <= requested.maxEtaMinutes : true,
      unitPriceCents: bestItem.priceCents,
      isVerified,
      inStock,
      status,
      rejectionReason,
    };
  }

  /**
   * Assemble and compare carts across Swiggy and Zepto with high accuracy.
   * Compares complete basket totals (including delivery fees, handling fees, and taxes).
   * Respects explicit user merchant preference without silent merchant switching.
   * Strictly enforces brand, cost, quantity, and delivery time constraints.
   */
  public async compareAndAssembleBasket(
    items: Array<{ name: string; quantity: number; brand?: string; maxCostCents?: number; maxEtaMinutes?: number }>,
    location: DeliveryLocation,
    explicitMerchant?: 'swiggy' | 'zepto'
  ): Promise<MultiPlatformComparison> {
    const swiggyMatches: ProductMatchResult[] = [];
    const zeptoMatches: ProductMatchResult[] = [];

    const swiggyCartItems: Array<{ itemId: string; quantity: number }> = [];
    const swiggyResolvedItems: QuickCommerceItem[] = [];
    const zeptoCartItems: Array<{ itemId: string; quantity: number }> = [];
    const zeptoResolvedItems: QuickCommerceItem[] = [];
    const unavailableFields: string[] = [];

    // Helper to produce highest-accuracy merchant search query
    const buildSearchQuery = (item: { name: string; brand?: string }) => {
      const brandStr = item.brand ? item.brand.trim() : '';
      const nameStr = item.name.trim();
      if (brandStr && !nameStr.toLowerCase().includes(brandStr.toLowerCase())) {
        return `${brandStr} ${nameStr}`;
      }
      return nameStr;
    };

    // Pre-fetch delivery estimates in parallel to evaluate time constraints
    const [swiggyDelEst, zeptoDelEst] = await Promise.all([
      explicitMerchant !== 'zepto' ? this.swiggy.getDeliveryEstimate(location).catch(() => undefined) : undefined,
      explicitMerchant !== 'swiggy' ? this.zepto.getDeliveryEstimate(location).catch(() => undefined) : undefined,
    ]);

    // 1. Resolve items on Swiggy in Parallel
    if (explicitMerchant !== 'zepto') {
      const swiggyPromises: Promise<ProductMatchResult>[] = items.map(async (item) => {
        try {
          const q = buildSearchQuery(item);
          const results = await this.swiggy.searchItems(q, location);
          return this.matchEquivalentProduct(item, results, swiggyDelEst?.etaMinutes);
        } catch (err: any) {
          const fallback: ProductMatchResult = {
            requestedName: item.name,
            requestedBrand: item.brand,
            requestedQuantity: item.quantity,
            brandMatch: false,
            packageSizeMatch: false,
            isVerified: false,
            inStock: false,
            status: 'missing',
            notes: err.message,
            rejectionReason: err.message,
          };
          return fallback;
        }
      });

      const isConstraintApproved = (m: ProductMatchResult) =>
        (m.status === 'verified_match' || m.status === 'size_mismatch') &&
        m.brandMatch !== false &&
        m.inStock &&
        m.isVerified &&
        m.costMatch !== false &&
        m.etaMatch !== false;

      const results = await Promise.all(swiggyPromises);
      results.forEach((match) => {
        swiggyMatches.push(match);
        if (match.matchedItem && isConstraintApproved(match)) {
          swiggyCartItems.push({ itemId: match.matchedItem.id, quantity: match.requestedQuantity });
          swiggyResolvedItems.push(match.matchedItem);
        }
      });
    }

    // 2. Resolve items on Zepto in Parallel
    if (explicitMerchant !== 'swiggy') {
      const isConstraintApproved = (m: ProductMatchResult) =>
        (m.status === 'verified_match' || m.status === 'size_mismatch') &&
        m.brandMatch !== false &&
        m.inStock &&
        m.isVerified &&
        m.costMatch !== false &&
        m.etaMatch !== false;

      const zeptoPromises: Promise<ProductMatchResult>[] = items.map(async (item) => {
        try {
          const q = buildSearchQuery(item);
          const results = await this.zepto.searchProducts(q, location);
          return this.matchEquivalentProduct(item, results, zeptoDelEst?.etaMinutes);
        } catch (err: any) {
          const fallback: ProductMatchResult = {
            requestedName: item.name,
            requestedBrand: item.brand,
            requestedQuantity: item.quantity,
            brandMatch: false,
            packageSizeMatch: false,
            isVerified: false,
            inStock: false,
            status: 'missing',
            notes: err.message,
            rejectionReason: err.message,
          };
          return fallback;
        }
      });

      const results = await Promise.all(zeptoPromises);
      results.forEach((match) => {
        zeptoMatches.push(match);
        if (match.matchedItem && isConstraintApproved(match)) {
          zeptoCartItems.push({ itemId: match.matchedItem.id, quantity: match.requestedQuantity });
          zeptoResolvedItems.push(match.matchedItem);
        }
      });
    }

    // 3. Assemble proposals for fully fulfilled merchants in parallel
    // ONLY assemble cart if EVERY single requested item passed all 5 constraints!
    const isConstraintApproved = (m: ProductMatchResult) =>
      (m.status === 'verified_match' || m.status === 'size_mismatch') &&
      m.brandMatch !== false &&
      m.inStock &&
      m.isVerified &&
      m.costMatch !== false &&
      m.etaMatch !== false;

    const allSwiggyAcceptable = swiggyCartItems.length === items.length &&
                                swiggyMatches.every(isConstraintApproved);
    const allZeptoAcceptable = zeptoCartItems.length === items.length &&
                               zeptoMatches.every(isConstraintApproved);

    const [swiggyProposal, zeptoProposal] = await Promise.all([
      allSwiggyAcceptable
        ? this.swiggy.createCart(swiggyCartItems, location).catch(() => undefined)
        : undefined,
      allZeptoAcceptable
        ? this.zepto.createCart(zeptoCartItems, location).catch(() => undefined)
        : undefined,
    ]);

    const attachConstraintSummary = (proposal: QuickCommerceBasketProposal, matches: ProductMatchResult[]) => {
      proposal.constraintValidation = {
        allPassed: true,
        brandAccepted: matches.every((m) => m.brandMatch),
        costAccepted: matches.every((m) => m.costMatch !== false),
        quantityAccepted: matches.every((m) => m.inStock),
        etaAccepted: matches.every((m) => m.etaMatch !== false),
        details: matches.map((m) => `${m.requestedName} (${m.matchedItem?.name || 'verified'})`),
      };
    };

    // Attach resolved items context to proposals
    if (swiggyProposal && swiggyResolvedItems.length > 0) {
      swiggyProposal.resolvedItemsContext = swiggyResolvedItems;
      swiggyProposal.bestItem = swiggyResolvedItems[0];
      swiggyProposal.isPriceVerified = true;
      swiggyProposal.priceSource = swiggyProposal.priceSource || 'mcp_live';
      swiggyProposal.priceFreshness = new Date().toISOString();
      swiggyProposal.isEstimate = true;
      attachConstraintSummary(swiggyProposal, swiggyMatches);
    }

    if (zeptoProposal && zeptoResolvedItems.length > 0) {
      zeptoProposal.resolvedItemsContext = zeptoResolvedItems;
      zeptoProposal.bestItem = zeptoResolvedItems[0];
      zeptoProposal.isPriceVerified = true;
      zeptoProposal.priceSource = zeptoProposal.priceSource || 'mcp_live';
      zeptoProposal.priceFreshness = new Date().toISOString();
      zeptoProposal.isEstimate = true;
      attachConstraintSummary(zeptoProposal, zeptoMatches);
    }

    if (!swiggyProposal && !zeptoProposal) {
      const swiggyIssues = (swiggyMatches || [])
        .filter((m) => m && m.status !== 'verified_match')
        .map((m) => m.rejectionReason || `${m.requestedName}: ${m.status}`)
        .join('; ');
      const zeptoIssues = (zeptoMatches || [])
        .filter((m) => m && m.status !== 'verified_match')
        .map((m) => m.rejectionReason || `${m.requestedName}: ${m.status}`)
        .join('; ');

      const failureReasons: string[] = [];
      if (swiggyIssues) failureReasons.push(`Swiggy Instamart: [${swiggyIssues}]`);
      if (zeptoIssues) failureReasons.push(`Zepto: [${zeptoIssues}]`);

      throw new Error(
        `Items could not be fulfilled according to specified constraints for location ${location.pincode}: ${failureReasons.join(' | ') || 'No dark store satisfies all requested constraints.'}`
      );
    }

    // 4. Decision boundary: respect explicit merchant preference, or compare complete order totals
    let recommended: QuickCommerceBasketProposal;
    let reason = '';

    if (explicitMerchant === 'zepto') {
      if (zeptoProposal) {
        recommended = zeptoProposal;
        reason = 'User explicitly selected Zepto as preferred merchant.';
      } else {
        const missing = (zeptoMatches || []).filter((m) => m && m.status !== 'verified_match').map((m) => m.rejectionReason || m.requestedName);
        recommended = swiggyProposal!;
        reason = `User preferred Zepto, but Zepto dark store cannot fulfill: [${missing.join(', ')}]. Swiggy Instamart has all items verified at ₹${(swiggyProposal!.totalAmountCents / 100).toFixed(2)}. Explicit user approval required to switch merchants.`;
      }
    } else if (explicitMerchant === 'swiggy') {
      if (swiggyProposal) {
        recommended = swiggyProposal;
        reason = 'User explicitly selected Swiggy as preferred merchant.';
      } else {
        const missing = (swiggyMatches || []).filter((m) => m && m.status !== 'verified_match').map((m) => m.rejectionReason || m.requestedName);
        recommended = zeptoProposal!;
        reason = `User preferred Swiggy, but Swiggy Instamart dark store cannot fulfill: [${missing.join(', ')}]. Zepto has all items verified at ₹${(zeptoProposal!.totalAmountCents / 100).toFixed(2)}. Explicit user approval required to switch merchants.`;
      }
    } else if (swiggyProposal && zeptoProposal) {
      // Compare complete basket totals including all fees
      if (zeptoProposal.totalAmountCents < swiggyProposal.totalAmountCents) {
        recommended = zeptoProposal;
        reason = `Zepto complete order is cheaper (₹${(zeptoProposal.totalAmountCents / 100).toFixed(2)} vs ₹${(swiggyProposal.totalAmountCents / 100).toFixed(2)} on Swiggy, inclusive of delivery and taxes) and delivers in ${zeptoProposal.etaMinutes} mins.`;
      } else if (zeptoProposal.totalAmountCents === swiggyProposal.totalAmountCents) {
        recommended = zeptoProposal.etaMinutes <= swiggyProposal.etaMinutes ? zeptoProposal : swiggyProposal;
        reason = `Equal complete price (₹${(recommended.totalAmountCents / 100).toFixed(2)}); chosen based on faster ETA (${recommended.etaMinutes} mins).`;
      } else {
        recommended = swiggyProposal;
        reason = `Swiggy Instamart complete order is cheaper (₹${(swiggyProposal.totalAmountCents / 100).toFixed(2)} vs ₹${(zeptoProposal.totalAmountCents / 100).toFixed(2)} on Zepto, inclusive of delivery and taxes).`;
      }
    } else {
      recommended = (zeptoProposal || swiggyProposal)!;
      const isZepto = recommended.platform === 'zepto';
      const rejectedMerchant = isZepto ? 'Swiggy Instamart' : 'Zepto';
      const rejectedList = (isZepto ? swiggyMatches : zeptoMatches) || [];
      const rejectedIssues = rejectedList
        .filter((m) => m && m.status !== 'verified_match')
        .map((m) => m.rejectionReason || m.requestedName);
      reason = `Only ${recommended.merchantName} satisfied all requested brand, cost, quantity, and delivery time constraints (${rejectedMerchant} rejected: ${rejectedIssues.join(', ')}).`;
    }

    const resolvedItems = recommended.platform === 'zepto' ? zeptoResolvedItems : swiggyResolvedItems;
    recommended.bestItems = resolvedItems;
    if (!recommended.bestItem && resolvedItems.length > 0) {
      recommended.bestItem = resolvedItems[0];
    }

    if (zeptoProposal) {
      zeptoProposal.bestItems = zeptoResolvedItems;
      if (!zeptoProposal.bestItem && zeptoResolvedItems.length > 0) {
        zeptoProposal.bestItem = zeptoResolvedItems[0];
      }
    }

    if (swiggyProposal) {
      swiggyProposal.bestItems = swiggyResolvedItems;
      if (!swiggyProposal.bestItem && swiggyResolvedItems.length > 0) {
        swiggyProposal.bestItem = swiggyResolvedItems[0];
      }
    }

    recommended.handlingFeeCents = recommended.handlingFeeCents ?? 0;
    recommended.taxesCents = recommended.taxesCents ?? recommended.taxCents ?? 0;
    recommended.discountCents = recommended.discountCents ?? 0;

    const feesBreakdown: MultiPlatformComparison['feesBreakdown'] = {};
    if (swiggyProposal) {
      feesBreakdown.swiggy = {
        subtotalCents: swiggyProposal.subtotalCents,
        deliveryFeeCents: swiggyProposal.deliveryFeeCents,
        handlingFeeCents: swiggyProposal.handlingFeeCents || 0,
        taxesCents: swiggyProposal.taxCents,
        discountCents: swiggyProposal.discountCents || 0,
        totalAmountCents: swiggyProposal.totalAmountCents,
      };
    }
    if (zeptoProposal) {
      feesBreakdown.zepto = {
        subtotalCents: zeptoProposal.subtotalCents,
        deliveryFeeCents: zeptoProposal.deliveryFeeCents,
        handlingFeeCents: zeptoProposal.handlingFeeCents || 0,
        taxesCents: zeptoProposal.taxCents,
        discountCents: zeptoProposal.discountCents || 0,
        totalAmountCents: zeptoProposal.totalAmountCents,
      };
    }

    return {
      query: items.map((i) => `${i.quantity}x ${i.name}`).join(', '),
      swiggyProposal,
      zeptoProposal,
      recommendedProposal: recommended,
      recommendationReason: reason,
      priceSource: 'mcp_live',
      priceFreshness: new Date().toISOString(),
      productMatches: {
        swiggy: swiggyMatches,
        zepto: zeptoMatches,
      },
      feesBreakdown,
      isEstimate: true,
      unavailableFields: unavailableFields.length > 0 ? unavailableFields : undefined,
      splitBasketSupported: false,
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
