# Implementation Plan: Prava AP2 Payment Layer Integration

## 1. Scope & Objective
The intent parser, Gemini orchestration, Neon DB setup, and Swiggy/Zepto MCP cart fetching are already implemented. 
**Objective:** Add ONLY the **Prava (AP2 Trust Layer)** payment integration to authorize the locked MCP cart via WebAuthn Passkeys, poll the minted single-use virtual card credentials, trigger the existing MCP checkout function, and close the Prava transaction loop via status reporting.

---

## 2. Dependencies & Environment Setup

### 2.1 Install Frontend SDK
Run the following in the project root:
```bash
npm install @prava-sdk/core
3. Files to Create / Modify
Plaintext
src/
├── lib/
│   └── prava/
│       ├── types.ts                  # [NEW] TypeScript interfaces for Prava Sessions, Tokens, & Status
│       └── client.ts                 # [NEW] Server-side Prava REST API wrapper (Session, Poll, Report)
├── app/
│   └── api/
│       └── prava/
│           ├── create-session/
│           │   └── route.ts          # [NEW] POST endpoint: initializes Prava session for the locked cart
│           └── execute-order/
│               └── route.ts          # [NEW] POST endpoint: polls token, calls existing MCP order fn, reports status
└── components/
    └── PravaCheckoutCard.tsx         # [NEW] Client widget mounting @prava-sdk/core inside the chat UI
(Modify existing Chat UI component only to render <PravaCheckoutCard /> when the best product/cart is returned).

4. Step-by-Step Implementation Specs
Step 1: Create Prava Type Definitions (src/lib/prava/types.ts)
Define strict interfaces for the Prava v1 Sandbox API and the payload passed from the existing MCP cart logic:

TypeScript
export interface PravaOrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface LockedCartPayload {
  orderId?: string;
  userId: string;
  userEmail: string;
  merchantName: 'Swiggy' | 'Zepto';
  totalAmount: number; // Final payable cart total from MCP
  mcpCartId: string;
  addressId?: string;
  items: PravaOrderItem[];
}

export interface PravaCreateSessionResponse {
  session_id: string;
  session_token: string;
  iframe_url: string;
  order_id: string;
  expires_at: string;
}

export interface PravaMintedCredentials {
  cardId: string;
  txnRefId: string;
  token: string;       // 16-digit one-time virtual PAN
  dynamicCvv: string;
  expiry: string;
}
Step 2: Implement Server-Side Prava Client (src/lib/prava/client.ts)
Build a dedicated server utility to handle the 3 core Prava v1 lifecycle endpoints:

createPravaSession(payload: LockedCartPayload)

Endpoint: POST ${process.env.PRAVA_API_URL}/v1/sessions

Headers: Authorization: Bearer ${process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY}, Content-Type: application/json

Body:

JSON
{
  "user_id": payload.userId,
  "user_email": payload.userEmail,
  "total_amount": String(payload.totalAmount),
  "currency": "USD",
  "integration_type": "embedding",
  "purchase_context": {
    "custom": [{
      "merchant_details": { "name": payload.merchantName },
      "product_details": payload.items
    }]
  }
}
Returns: { sessionId: data.session_id, sessionToken: data.session_token, iframeUrl: data.iframe_url }

pollPravaPaymentResult(sessionId: string, maxAttempts = 12, intervalMs = 1500): Promise<PravaMintedCredentials>

Endpoint: GET ${process.env.PRAVA_API_URL}/v1/sessions/${sessionId}/payment-result

Headers: Authorization: Bearer ${process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY}

Logic:

Loop up to maxAttempts.

If res.status === 'awaiting_result', extract const tx = res.transactions[0] and const item = tx.line_items[0]. Return { cardId: tx.card_id, txnRefId: item.txn_ref_id, token: item.token, dynamicCvv: item.dynamic_cvv, expiry: item.expiry }.

If res.status === 'failed' or 'expired', throw an immediate Error.

Otherwise wait intervalMs and retry.

reportPravaTransactionStatus(sessionId: string, txnRefId: string, status: 'APPROVED' | 'DECLINED')

Endpoint: POST ${process.env.PRAVA_API_URL}/v1/sessions/${sessionId}/report-status

Headers: Authorization: Bearer ${process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY}, Content-Type: application/json

Body: { "txn_ref_id": txnRefId, "txn_status": status }

(Note: Calling this endpoint is mandatory in Prava to transition the session from awaiting_result to completed).

Step 3: Create Session API Route (src/app/api/prava/create-session/route.ts)
Accept POST request with LockedCartPayload in the JSON body.

Call createPravaSession(body).

If the database has an orders/transactions table, optionally store sessionId against the active order record.

Return 200 OK with { sessionId, sessionToken, iframeUrl }.

Step 4: Create Order Execution & Status Reporting Route (src/app/api/prava/execute-order/route.ts)
Accept POST request with { sessionId: string, cartPayload: LockedCartPayload }.

Execution Flow:

Call const credentials = await pollPravaPaymentResult(sessionId).

Invoke the existing Swiggy or Zepto MCP order/checkout function already in the codebase, passing cartPayload and credentials.

Wrap the MCP checkout call in a try/catch:

If the MCP order succeeds, call await reportPravaTransactionStatus(sessionId, credentials.txnRefId, 'APPROVED').

If the MCP order fails/throws, call await reportPravaTransactionStatus(sessionId, credentials.txnRefId, 'DECLINED').

Return { success: true, txnRefId: credentials.txnRefId, pravaCardId: credentials.cardId, orderResult } to the frontend.

Step 5: Build the Prava Checkout Component (src/components/PravaCheckoutCard.tsx)
Create a client component ('use client') that embeds Prava's WebAuthn Passkey & PAN collection UI directly inside the chat message stream.

Props:

cartPayload: LockedCartPayload

onPaymentComplete: (result: any) => void

onPaymentError?: (error: string) => void

SDK Lifecycle:

Instantiate PravaSDK inside useEffect using process.env.NEXT_PUBLIC_PRAVA_CLIENT_KEY!, and clean up via .destroy() on unmount.

Render an "Authorize & Auto-Pay" button showing the merchant name (Swiggy / Zepto), item summary, and totalAmount.

Include a mount target <div id={prava-container-${cartPayload.mcpCartId}} />.

On button click:

POST /api/prava/create-session with cartPayload.

Call prava.collectPAN({ sessionToken, iframeUrl, container: '#prava-container-...', onSuccess, onError }).

Inside onSuccess: Immediately trigger POST /api/prava/execute-order with { sessionId, cartPayload }, then pass the result to onPaymentComplete.

Step 6: Wire <PravaCheckoutCard /> into the Existing Chat Interface
Locate the chat message renderer where the agent returns the winning Swiggy/Zepto product and cart details.

Render <PravaCheckoutCard cartPayload={...} onPaymentComplete={...} /> below the product card.

When onPaymentComplete fires, append a system/assistant confirmation message to the chat state displaying the txnRefId and order confirmation status.

5. Sandbox Verification & Testing Checklist
Trigger a food/grocery query in the chat UI and let the agent return the best product from Swiggy/Zepto MCP.

Click Authorize & Auto-Pay on the rendered PravaCheckoutCard.

Verify POST /api/prava/create-session returns a 200 with sessionId, sessionToken, and iframeUrl.

Complete the Prava iframe flow:

Enter any test card on first run.

Enter Sandbox OTP: 456789.

Approve the browser WebAuthn / Passkey prompt (TouchID / Windows Hello).

Verify POST /api/prava/execute-order polls /payment-result, receives awaiting_result with the single-use token and dynamic_cvv, triggers the MCP order handler, and posts APPROVED to /report-status.


<ElicitationsGroup message="Once Antigravity scaffolds the Prava layer, we can refine:">
  <Elicitation label="Add webhook handling for async Prava session events" query="Show me how to add a Prava webhook route in Next.js to handle session.expired and payment.completed events asynchronously."/>
  <Elicitation label="Mock the MCP checkout response for safe sandbox testing" query="Write a safe dry-run wrapper around the Swiggy and Zepto MCP checkout call so testing Prava doesn't place live orders."/>
</ElicitationsGroup>