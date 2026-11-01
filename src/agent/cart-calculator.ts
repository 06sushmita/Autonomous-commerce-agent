/**
 * Autonomous Commerce Agent - Cart Calculator & Quantity Normalizer
 *
 * Centralizes all quantity normalization, package size interpretation,
 * and monetary calculations in a deterministic module.
 *
 * Rules:
 *  - Keep separate:
 *     1. requestedQuantity (what the user wants)
 *     2. requestedUnit (piece, packet, litre, kg, etc.)
 *     3. packSize (what one package contains)
 *     4. orderQuantity (how many packages to purchase: Math.ceil(requestedQuantity / quantityPerPackage))
 *     5. unitPrice (price of 1 purchasable package)
 *     6. totalPrice (orderQuantity * unitPrice)
 *  - NEVER calculate pieces * unitPrice (e.g. 6 eggs at ₹48/pack is 1 * ₹48 = ₹48, NEVER 6 * ₹48).
 *  - If user requests fewer pieces than a package contains (e.g. 2 eggs when pack is 6),
 *    order 1 pack and disclose the actual quantity supplied (6 eggs).
 *  - If user requested unit is "packets" / "packs", count packages directly.
 *  - Monetary arithmetic in integer paise (cents) without floating-point errors.
 */

import { QuickCommerceItem, QuickCommerceBasketItem } from '../mcp/types.js';

export interface ParsedPackageSize {
  raw: string;
  type: 'count' | 'volume' | 'weight' | 'unit';
  quantityPerPackage: number; // e.g. 6 pieces, 1000 ml, 400 g
  displayUnit: string;        // e.g. "6 pcs", "1 L", "400 g"
  baseUnit: string;           // "piece", "ml", "g", "packet"
}

export interface QuantityNormalizationResult {
  requestedQuantity: number;
  requestedUnit: string;
  packSize: ParsedPackageSize;
  orderQuantity: number;
  actualSuppliedQuantity: number;
  actualSuppliedUnit: string;
  unitPriceCents: number;
  totalPriceCents: number;
  discloseSuppliedDiff: boolean;
  disclosureNote?: string;
}

export interface BasketTotalsCalculation {
  subtotalCents: number;
  deliveryFeeCents: number;
  handlingFeeCents: number;
  taxCents: number;
  surgeFeeCents: number;
  discountCents: number;
  totalAmountCents: number;
}

/**
 * Parses package size information from QuickCommerceItem unit, packSize, and name
 */
export function parsePackageSize(item: QuickCommerceItem): ParsedPackageSize {
  const textCandidates = [
    item.unit || '',
    item.packSize || '',
    item.name || '',
  ].filter(Boolean);

  const fullText = textCandidates.join(' ').toLowerCase();

  // 1. Egg or count-based pack: e.g. "6 pcs", "6 pieces", "pack of 6", "1 pack (6 pcs)", "6 eggs", "10 count"
  const countMatch =
    fullText.match(/(?:pack\s+of\s+|1\s*pack\s*\(\s*)(\d+)\s*(?:pcs?|pieces?|eggs?|units?|count)\)?/i) ||
    fullText.match(/(\d+)\s*(?:pcs|pieces?|eggs?|count|units?)\b/i);

  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    if (!isNaN(count) && count > 0) {
      return {
        raw: countMatch[0],
        type: 'count',
        quantityPerPackage: count,
        displayUnit: `${count} pcs`,
        baseUnit: 'piece',
      };
    }
  }

  // 2. Volume: Litre / ml (e.g. "1 L", "1.5 L", "1000 ml pouch", "500 ml")
  const literMatch = fullText.match(/(\d+(?:\.\d+)?)\s*(?:l|ltr|litre|liter|litres|liters)\b/i);
  if (literMatch) {
    const l = parseFloat(literMatch[1]);
    return {
      raw: literMatch[0],
      type: 'volume',
      quantityPerPackage: Math.round(l * 1000), // in ml
      displayUnit: `${l} L`,
      baseUnit: 'ml',
    };
  }

  const mlMatch = fullText.match(/(\d+(?:\.\d+)?)\s*(?:ml|millilitre|milliliter)\b/i);
  if (mlMatch) {
    const ml = Math.round(parseFloat(mlMatch[1]));
    return {
      raw: mlMatch[0],
      type: 'volume',
      quantityPerPackage: ml,
      displayUnit: `${ml} ml`,
      baseUnit: 'ml',
    };
  }

  // 3. Weight: kg / g (e.g. "1 kg", "500 g", "400 g", "100 g")
  const kgMatch = fullText.match(/(\d+(?:\.\d+)?)\s*(?:kg|kilo|kilogram|kilograms)\b/i);
  if (kgMatch) {
    const kg = parseFloat(kgMatch[1]);
    return {
      raw: kgMatch[0],
      type: 'weight',
      quantityPerPackage: Math.round(kg * 1000), // in g
      displayUnit: `${kg} kg`,
      baseUnit: 'g',
    };
  }

  const gMatch = fullText.match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/i);
  if (gMatch) {
    const g = Math.round(parseFloat(gMatch[1]));
    return {
      raw: gMatch[0],
      type: 'weight',
      quantityPerPackage: g,
      displayUnit: `${g} g`,
      baseUnit: 'g',
    };
  }

  // Default to 1 pack / unit
  return {
    raw: item.unit || item.packSize || '1 pack',
    type: 'unit',
    quantityPerPackage: 1,
    displayUnit: item.unit || item.packSize || '1 pack',
    baseUnit: 'packet',
  };
}

/**
 * Normalizes requested quantity and package size according to compatibility rules.
 */
export function normalizeQuantityAndPack(
  requestedQuantity: number,
  requestedUnit: string,
  catalogItem: QuickCommerceItem
): QuantityNormalizationResult {
  const reqQty = Math.max(1, requestedQuantity || 1);
  const normReqUnit = (requestedUnit || 'packet').toLowerCase().trim();
  const pack = parsePackageSize(catalogItem);
  const unitPriceCents = catalogItem.priceCents;

  let orderQuantity = 1;
  let actualSuppliedQuantity = 1;
  let actualSuppliedUnit = 'packet';
  let discloseSuppliedDiff = false;
  let disclosureNote: string | undefined;

  // Case 1: User explicitly requested packages / packets / loaves / boxes / bottles / cartons
  if (
    /^(?:packets?|packs?|boxes?|cartons?|bottles?|cans?|loaf|loaves)$/i.test(normReqUnit)
  ) {
    orderQuantity = Math.max(1, Math.round(reqQty));
    actualSuppliedQuantity = orderQuantity;
    actualSuppliedUnit = 'pack';
  }
  // Case 2: User requested count / pieces (e.g. "6 eggs", "12 eggs", "2 pieces")
  else if (
    /^(?:piece|pieces|pcs|eggs?|count|units?|items?)$/i.test(normReqUnit)
  ) {
    if (pack.type === 'count' && pack.quantityPerPackage > 0) {
      // Required packages = Math.ceil(requestedQuantity / quantityPerPackage)
      orderQuantity = Math.max(1, Math.ceil(reqQty / pack.quantityPerPackage));
      actualSuppliedQuantity = orderQuantity * pack.quantityPerPackage;
      actualSuppliedUnit = 'pieces';

      if (reqQty < pack.quantityPerPackage) {
        discloseSuppliedDiff = true;
        disclosureNote = `Requested ${reqQty} eggs, but smallest package available contains ${pack.quantityPerPackage} pieces (1 pack supplied).`;
      } else if (actualSuppliedQuantity > reqQty) {
        disclosureNote = `Supplied ${actualSuppliedQuantity} pieces (${orderQuantity} packs of ${pack.quantityPerPackage} pcs).`;
      }
    } else {
      orderQuantity = Math.max(1, Math.round(reqQty));
      actualSuppliedQuantity = orderQuantity;
      actualSuppliedUnit = 'piece';
    }
  }
  // Case 3: User requested volume (e.g. "2 litres of milk", "500 ml")
  else if (
    /^(?:l|ltr|litre|liter|litres|liters|ml)$/i.test(normReqUnit)
  ) {
    if (pack.type === 'volume' && pack.quantityPerPackage > 0) {
      const requestedMl = normReqUnit.startsWith('l') ? Math.round(reqQty * 1000) : Math.round(reqQty);
      orderQuantity = Math.max(1, Math.ceil(requestedMl / pack.quantityPerPackage));
      actualSuppliedQuantity = (orderQuantity * pack.quantityPerPackage) / 1000;
      actualSuppliedUnit = 'L';
      if (orderQuantity * pack.quantityPerPackage > requestedMl) {
        discloseSuppliedDiff = true;
        disclosureNote = `Supplied ${(orderQuantity * pack.quantityPerPackage) / 1000} L (${orderQuantity} packs of ${pack.displayUnit}).`;
      }
    } else {
      orderQuantity = Math.max(1, Math.round(reqQty));
      actualSuppliedQuantity = orderQuantity;
      actualSuppliedUnit = normReqUnit;
    }
  }
  // Case 4: User requested weight (e.g. "1 kg", "500 g")
  else if (
    /^(?:kg|kilo|kilogram|kilograms|g|gm|gms|gram|grams)$/i.test(normReqUnit)
  ) {
    if (pack.type === 'weight' && pack.quantityPerPackage > 0) {
      const requestedG = normReqUnit.startsWith('k') ? Math.round(reqQty * 1000) : Math.round(reqQty);
      orderQuantity = Math.max(1, Math.ceil(requestedG / pack.quantityPerPackage));
      actualSuppliedQuantity = (orderQuantity * pack.quantityPerPackage) / 1000;
      actualSuppliedUnit = 'kg';
      if (orderQuantity * pack.quantityPerPackage > requestedG) {
        discloseSuppliedDiff = true;
        disclosureNote = `Supplied ${(orderQuantity * pack.quantityPerPackage) / 1000} kg (${orderQuantity} packs of ${pack.displayUnit}).`;
      }
    } else {
      orderQuantity = Math.max(1, Math.round(reqQty));
      actualSuppliedQuantity = orderQuantity;
      actualSuppliedUnit = normReqUnit;
    }
  }
  // Fallback: standard unit packaging
  else {
    orderQuantity = Math.max(1, Math.round(reqQty));
    actualSuppliedQuantity = orderQuantity;
    actualSuppliedUnit = normReqUnit;
  }

  // Safe monetary calculation: integer paise
  const totalPriceCents = Math.round(orderQuantity * unitPriceCents);

  return {
    requestedQuantity: reqQty,
    requestedUnit: normReqUnit,
    packSize: pack,
    orderQuantity,
    actualSuppliedQuantity,
    actualSuppliedUnit,
    unitPriceCents,
    totalPriceCents,
    discloseSuppliedDiff,
    disclosureNote,
  };
}

/**
 * Calculates complete cart financials using safe integer paise arithmetic
 */
export function calculateBasketTotals(
  items: Array<{ orderQuantity?: number; quantity?: number; unitPriceCents: number }>,
  options?: {
    platform?: 'swiggy_instamart' | 'zepto';
    customDeliveryFeeCents?: number;
    freeDeliveryThresholdCents?: number;
    customHandlingFeeCents?: number;
    surgeFeeCents?: number;
    discountCents?: number;
  }
): BasketTotalsCalculation {
  const isZepto = options?.platform === 'zepto';

  let subtotalCents = 0;
  for (const it of items) {
    const qty = it.orderQuantity ?? it.quantity ?? 1;
    const price = typeof it.unitPriceCents === 'number' && !isNaN(it.unitPriceCents) ? it.unitPriceCents : 0;
    subtotalCents += Math.round(qty * price);
  }

  // Free delivery threshold: from merchant cart proposal, estimate, or platform default (Zepto ₹149, Swiggy ₹199)
  const freeThreshold =
    typeof options?.freeDeliveryThresholdCents === 'number' && !isNaN(options.freeDeliveryThresholdCents)
      ? options.freeDeliveryThresholdCents
      : (isZepto ? 14900 : 19900);

  const baseDeliveryFee = isZepto ? 2000 : 2500;

  const customDel =
    typeof options?.customDeliveryFeeCents === 'number' && !isNaN(options.customDeliveryFeeCents)
      ? options.customDeliveryFeeCents
      : undefined;

  const deliveryFeeCents =
    subtotalCents >= freeThreshold
      ? 0
      : (customDel !== undefined ? customDel : baseDeliveryFee);

  const customHandling =
    typeof options?.customHandlingFeeCents === 'number' && !isNaN(options.customHandlingFeeCents)
      ? options.customHandlingFeeCents
      : undefined;

  const handlingFeeCents =
    customHandling !== undefined
      ? customHandling
      : (isZepto ? 0 : 300);

  const surgeFeeCents =
    typeof options?.surgeFeeCents === 'number' && !isNaN(options.surgeFeeCents)
      ? options.surgeFeeCents
      : 0;

  const discountCents =
    typeof options?.discountCents === 'number' && !isNaN(options.discountCents)
      ? options.discountCents
      : 0;

  // 5% standard GST
  const taxCents = Math.round(subtotalCents * 0.05);

  const totalAmountCents = Math.max(
    0,
    subtotalCents + deliveryFeeCents + handlingFeeCents + surgeFeeCents + taxCents - discountCents
  );

  return {
    subtotalCents,
    deliveryFeeCents,
    handlingFeeCents,
    taxCents,
    surgeFeeCents,
    discountCents,
    totalAmountCents,
  };
}
