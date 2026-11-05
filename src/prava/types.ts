/**
 * Prava AP2 Payment Layer Types
 * Defines interfaces for Prava v1 Sandbox API, session management,
 * tokenization, and transaction status reporting.
 */

export interface PravaOrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface LockedCartPayload {
  orderId?: string;
  userId: string;
  userEmail: string;
  merchantName: 'Swiggy' | 'Zepto' | 'Swiggy Instamart';
  totalAmount: number; // Final payable cart total from MCP (in INR or standard currency units)
  totalAmountCents?: number; // In paise (cents)
  currency?: string;
  mcpCartId: string;
  addressId?: string;
  deliveryAddress?: string;
  items: PravaOrderItem[];
}

export interface PravaCreateSessionResponse {
  session_id: string;
  session_token: string;
  iframe_url: string;
  order_id?: string;
  expires_at?: string;
}

export interface PravaMintedCredentials {
  cardId: string;
  txnRefId: string;
  token: string; // Single-use virtual PAN or scoped payment token
  dynamicCvv?: string;
  expiry?: string;
  status: string;
}

export interface PravaPaymentResultResponse {
  status: 'pending' | 'awaiting_result' | 'completed' | 'failed' | 'expired';
  transactions?: Array<{
    card_id: string;
    line_items?: Array<{
      txn_ref_id: string;
      token: string;
      dynamic_cvv?: string;
      expiry?: string;
    }>;
  }>;
  order_id?: string;
  error?: string;
}

export interface PravaReportStatusPayload {
  txn_ref_id: string;
  txn_status: 'APPROVED' | 'DECLINED';
}

