/**
 * Types and interfaces for Quick-Commerce MCP Integrations (Swiggy & Zepto)
 */

export type QuickCommercePlatform = 'swiggy_instamart' | 'swiggy_food' | 'zepto';

export interface DeliveryLocation {
  address: string;
  pincode: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

export interface QuickCommerceItem {
  id: string;
  platform: QuickCommercePlatform;
  merchantName: string;
  name: string;
  category?: string;
  priceCents: number; // In Indian paise (100 paise = 1 INR)
  mrpCents?: number;
  currency: 'INR';
  inStock: boolean;
  quantityAvailable?: number;
  unit?: string; // e.g. "1 L", "500 g", "6 pcs"
  imageUrl?: string;
  productUrl?: string; // Direct link to product on merchant platform
  etaMinutes?: number;
  metadata?: Record<string, unknown>;
}

export interface ItemDetails extends QuickCommerceItem {
  description?: string;
  brand?: string;
  shelfLifeDays?: number;
  packSize?: string;
  nutritionalInfo?: Record<string, string>;
  countryOfOrigin?: string;
  fssaiLicense?: string;
}

export interface DeliveryEstimateResult {
  serviceable: boolean;
  platform: QuickCommercePlatform;
  pincode: string;
  etaMinutes: number;
  distanceKm?: number;
  deliveryFeeCents: number;
  freeDeliveryThresholdCents: number;
  surgeFeeCents: number;
  darkStoreId?: string;
  darkStoreName?: string;
  rainSurgeActive?: boolean;
}

export interface InventoryCheckResult {
  itemId: string;
  platform: QuickCommercePlatform;
  inStock: boolean;
  requestedQuantity: number;
  availableQuantity: number;
  item?: QuickCommerceItem;
  lowStockWarning?: boolean;
  nextRestockEstimate?: string;
}

export interface QuickCommerceBasketItem {
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  mrpCents?: number;
  imageUrl?: string;
  productUrl?: string;
  unit?: string;
  brand?: string;
}

export interface QuickCommerceBasketProposal {
  platform: QuickCommercePlatform;
  merchantName: string;
  items: QuickCommerceBasketItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  totalAmountCents: number;
  currency: 'INR';
  etaMinutes: number;
  deliveryAddress: DeliveryLocation;
  isAvailable: boolean;
  unavailableItems?: string[];
  cartId: string;
  bestItem?: QuickCommerceItem;
  itemTotalCents?: number;
  surgeFeeCents?: number;
  taxesCents?: number;
  darkStoreName?: string;
  rainSurgeActive?: boolean;
  freeDeliveryThresholdCents?: number;
}

export interface OrderCheckoutResult {
  success: boolean;
  platform: QuickCommercePlatform;
  orderId: string;
  trackingUrl?: string;
  etaMinutes: number;
  totalChargedCents: number;
  currency: 'INR';
  receiptSummary: {
    itemsCount: number;
    platform: string;
    deliveryAddress: string;
    deliveredAtEstimate: string;
  };
}

export interface McpToolCallResult<T = unknown> {
  toolName: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentPlugin {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}
