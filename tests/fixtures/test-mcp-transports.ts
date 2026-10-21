import { MockMcpTransport } from '../../src/mcp/transport.js';
import { QuickCommerceItem, ItemDetails, DeliveryEstimateResult } from '../../src/mcp/types.js';

export function createTestSwiggyTransport(): MockMcpTransport {
  const transport = new MockMcpTransport();

  transport.registerToolHandler('swiggy_im_search_items', async (args) => {
    const q = String(args.query || '').toLowerCase();
    const items: ItemDetails[] = [
      {
        id: 'swiggy_im_nandini_milk_1l',
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        name: 'Nandini Pasteurized Toned Fresh Milk',
        category: 'Dairy & Milk',
        priceCents: 4200,
        currency: 'INR',
        inStock: true,
        unit: '1 L',
      },
      {
        id: 'swiggy_im_britannia_brown_bread',
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        name: 'Britannia 100% Whole Wheat Brown Bread',
        category: 'Bakery & Bread',
        priceCents: 5000,
        currency: 'INR',
        inStock: true,
        unit: '400 g',
      },
      {
        id: 'swiggy_im_amul_butter_100g',
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        name: 'Amul Salted Butter Block',
        category: 'Dairy & Butter',
        priceCents: 5800,
        currency: 'INR',
        inStock: true,
        unit: '100 g',
      },
      {
        id: 'swiggy_im_suguna_eggs_6',
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        name: 'Suguna Farm Fresh White Eggs',
        category: 'Dairy & Eggs',
        priceCents: 5200,
        currency: 'INR',
        inStock: true,
        unit: '6 pcs',
      },
    ];
    return {
      items: items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (q.includes('milk') && i.name.includes('Milk')) ||
          (q.includes('bread') && i.name.includes('Bread')) ||
          (q.includes('butter') && i.name.includes('Butter')) ||
          (q.includes('egg') && i.name.includes('Egg'))
      ),
    };
  });

  transport.registerToolHandler('swiggy_im_get_item_details', async (args) => {
    return {
      item: {
        id: 'swiggy_im_nandini_milk_1l',
        platform: 'swiggy_instamart',
        merchantName: 'Swiggy Instamart',
        name: 'Nandini Pasteurized Toned Fresh Milk',
        brand: 'Nandini (KMF)',
        priceCents: 4200,
        currency: 'INR',
        shelfLifeDays: 2,
        packSize: '1000 ml pouch',
        countryOfOrigin: 'India',
        fssaiLicense: '10012043000058',
        nutritionalInfo: { Protein: '3.1 g' },
        inStock: true,
      },
    };
  });

  transport.registerToolHandler('swiggy_im_delivery_estimate', async () => {
    return {
      serviceable: true,
      platform: 'swiggy_instamart',
      pincode: '560103',
      etaMinutes: 14,
      deliveryFeeCents: 2500,
      freeDeliveryThresholdCents: 19900,
      surgeFeeCents: 0,
      darkStoreName: 'Swiggy Instamart Pod - Bellandur',
      rainSurgeActive: false,
    } as DeliveryEstimateResult;
  });

  transport.registerToolHandler('swiggy_im_create_cart', async (args: any) => {
    const items = args.items || [];
    let subtotalCents = 0;
    const basketItems = items.map((it: any) => {
      const price = it.itemId.includes('butter')
        ? 5800
        : it.itemId.includes('bread')
        ? 5000
        : it.itemId.includes('egg')
        ? 5200
        : 4200;
      subtotalCents += price * it.quantity;
      return {
        itemId: it.itemId,
        name: it.itemId,
        quantity: it.quantity,
        unitPriceCents: price,
      };
    });
    const deliveryFeeCents = subtotalCents >= 19900 ? 0 : 2500;
    const taxCents = Math.round(subtotalCents * 0.05);
    return {
      platform: 'swiggy_instamart',
      merchantName: 'Swiggy Instamart',
      items: basketItems,
      subtotalCents,
      deliveryFeeCents,
      taxCents,
      totalAmountCents: subtotalCents + deliveryFeeCents + taxCents,
      currency: 'INR',
      etaMinutes: 14,
      deliveryAddress: args.location,
      isAvailable: true,
      cartId: 'cart_test_swiggy_01',
    };
  });

  transport.registerToolHandler('swiggy_im_checkout', async (args: any) => {
    return {
      success: true,
      platform: 'swiggy_instamart',
      orderId: 'swiggy_ord_123456',
      trackingUrl: 'https://www.swiggy.com/orders/swiggy_ord_123456',
      etaMinutes: 14,
      totalChargedCents: 15400,
      currency: 'INR',
      receiptSummary: {
        itemsCount: 2,
        platform: 'Swiggy Instamart',
        deliveryAddress: 'Bellandur, Bengaluru',
        deliveredAtEstimate: new Date().toISOString(),
      },
    };
  });

  transport.initialize();
  return transport;
}

export function createTestZeptoTransport(): MockMcpTransport {
  const transport = new MockMcpTransport();

  transport.registerToolHandler('zepto_search_products', async (args) => {
    const q = String(args.query || '').toLowerCase();
    const items: QuickCommerceItem[] = [
      {
        id: 'zepto_nandini_toned_milk_1l',
        platform: 'zepto',
        merchantName: 'Zepto',
        name: 'Nandini Toned Fresh Cow Milk',
        priceCents: 4200,
        currency: 'INR',
        inStock: true,
        unit: '1 L',
      },
      {
        id: 'zepto_health_factory_brown_bread',
        platform: 'zepto',
        merchantName: 'Zepto',
        name: 'The Health Factory Zero Maida Whole Wheat Bread',
        priceCents: 5200,
        currency: 'INR',
        inStock: true,
        unit: '350 g',
      },
      {
        id: 'zepto_eggoz_farm_eggs_6',
        platform: 'zepto',
        merchantName: 'Zepto',
        name: 'Eggoz Brown Farm Fresh Eggs',
        priceCents: 5400,
        currency: 'INR',
        inStock: true,
        unit: '6 pcs',
      },
      {
        id: 'zepto_amul_butter_100g',
        platform: 'zepto',
        merchantName: 'Zepto',
        name: 'Amul Pasteurised Butter',
        priceCents: 5700,
        currency: 'INR',
        inStock: true,
        unit: '100 g',
      },
    ];
    return {
      items: items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (q.includes('bread') && i.name.includes('Bread')) ||
          (q.includes('milk') && i.name.includes('Milk')) ||
          (q.includes('butter') && i.name.includes('Butter')) ||
          (q.includes('egg') && i.name.includes('Egg'))
      ),
    };
  });

  transport.registerToolHandler('zepto_inventory_check', async (args: any) => {
    const isUnknown = args.itemId === 'zepto_item_unknown';
    return {
      itemId: args.itemId,
      platform: 'zepto',
      inStock: !isUnknown,
      requestedQuantity: args.quantity || 1,
      availableQuantity: isUnknown ? 0 : 25,
      lowStockWarning: false,
    };
  });

  transport.registerToolHandler('zepto_delivery_estimate', async () => {
    return {
      serviceable: true,
      platform: 'zepto',
      pincode: '560103',
      etaMinutes: 10,
      deliveryFeeCents: 2000,
      freeDeliveryThresholdCents: 14900,
      surgeFeeCents: 0,
      darkStoreName: 'Zepto Dark Store #42',
      rainSurgeActive: false,
    } as DeliveryEstimateResult;
  });

  transport.registerToolHandler('zepto_create_cart', async (args: any) => {
    const items = args.items || [];
    let subtotalCents = 0;
    const basketItems = items.map((it: any) => {
      let price = 4200;
      if (it.itemId.includes('bread')) price = 5200;
      if (it.itemId.includes('eggs')) price = 5400;
      if (it.itemId.includes('butter')) price = 5700;
      subtotalCents += price * it.quantity;
      return {
        itemId: it.itemId,
        name: it.itemId,
        quantity: it.quantity,
        unitPriceCents: price,
      };
    });
    const deliveryFeeCents = subtotalCents >= 14900 ? 0 : 2000;
    const taxCents = Math.round(subtotalCents * 0.05);
    return {
      platform: 'zepto',
      merchantName: 'Zepto',
      items: basketItems,
      subtotalCents,
      deliveryFeeCents,
      taxCents,
      totalAmountCents: subtotalCents + deliveryFeeCents + taxCents,
      currency: 'INR',
      etaMinutes: 10,
      deliveryAddress: args.location,
      isAvailable: true,
      cartId: 'cart_test_zepto_01',
    };
  });

  transport.registerToolHandler('zepto_checkout', async () => {
    return {
      success: true,
      platform: 'zepto',
      orderId: 'zepto_ord_654321',
      trackingUrl: 'https://www.zeptonow.com/order/zepto_ord_654321',
      etaMinutes: 10,
      totalChargedCents: 14800,
      currency: 'INR',
      receiptSummary: {
        itemsCount: 2,
        platform: 'Zepto',
        deliveryAddress: 'Bellandur, Bengaluru',
        deliveredAtEstimate: new Date().toISOString(),
      },
    };
  });

  transport.initialize();
  return transport;
}
