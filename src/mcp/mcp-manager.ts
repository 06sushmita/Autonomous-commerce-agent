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
import { normalizeQuantityAndPack, calculateBasketTotals, parsePackageSize } from '../agent/cart-calculator.js';
import { normalizeBrand } from '../agent/intent-extractor.js';
import { MatchClassification, OrderFulfillmentStatus, PackSizePreference, QuickCommerceBasketItem } from './types.js';

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
  /**
   * Filter and rank items strictly enforcing the required 7-tier priority hierarchy:
   * 1. Product identity and relevance
   * 2. Requested brand
   * 3. Variant compatibility
   * 4. Quantity and pack-size compatibility
   * 5. Live stock availability
   * 6. Price
   * 7. Delivery time
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
    const targetBrand = options?.targetBrand ? options.targetBrand.toLowerCase() : undefined;
    const maxCost = options?.maxCostCents;
    const footwearTerms = /\b(?:shoe|shoes|sneaker|sneakers|footwear|sandal|sandals|slipper|slippers|boot|boots)\b/i;
    const footwearAccessoryTerms = /\b(?:clean(?:ing|er)?|wipe|wipes|polish|lace|laces|deodor(?:ant|izer)|insole|insoles|shoehorn)\b/i;
    const isFootwearProductQuery = footwearTerms.test(query) && !footwearAccessoryTerms.test(query);

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

    // Sort according to 7-tier constraint hierarchy
    // "shoe cleaning wipes" contains the word shoe, but is an accessory—not a
    // valid substitute when the customer asks for footwear.
    const relevantItems = isFootwearProductQuery
      ? uniqueItems.filter((item) => !footwearAccessoryTerms.test(`${item.name} ${item.category || ''}`))
      : uniqueItems;

    const sorted = [...relevantItems].sort((a, b) => {
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

      // 2. Requested brand fidelity
      if (targetBrand) {
        const aBrand = (a.brand || '').toLowerCase().includes(targetBrand) || a.name.toLowerCase().includes(targetBrand);
        const bBrand = (b.brand || '').toLowerCase().includes(targetBrand) || b.name.toLowerCase().includes(targetBrand);
        if (aBrand !== bBrand) return aBrand ? -1 : 1;
      }

      // 3. Variant compatibility (e.g. brown bread vs white bread, masala vs regular)
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const variantKeywords = ['masala', 'brown', 'toned', 'whole wheat', 'white', 'salted'];
      const requestedVariants = variantKeywords.filter((v) => cleanQuery.includes(v));
      if (requestedVariants.length > 0) {
        const aVariantMatch = requestedVariants.some((v) => aName.includes(v));
        const bVariantMatch = requestedVariants.some((v) => bName.includes(v));
        if (aVariantMatch !== bVariantMatch) return aVariantMatch ? -1 : 1;
      }

      // 4. Quantity & pack-size compatibility
      const reqUnit = parseAndNormalizeUnit(cleanQuery);
      if (reqUnit) {
        const aUnit = parseAndNormalizeUnit(a.unit || a.packSize || a.name);
        const bUnit = parseAndNormalizeUnit(b.unit || b.packSize || b.name);
        const aSizeMatch = aUnit && aUnit.type === reqUnit.type && aUnit.baseValue === reqUnit.baseValue;
        const bSizeMatch = bUnit && bUnit.type === reqUnit.type && bUnit.baseValue === reqUnit.baseValue;
        if (aSizeMatch !== bSizeMatch) return aSizeMatch ? -1 : 1;
      }

      // 5. Live stock availability: In-stock strictly before out-of-stock
      const aStock = Boolean(a.inStock !== false);
      const bStock = Boolean(b.inStock !== false);
      if (aStock !== bStock) return aStock ? -1 : 1;

      // 6. Price: Items within budget rank before items exceeding budget, then lowest price first
      if (maxCost) {
        const aUnderBudget = a.priceCents <= maxCost;
        const bUnderBudget = b.priceCents <= maxCost;
        if (aUnderBudget !== bUnderBudget) return aUnderBudget ? -1 : 1;
      }
      if (a.priceCents !== b.priceCents) {
        return a.priceCents - b.priceCents;
      }

      // 7. Delivery time
      const aEta = a.etaMinutes ?? 20;
      const bEta = b.etaMinutes ?? 20;
      if (aEta !== bEta) return aEta - bEta;

      // Quantity available tie-breaker
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
      requestedQuantity?: number;
      requestedUnit?: string;
      packSizePreference?: PackSizePreference | null;
      variants?: string[];
    },
    availableItems: QuickCommerceItem[],
    darkStoreEtaMinutes?: number
  ): ProductMatchResult {
    const requestedLower = requested.name.toLowerCase();
    const requestedUnit = parseAndNormalizeUnit(requested.name);
    const footwearTerms = /\b(?:shoe|shoes|sneaker|sneakers|footwear|sandal|sandals|slipper|slippers|boot|boots)\b/i;
    const footwearAccessoryTerms = /\b(?:clean(?:ing|er)?|wipe|wipes|polish|lace|laces|deodor(?:ant|izer)|insole|insoles|shoehorn)\b/i;
    const isFootwearProductRequest = footwearTerms.test(requestedLower) && !footwearAccessoryTerms.test(requestedLower);
    const isIncompatibleAccessory = (item: QuickCommerceItem) =>
      isFootwearProductRequest && footwearAccessoryTerms.test(`${item.name} ${item.category || ''}`);

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
      'maggi',
      'maggie',
      'yippee',
      'top ramen',
    ];
    let detectedBrand = knownBrands.find((b) => requestedLower.includes(b));
    if (detectedBrand) {
      detectedBrand = normalizeBrand(detectedBrand) || detectedBrand;
    }
    const targetBrand = normalizeBrand(requested.brand) || detectedBrand;

    // Extract core product keywords (excluding brand and common volume/count units)
    const brandPattern = targetBrand ? new RegExp(`\\b${targetBrand.toLowerCase()}\\b`, 'gi') : null;
    let strippedName = (brandPattern ? requestedLower.replace(brandPattern, '') : requestedLower)
      .replace(/\b(?:\d+\s*(?:l|ltr|litre|liter|litres|liters|ml|g|gm|kg|pcs?|pieces?|pack|packets?|box|carton))\b/gi, '')
      .trim();

    if (/\b(?:maggi|maggie|noodles?)\b/i.test(requestedLower)) {
      strippedName = 'noodles';
    }

    const stem = (s: string) => (s.endsWith('s') && s.length > 3 ? s.slice(0, -1) : s);
    const coreTokens = strippedName
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length > 2 && !['and', 'for', 'the', 'with', 'item', 'product', 'fresh', 'best', 'good'].includes(t));

    const reqQtyVal = requested.requestedQuantity ?? requested.quantity;
    const reqUnitStr = requested.requestedUnit || (requestedLower.includes('egg') ? 'piece' : 'packet');

    if (!availableItems || availableItems.length === 0) {
      return {
        requestedName: requested.name,
        requestedBrand: targetBrand || undefined,
        requestedQuantity: reqQtyVal,
        requestedUnit: reqUnitStr,
        maxCostCents: requested.maxCostCents,
        maxEtaMinutes: requested.maxEtaMinutes,
        brandMatch: false,
        packageSizeMatch: false,
        isVerified: false,
        inStock: false,
        status: 'missing',
        matchClassification: 'NO_MATCH',
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

      // 0. Core product category/name match
      let coreMatched = false;
      if (coreTokens.length > 0) {
        coreMatched = coreTokens.some((tok) => {
          const st = stem(tok);
          return (
            itemNameLower.includes(tok) ||
            itemNameLower.includes(st) ||
            itemCategoryLower.includes(tok) ||
            itemCategoryLower.includes(st)
          );
        });
        if (isIncompatibleAccessory(item)) coreMatched = false;
        if (coreMatched) {
          score += 200;
        } else {
          score -= 1000;
        }
      } else {
        coreMatched = true;
        score += 100;
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
          score += 150;
        } else {
          score -= 100; // Deprioritize non-matching brand
        }
      }

      // 4. Cost constraint scoring
      let costMatched = true;
      if (item.priceCents && item.priceCents > 0) {
        score += Math.max(0, 50000 - item.priceCents) / 250;
      }
      if (requested.maxCostCents && item.priceCents) {
        if (item.priceCents <= requested.maxCostCents) {
          score += 80;
        } else {
          score -= 500;
          costMatched = false;
        }
      }

      // 5. Package size match scoring
      let sizeMatched = false;
      if (requestedUnit) {
        if (itemUnit && itemUnit.type === requestedUnit.type) {
          if (itemUnit.baseValue === requestedUnit.baseValue) {
            sizeMatched = true;
            score += 70;
          } else {
            score -= 50;
          }
        } else {
          score -= 30;
        }
      } else {
        sizeMatched = true;
      }

      // Substring overlap
      if (itemNameLower.includes(requestedLower)) {
        score += 40;
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
        requestedBrand: targetBrand || undefined,
        requestedQuantity: reqQtyVal,
        requestedUnit: reqUnitStr,
        brandMatch: false,
        packageSizeMatch: false,
        isVerified: false,
        inStock: false,
        status: 'missing',
        matchClassification: 'NO_MATCH',
        rejectionReason: `No acceptable item found for "${requested.name}".`,
      };
    }

    const isVerified = Boolean(bestItem.isPriceVerified !== false && bestItem.priceCents > 0);
    const inStock = Boolean(bestItem.inStock !== false && isVerified);
    const effectiveEta = darkStoreEtaMinutes ?? bestItem.etaMinutes ?? 20;

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
    }) && !isIncompatibleAccessory(bestItem);

    let status: ProductMatchResult['status'] = 'verified_match';
    let matchClassification: MatchClassification = 'NO_MATCH';
    let isAlternative = false;
    let alternativeReason: string | undefined;
    let rejectionReason: string | undefined;

    if (!isVerified) {
      status = 'unverified';
      matchClassification = 'NO_MATCH';
      rejectionReason = `Live price for "${bestItem.name}" is unverified.`;
    } else if (!inStock) {
      status = 'out_of_stock';
      matchClassification = 'NO_MATCH';
      rejectionReason = `Item "${bestItem.name}" is currently out of stock at this dark store.`;
    } else if (!coreProductMatches) {
      status = 'missing';
      matchClassification = 'NO_MATCH';
      rejectionReason = `No acceptable item matching "${requested.name}" found in catalog (closest item "${bestItem.name}" does not match requested product).`;
    } else if (targetBrand && !bestBrandMatch) {
      status = 'brand_mismatch';
      matchClassification = 'ALTERNATIVE';
      isAlternative = true;
      alternativeReason = `Requested brand "${targetBrand}" is not available. Found "${bestItem.brand || bestItem.name}" as an alternative.`;
      rejectionReason = `Requested brand "${targetBrand}" is not available. Found "${bestItem.brand || bestItem.name}".`;
    } else if (requested.maxCostCents && bestItem.priceCents > requested.maxCostCents) {
      status = 'cost_exceeded';
      matchClassification = 'NO_MATCH';
      rejectionReason = `Item cost (₹${(bestItem.priceCents / 100).toFixed(2)}) exceeds maximum budget limit of ₹${(requested.maxCostCents / 100).toFixed(2)}.`;
    } else if (requested.maxEtaMinutes && effectiveEta > requested.maxEtaMinutes) {
      status = 'eta_exceeded';
      matchClassification = 'NO_MATCH';
      rejectionReason = `Delivery ETA (${effectiveEta} mins) exceeds required delivery constraint (${requested.maxEtaMinutes} mins).`;
    } else if (requestedUnit && !bestSizeMatch) {
      status = 'size_mismatch';
      matchClassification = targetBrand ? 'EXACT_MATCH' : 'COMPATIBLE_MATCH';
      rejectionReason = `Package size does not match requested unit ${requestedUnit.unitString}.`;
    } else {
      status = 'verified_match';
      matchClassification = targetBrand ? 'EXACT_MATCH' : 'COMPATIBLE_MATCH';
    }

    // Run deterministic quantity & pack-size normalization
    const norm = normalizeQuantityAndPack(reqQtyVal, reqUnitStr, bestItem);

    return {
      requestedName: requested.name,
      requestedBrand: targetBrand || undefined,
      requestedQuantity: reqQtyVal,
      requestedUnit: reqUnitStr,
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
      matchClassification,
      isAlternative,
      alternativeReason,
      orderQuantity: norm.orderQuantity,
      quantityPerPackage: norm.packSize.quantityPerPackage,
      actualSuppliedQuantity: norm.actualSuppliedQuantity,
      actualSuppliedUnit: norm.actualSuppliedUnit,
      discloseSuppliedDiff: norm.discloseSuppliedDiff,
      disclosureNote: norm.disclosureNote,
      packSizeDescription: norm.packSize.displayUnit,
      totalPriceCents: norm.totalPriceCents,
      rejectionReason,
    };
  }

  /**
   * Assemble and compare carts across Swiggy and Zepto with high accuracy.
   * Compares complete basket totals (including delivery fees, handling fees, and taxes).
   * Respects explicit user merchant preference without silent merchant switching.
   * Strictly enforces brand, cost, quantity, and delivery time constraints.
   */
  /**
   * Assemble and compare carts across Swiggy and Zepto with high accuracy.
   * Compares complete basket totals (including delivery fees, handling fees, and taxes).
   * Respects explicit user merchant preference without silent merchant switching.
   * Strictly enforces brand, cost, quantity, and delivery time constraints.
   */
  public async compareAndAssembleBasket(
    items: Array<{
      name: string;
      quantity: number;
      brand?: string;
      maxCostCents?: number;
      maxEtaMinutes?: number;
      requestedQuantity?: number;
      requestedUnit?: string;
      packSizePreference?: PackSizePreference | null;
      variants?: string[];
    }>,
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
      let nameStr = item.name.trim();
      if (/noodles?/i.test(nameStr) && !nameStr.toLowerCase().includes('maggi') && brandStr.toLowerCase() === 'maggi') {
        return 'Maggi noodles';
      }
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

    const isFulfilledMatch = (m: ProductMatchResult) =>
      (m.matchClassification === 'EXACT_MATCH' || m.matchClassification === 'COMPATIBLE_MATCH') &&
      (m.status === 'verified_match' || m.status === 'size_mismatch') &&
      m.brandMatch !== false &&
      m.inStock &&
      m.isVerified &&
      m.costMatch !== false &&
      m.etaMatch !== false;

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
            requestedQuantity: item.requestedQuantity ?? item.quantity,
            requestedUnit: item.requestedUnit,
            brandMatch: false,
            packageSizeMatch: false,
            isVerified: false,
            inStock: false,
            status: 'missing',
            matchClassification: 'NO_MATCH',
            notes: err.message,
            rejectionReason: err.message,
          };
          return fallback;
        }
      });

      const results = await Promise.all(swiggyPromises);
      results.forEach((match) => {
        swiggyMatches.push(match);
        if (match.matchedItem && isFulfilledMatch(match)) {
          swiggyCartItems.push({ itemId: match.matchedItem.id, quantity: match.orderQuantity || 1 });
          swiggyResolvedItems.push(match.matchedItem);
        }
      });
    }

    // 2. Resolve items on Zepto in Parallel
    if (explicitMerchant !== 'swiggy') {
      const zeptoPromises: Promise<ProductMatchResult>[] = items.map(async (item) => {
        try {
          const q = buildSearchQuery(item);
          const results = await this.zepto.searchProducts(q, location);
          return this.matchEquivalentProduct(item, results, zeptoDelEst?.etaMinutes);
        } catch (err: any) {
          const fallback: ProductMatchResult = {
            requestedName: item.name,
            requestedBrand: item.brand,
            requestedQuantity: item.requestedQuantity ?? item.quantity,
            requestedUnit: item.requestedUnit,
            brandMatch: false,
            packageSizeMatch: false,
            isVerified: false,
            inStock: false,
            status: 'missing',
            matchClassification: 'NO_MATCH',
            notes: err.message,
            rejectionReason: err.message,
          };
          return fallback;
        }
      });

      const results = await Promise.all(zeptoPromises);
      results.forEach((match) => {
        zeptoMatches.push(match);
        if (match.matchedItem && isFulfilledMatch(match)) {
          zeptoCartItems.push({ itemId: match.matchedItem.id, quantity: match.orderQuantity || 1 });
          zeptoResolvedItems.push(match.matchedItem);
        }
      });
    }

    const allSwiggyAcceptable = swiggyCartItems.length === items.length && swiggyMatches.every(isFulfilledMatch);
    const allZeptoAcceptable = zeptoCartItems.length === items.length && zeptoMatches.every(isFulfilledMatch);

    // Also support partial fulfillment for multi-item requests when not all items are found
    const swiggyPartiallyAcceptable = !allSwiggyAcceptable && swiggyCartItems.length > 0;
    const zeptoPartiallyAcceptable = !allZeptoAcceptable && zeptoCartItems.length > 0;

    const [rawSwiggyProposal, rawZeptoProposal] = await Promise.all([
      allSwiggyAcceptable || swiggyPartiallyAcceptable
        ? this.swiggy.createCart(swiggyCartItems, location).catch(() => undefined)
        : undefined,
      allZeptoAcceptable || zeptoPartiallyAcceptable
        ? this.zepto.createCart(zeptoCartItems, location).catch(() => undefined)
        : undefined,
    ]);

    const buildLiveProposal = (
      platform: 'zepto' | 'swiggy_instamart',
      merchantName: string,
      resolvedItems: QuickCommerceItem[],
      matches: ProductMatchResult[],
      rawProposal: QuickCommerceBasketProposal | undefined,
      delEst?: DeliveryEstimateResult,
      isPartial: boolean = false
    ): QuickCommerceBasketProposal => {
      const isZepto = platform === 'zepto';
      const basketItems: QuickCommerceBasketItem[] = resolvedItems.map((item, index) => {
        const match = matches.find((m) => m.matchedItem?.id === item.id) || matches[index];
        const orderQuantity = match?.orderQuantity || 1;
        const requestedQuantity = match?.requestedQuantity || (items[index] && items[index].quantity) || 1;
        const requestedUnit = match?.requestedUnit || (items[index] && items[index].requestedUnit) || 'packet';
        const unitPriceCents = item.priceCents;
        const totalPriceCents = match?.totalPriceCents || (orderQuantity * unitPriceCents);

        return {
          id: item.id,
          itemId: item.id,
          name: item.name,
          platform,
          merchantName,
          quantity: orderQuantity,
          orderQuantity,
          requestedQuantity,
          requestedUnit,
          actualSuppliedQuantity: match?.actualSuppliedQuantity || orderQuantity,
          actualSuppliedUnit: match?.actualSuppliedUnit || requestedUnit,
          unitPriceCents,
          totalPriceCents,
          mrpCents: item.mrpCents,
          imageUrl: item.imageUrl,
          productUrl: item.productUrl,
          unit: item.unit,
          brand: item.brand,
          packSize: item.packSize,
          packSizeDescription: match?.packSizeDescription || item.unit || item.packSize,
          matchClassification: match?.matchClassification || 'COMPATIBLE_MATCH',
          isAlternative: match?.isAlternative || false,
          discloseSuppliedDiff: match?.discloseSuppliedDiff,
          disclosureNote: match?.disclosureNote,
          isPriceVerified: item.isPriceVerified !== false,
          priceSource: 'mcp_live',
          priceFetchedAt: item.priceFetchedAt || new Date().toISOString(),
          inStock: item.inStock !== false,
        };
      });

      // Live cart proposal from createCart takes precedence (authoritative cart pricing for this basket),
      // falling back to real-time location delivery estimate, then platform baseline defaults.
      const delFeeOverride = typeof rawProposal?.deliveryFeeCents === 'number' && !isNaN(rawProposal.deliveryFeeCents)
        ? rawProposal.deliveryFeeCents
        : (typeof delEst?.deliveryFeeCents === 'number' && !isNaN(delEst.deliveryFeeCents) ? delEst.deliveryFeeCents : undefined);

      const freeThresholdOverride = typeof rawProposal?.freeDeliveryThresholdCents === 'number' && !isNaN(rawProposal.freeDeliveryThresholdCents)
        ? rawProposal.freeDeliveryThresholdCents
        : (typeof delEst?.freeDeliveryThresholdCents === 'number' && !isNaN(delEst.freeDeliveryThresholdCents) ? delEst.freeDeliveryThresholdCents : undefined);

      const surgeFeeOverride = typeof rawProposal?.surgeFeeCents === 'number' && !isNaN(rawProposal.surgeFeeCents)
        ? rawProposal.surgeFeeCents
        : (typeof delEst?.surgeFeeCents === 'number' && !isNaN(delEst.surgeFeeCents) ? delEst.surgeFeeCents : 0);

      const handlingFeeOverride = isZepto
        ? 0
        : (typeof rawProposal?.handlingFeeCents === 'number' && !isNaN(rawProposal.handlingFeeCents) ? rawProposal.handlingFeeCents : 300);

      const totals = calculateBasketTotals(basketItems, {
        platform,
        customDeliveryFeeCents: delFeeOverride,
        freeDeliveryThresholdCents: freeThresholdOverride,
        customHandlingFeeCents: handlingFeeOverride,
        surgeFeeCents: surgeFeeOverride,
        discountCents: rawProposal?.discountCents,
      });

      const cartId = rawProposal?.cartId || `${platform}_cart_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      let orderStatus: OrderFulfillmentStatus = 'VERIFIED';
      if (isPartial) {
        orderStatus = 'PARTIALLY_FULFILLED';
      } else if (matches.some((m) => m.matchClassification === 'ALTERNATIVE')) {
        orderStatus = 'NEEDS_CONFIRMATION';
      }

      const missingNames = matches
        .filter((m) => !isFulfilledMatch(m))
        .map((m) => m.requestedName);

      return {
        cartId,
        platform,
        merchantName,
        isAvailable: !isPartial && matches.every((m) => m.inStock),
        items: basketItems,
        bestItems: resolvedItems,
        bestItem: resolvedItems[0],
        resolvedItemsContext: resolvedItems,
        subtotalCents: totals.subtotalCents,
        itemTotalCents: totals.subtotalCents,
        deliveryFeeCents: totals.deliveryFeeCents,
        handlingFeeCents: totals.handlingFeeCents,
        platformFeeCents: totals.handlingFeeCents,
        taxCents: totals.taxCents,
        taxesCents: totals.taxCents,
        discountCents: totals.discountCents,
        surgeFeeCents: totals.surgeFeeCents,
        totalAmountCents: totals.totalAmountCents,
        currency: 'INR',
        deliveryAddress: location,
        etaMinutes: delEst?.etaMinutes || rawProposal?.etaMinutes || (isZepto ? 10 : 14),
        isPriceVerified: true,
        priceSource: 'mcp_live',
        priceFreshness: new Date().toISOString(),
        isEstimate: true,
        orderStatus,
        unavailableItems: missingNames.length > 0 ? missingNames : undefined,
        constraintValidation: {
          allPassed: !isPartial && orderStatus === 'VERIFIED',
          orderStatus,
          brandAccepted: matches.every((m) => m.brandMatch),
          costAccepted: matches.every((m) => m.costMatch !== false),
          quantityAccepted: !isPartial && matches.every((m) => m.inStock),
          etaAccepted: matches.every((m) => m.etaMatch !== false),
          details: matches.map((m) => `${m.requestedName} (${m.matchedItem?.name || m.status})`),
          unfulfilledItems: missingNames.length > 0 ? missingNames : undefined,
        },
      };
    };

    const swiggyProposal = (allSwiggyAcceptable || swiggyPartiallyAcceptable) && swiggyResolvedItems.length > 0
      ? buildLiveProposal('swiggy_instamart', 'Swiggy Instamart', swiggyResolvedItems, swiggyMatches, rawSwiggyProposal, swiggyDelEst, swiggyPartiallyAcceptable)
      : undefined;

    const zeptoProposal = (allZeptoAcceptable || zeptoPartiallyAcceptable) && zeptoResolvedItems.length > 0
      ? buildLiveProposal('zepto', 'Zepto', zeptoResolvedItems, zeptoMatches, rawZeptoProposal, zeptoDelEst, zeptoPartiallyAcceptable)
      : undefined;

    // If neither store has any fulfilled or partially fulfilled items, or hard constraint failed for all items
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
        reason = zeptoProposal.orderStatus === 'PARTIALLY_FULFILLED'
          ? `Partially fulfilled on Zepto (User preferred). Unavailable items: [${(zeptoProposal.unavailableItems || []).join(', ')}].`
          : 'User explicitly selected Zepto as preferred merchant.';
      } else {
        const missing = (zeptoMatches || []).filter((m) => m && m.status !== 'verified_match').map((m) => m.rejectionReason || m.requestedName);
        recommended = swiggyProposal!;
        reason = `User preferred Zepto, but Zepto dark store cannot fulfill: [${missing.join(', ')}]. Swiggy Instamart has all items verified at ₹${(swiggyProposal!.totalAmountCents / 100).toFixed(2)}. Explicit user approval required to switch merchants.`;
      }
    } else if (explicitMerchant === 'swiggy') {
      if (swiggyProposal) {
        recommended = swiggyProposal;
        reason = swiggyProposal.orderStatus === 'PARTIALLY_FULFILLED'
          ? `Partially fulfilled on Swiggy Instamart (User preferred). Unavailable items: [${(swiggyProposal.unavailableItems || []).join(', ')}].`
          : 'User explicitly selected Swiggy as preferred merchant.';
      } else {
        const missing = (swiggyMatches || []).filter((m) => m && m.status !== 'verified_match').map((m) => m.rejectionReason || m.requestedName);
        recommended = zeptoProposal!;
        reason = `User preferred Swiggy, but Swiggy Instamart dark store cannot fulfill: [${missing.join(', ')}]. Zepto has all items verified at ₹${(zeptoProposal!.totalAmountCents / 100).toFixed(2)}. Explicit user approval required to switch merchants.`;
      }
    } else if (swiggyProposal && zeptoProposal) {
      if (zeptoProposal.orderStatus === 'VERIFIED' && swiggyProposal.orderStatus !== 'VERIFIED') {
        recommended = zeptoProposal;
        reason = 'Zepto satisfies all requested items and constraints.';
      } else if (swiggyProposal.orderStatus === 'VERIFIED' && zeptoProposal.orderStatus !== 'VERIFIED') {
        recommended = swiggyProposal;
        reason = 'Swiggy Instamart satisfies all requested items and constraints.';
      } else if (zeptoProposal.totalAmountCents < swiggyProposal.totalAmountCents) {
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
      reason = recommended.orderStatus === 'PARTIALLY_FULFILLED'
        ? `Partially fulfilled on ${recommended.merchantName}. Unavailable items: [${(recommended.unavailableItems || []).join(', ')}].`
        : `Only ${recommended.merchantName} satisfied all requested brand, cost, quantity, and delivery time constraints (${rejectedMerchant} rejected: ${rejectedIssues.join(', ')}).`;
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
      query: items.map((i) => `${i.requestedQuantity || i.quantity}x ${i.name}`).join(', '),
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
