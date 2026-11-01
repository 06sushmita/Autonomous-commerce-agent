/**
 * Autonomous Commerce Agent - Intent Extractor
 *
 * Converts natural-language shopping requests into structured shopping intents.
 * Extracts:
 *  - Product name
 *  - Requested brand (with brand normalization, e.g. "maggie" -> "Maggi")
 *  - Requested quantity
 *  - Requested unit (piece, packet, litre, kg, gram, etc.)
 *  - Preferred package size (e.g. 1L, 500g)
 *  - Product variants
 *  - Budget / cost constraints
 *  - Delivery / ETA constraints
 *  - Explicit user merchant preference
 */

import { ShoppingIntent, ShoppingIntentItem, PackSizePreference } from '../mcp/types.js';

// Canonical brand dictionary and normalization mapping
const BRAND_CANONICAL_MAP: Record<string, string> = {
  'maggi': 'Maggi',
  'maggie': 'Maggi',
  'maggy': 'Maggi',
  'nandini': 'Nandini',
  'amul': 'Amul',
  'britannia': 'Britannia',
  'eggoz': 'Eggoz',
  'the health factory': 'The Health Factory',
  'health factory': 'The Health Factory',
  'milky mist': 'Milky Mist',
  'mother dairy': 'Mother Dairy',
  'fortune': 'Fortune',
  'aashirvaad': 'Aashirvaad',
  'nestle': 'Nestle',
  'cadbury': 'Cadbury',
  'safal': 'Safal',
  'suguna': 'Suguna',
  'yippee': 'Yippee',
  'sunfeast yippee': 'Yippee',
  'top ramen': 'Top Ramen',
  'lays': "Lay's",
  "lay's": "Lay's",
  'kelloggs': "Kellogg's",
  "kellogg's": "Kellogg's",
  'epigamia': 'Epigamia',
  'dhaaba': 'Dhaaba',
};

// Known brands sorted by length descending so longer brand phrases match first
const KNOWN_BRANDS_SORTED = Object.keys(BRAND_CANONICAL_MAP).sort((a, b) => b.length - a.length);

/**
 * Normalizes brand name (e.g. "maggie" -> "Maggi")
 */
export function normalizeBrand(rawBrand?: string): string | null {
  if (!rawBrand) return null;
  const clean = rawBrand.trim().toLowerCase();
  return BRAND_CANONICAL_MAP[clean] || (rawBrand.charAt(0).toUpperCase() + rawBrand.slice(1));
}

/**
 * Extracts global ETA constraint in minutes from query string
 */
export function extractEtaConstraint(query: string): number | undefined {
  const match = query.match(/(?:in\s+under|under|within|in|less than)\s*(\d+)\s*(?:mins?|minutes?)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  if (/\b(?:fast|urgent|urgently|asap)\b/i.test(query)) {
    return 15;
  }
  return undefined;
}

/**
 * Extracts cost constraint from a string
 */
export function extractCostConstraint(text: string): number | undefined {
  const match = text.match(
    /(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?|under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?))|(?:(?:budget\s*(?:of|is)?|under|below|max|within|less than)\s*(\d+(?:\.\d+)?)\s*(?:rs|rupees|inr|bucks))\b/i
  );
  if (match) {
    const valStr = match[1] || match[2];
    if (valStr) {
      return Math.round(parseFloat(valStr) * 100);
    }
  }
  return undefined;
}

/**
 * Extracts global budget constraint (e.g. "budget under 100 rs", "total under ₹300", "under ₹300")
 */
export function extractGlobalCostConstraint(query: string): number | undefined {
  const globalMatch = query.match(
    /(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?)\s*(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?))|(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?)\s*(\d+(?:\.\d+)?)\s*(?:rs|rupees|inr|bucks))\b/i
  );
  if (globalMatch) {
    const valStr = globalMatch[1] || globalMatch[2];
    if (valStr) return Math.round(parseFloat(valStr) * 100);
  }

  // Trailing global budget: e.g. "Order milk and eggs under ₹300"
  const trailingMatch = query.match(/(?:(?:budget|total|order)\s+)?(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)\.?$/i);
  if (trailingMatch) {
    return Math.round(parseFloat(trailingMatch[1]) * 100);
  }

  return undefined;
}

/**
 * Parses user natural language shopping input into a structured ShoppingIntent
 */
export function extractShoppingIntent(query: string): ShoppingIntent {
  const rawQuery = query;
  const globalMaxEtaMinutes = extractEtaConstraint(query);
  const globalBudgetCents = extractGlobalCostConstraint(query) ?? extractCostConstraint(query);

  const lowerQuery = query.toLowerCase();
  const explicitMerchant: 'swiggy' | 'zepto' | undefined =
    lowerQuery.includes('zepto')
      ? 'zepto'
      : lowerQuery.includes('swiggy')
      ? 'swiggy'
      : undefined;

  // 1. Remove conversational prefix and follow-up directives
  let clean = query
    .replace(/(?:[\r\n]+|\.\s+)(?:if\s+i\s+(?:am\s+)?asking|please\s+(?:show|give|make|pick)|make\s+sure|i\s+want\s+best|give\s+me\s+best).+$/is, '')
    .replace(/^(?:find|search|get|order|buy|show|look for|fetch|i want|please get me|bring me)\s+(?:me\s+)?/i, '')
    .replace(/\s+(?:in under \d+ mins?|in \d+ mins?|under \d+ mins?|within \d+ mins?|fast|urgent|quickly|asap|from swiggy|from zepto|near me)\.?$/gi, '')
    .trim();

  // If entire query was "budget under ₹300" with nothing else, preserve clean
  if (clean.length === 0) {
    clean = query.trim();
  }

  // Only remove trailing global budget clause if query had a global "budget under ..." or "total under ..."
  clean = clean
    .replace(/(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?)\s*(?:₹|rs\.?|inr)\s*\d+(?:\.\d+)?)/gi, '')
    .replace(/(?:(?:budget\s*(?:of|is)?|total\s*(?:under|below|max)?)\s*\d+(?:\.\d+)?\s*(?:rs|rupees|inr|bucks)\b)/gi, '')
    .trim();

  // 2. Split into independent product segments
  // Matches commas, Oxford commas ("milk, bread, and eggs"), "and", "&", "+"
  const rawSegments = clean
    .split(/(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i)
    .map((s) => s.trim().replace(/^,\s*/, '').replace(/\s*\.$/, ''))
    .filter((s) => s.length > 0);

  const items: ShoppingIntentItem[] = [];

  for (const rawSegment of rawSegments) {
    let seg = rawSegment;

    // Per-segment price constraint
    let itemCostCents = extractCostConstraint(seg);
    if (!itemCostCents && rawSegments.length === 1) {
      itemCostCents = globalBudgetCents;
    }
    seg = seg
      .replace(/(?:under|below|max|within|less than)\s*(?:₹|rs\.?|inr)\s*\d+(?:\.\d+)?/gi, '')
      .replace(/(?:under|below|max|within|less than)\s*\d+(?:\.\d+)?\s*(?:rs|rupees|inr|bucks)/gi, '')
      .trim();

    // Per-segment ETA constraint
    let itemEtaMinutes = extractEtaConstraint(seg) ?? globalMaxEtaMinutes;
    seg = seg.replace(/(?:in\s+under|under|within|in)\s*\d+\s*(?:mins?|minutes?)/gi, '').trim();

    // Detect requested brand
    let detectedBrand: string | null = null;
    const lowerSeg = seg.toLowerCase();
    for (const b of KNOWN_BRANDS_SORTED) {
      const brandRegex = new RegExp(`\\b${b}\\b`, 'i');
      if (brandRegex.test(lowerSeg)) {
        detectedBrand = BRAND_CANONICAL_MAP[b];
        break;
      }
    }

    // Detect variants (e.g. "masala", "brown", "toned", "whole wheat", "double toned", "salted")
    const variants: string[] = [];
    const variantPatterns = ['masala', 'brown', 'toned', 'whole wheat', 'white', 'salted', 'unsalted', 'cow', 'buffalo'];
    for (const v of variantPatterns) {
      if (new RegExp(`\\b${v}\\b`, 'i').test(seg)) {
        variants.push(v);
      }
    }

    let requestedQuantity = 1;
    let requestedUnit = 'packet';
    let packSizePreference: PackSizePreference | null = null;

    // Special brand normalization for noodles: "maggie" / "maggi"
    if (/\b(?:maggie|maggi)\b/i.test(seg)) {
      detectedBrand = 'Maggi';
    }

    // Pattern A: "2 packets of 1L milk" or "1 packet of 500g butter" or "2 packs of 100g butter"
    const packetOfSizedItemMatch = seg.match(
      /^(\d+)\s*(?:packets?|packs?|boxes?|cartons?|bottles?|cans?|loaf|loaves)\s*(?:of\s+)?(\d+(?:\.\d+)?)\s*(l|ltr|litre|liter|litres|liter|ml|g|gm|gms|kg|kilo|pieces?|pcs?)\s+(.+)$/i
    );
    if (packetOfSizedItemMatch) {
      requestedQuantity = parseInt(packetOfSizedItemMatch[1], 10) || 1;
      requestedUnit = 'packet';
      const sizeVal = parseFloat(packetOfSizedItemMatch[2]);
      const rawUnit = packetOfSizedItemMatch[3].toLowerCase();
      const normUnit = rawUnit.startsWith('l') ? 'litre' : rawUnit.startsWith('m') ? 'ml' : rawUnit.startsWith('k') ? 'kg' : rawUnit.startsWith('p') ? 'piece' : 'gram';
      packSizePreference = { value: sizeVal, unit: normUnit };
      seg = packetOfSizedItemMatch[4].trim();
    } else {
      // Pattern B: "2 packets of milk", "1 bread packet", "1 packet bread", "6 pcs eggs"
      const leadingPacketMatch = seg.match(
        /^(\d+)\s*(packets?|packs?|boxes?|cartons?|bottles?|cans?|loaf|loaves|pcs?|pieces?)\s*(?:of\s+)?(.+)$/i
      );
      if (leadingPacketMatch) {
        requestedQuantity = parseInt(leadingPacketMatch[1], 10) || 1;
        const u = leadingPacketMatch[2].toLowerCase();
        requestedUnit = u.startsWith('pc') || u.startsWith('piece') ? 'piece' : 'packet';
        seg = leadingPacketMatch[3].trim();
      } else {
        // Pattern C: "2 litres of milk", "2 litres milk", "2l milk", "500g butter"
        const volumeWeightLeadingMatch = seg.match(
          /^(\d+(?:\.\d+)?)\s*(l|ltr|litre|liter|litres|liters|ml|kg|kilo|kilogram|kilograms|g|gm|gms|gram|grams)\s*(?:of\s+)?(.+)$/i
        );
        if (volumeWeightLeadingMatch) {
          requestedQuantity = parseFloat(volumeWeightLeadingMatch[1]) || 1;
          const u = volumeWeightLeadingMatch[2].toLowerCase();
          requestedUnit = u.startsWith('l') ? 'litre' : u.startsWith('m') ? 'ml' : u.startsWith('k') ? 'kg' : 'gram';
          packSizePreference = { value: requestedQuantity, unit: requestedUnit };
          seg = volumeWeightLeadingMatch[3].trim();
        } else {
          // Pattern D: "6 eggs", "12 eggs", "1 bread" (leading plain number)
          const leadingCountMatch = seg.match(/^(\d+)\s+([a-zA-Z].+)$/);
          if (leadingCountMatch && !/^\d+\s*(?:l|ltr|litre|ml|g|gm|kg)\b/i.test(seg)) {
            requestedQuantity = parseInt(leadingCountMatch[1], 10) || 1;
            seg = leadingCountMatch[2].trim();
            if (/\b(?:eggs?|pieces?|bananas?|apples?)\b/i.test(seg)) {
              requestedUnit = 'piece';
            } else {
              requestedUnit = 'packet';
            }
          } else {
            // Pattern E: Trailing count or packaging: "eggs 6", "eggs 6 pcs", "milk 2 packets"
            const trailingCountMatch = seg.match(
              /^(.+?)\s+(\d+)\s*(packets?|packs?|boxes?|bottles?|pcs?|pieces?|eggs?)?$/i
            );
            if (trailingCountMatch && !/\b(?:\d+\s*(?:l|ltr|litre|ml|g|gm|kg))\b/i.test(trailingCountMatch[2])) {
              requestedQuantity = parseInt(trailingCountMatch[2], 10) || 1;
              const u = (trailingCountMatch[3] || '').toLowerCase();
              requestedUnit = u.startsWith('pc') || u.startsWith('egg') || /\beggs?\b/i.test(seg) ? 'piece' : 'packet';
              seg = trailingCountMatch[1].trim();
            } else {
              // Pattern F: Standalone noun like "eggs" -> default 6 eggs (1 pack) or piece
              if (/\beggs?\b/i.test(seg)) {
                requestedUnit = 'piece';
                requestedQuantity = 6;
              } else {
                requestedUnit = 'packet';
                requestedQuantity = 1;
              }
            }
          }
        }
      }
    }

    // Check for volume/weight embedded in product name (e.g. "milk 1 litre", "butter 100g")
    const embeddedSizeMatch = seg.match(/(\d+(?:\.\d+)?)\s*(l|ltr|litre|liter|litres|ml|kg|g|gm|gms)\b/i);
    if (embeddedSizeMatch) {
      const val = parseFloat(embeddedSizeMatch[1]);
      const rawU = embeddedSizeMatch[2].toLowerCase();
      const normU = rawU.startsWith('l') ? 'litre' : rawU.startsWith('m') ? 'ml' : rawU.startsWith('k') ? 'kg' : 'gram';
      packSizePreference = { value: val, unit: normU };
      if (requestedUnit === 'packet' && (normU === 'litre' || normU === 'kg')) {
        requestedUnit = normU;
        requestedQuantity = val;
      }
    }

    // Product name cleaning
    let productName = seg.trim();

    // Normalize product name for Maggi/noodles
    if (/\b(?:maggie|maggi)\b/i.test(productName)) {
      detectedBrand = 'Maggi';
      if (/noodles?/i.test(productName)) {
        productName = productName.replace(/maggie/i, 'Maggi');
      } else {
        productName = 'Maggi noodles';
      }
    }

    productName = productName
      .replace(/^(?:packet|pack|packet of|pack of|box of|carton of)\s+/i, '')
      .trim();

    if (productName.length === 0) {
      productName = detectedBrand || 'groceries';
    }

    items.push({
      product: productName,
      brand: detectedBrand,
      requestedQuantity,
      requestedUnit,
      packSizePreference,
      variants: variants.length > 0 ? variants : undefined,
      maxCostCents: itemCostCents,
      maxEtaMinutes: itemEtaMinutes,
      explicitMerchant,
      rawQuerySegment: rawSegment,
    });
  }

  if (items.length === 0) {
    items.push({
      product: 'groceries',
      brand: null,
      requestedQuantity: 1,
      requestedUnit: 'packet',
      maxCostCents: globalBudgetCents,
      maxEtaMinutes: globalMaxEtaMinutes,
      explicitMerchant,
      rawQuerySegment: query,
    });
  }

  return {
    items,
    globalBudgetCents,
    globalMaxEtaMinutes,
    explicitMerchant,
    rawQuery,
  };
}
