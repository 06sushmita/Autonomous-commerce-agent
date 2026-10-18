# Autonomous Commerce Agent — Development & Operational Workflow

This document outlines the step-by-step engineering workflow for building, testing, deploying, and operating the **Autonomous Commerce Agent (ACA)** on top of **`@agorio/sdk`**.

---

## 1. Executive Summary & Engineering Principles

The Autonomous Commerce Agent is an AI shopping system that allows users to express purchasing goals in natural language, searches merchants, presents verified options, and completes autonomous checkouts following a biometric human-in-the-loop passkey approval (Touch ID / Face ID) via **Prava** and **AP2 (Agent Payments Protocol)**.

Because this repository already contains the complete `@agorio/sdk` (with `ShoppingAgent`, protocol clients, merchant adapters, and governance plugins), our workflow focuses on building the **Application & Integration Layer** directly on top of `@agorio/sdk` without rewriting core commerce protocols.

### Core Engineering Principles

1. **Financial Correctness Over Speed:** Commerce operations handle real financial commitments. Mandate consumption and transaction persistence must always execute within a single atomic database transaction. Double-spending must be blocked at the database engine level (`UNIQUE` constraints).
2. **Zero Card Liability:** Raw credit card PANs, CVVs, or bank credentials must never touch the agent, application server, or application logs. Only opaque token references (`prava_token_ref`) are stored.
3. **Biometric Gate Invariance:** The agent has zero authorization to initiate or finalize payment without explicit user confirmation and a verified biometric passkey signature.
4. **Deterministic Decision Boundary:** Generative LLMs handle natural language parsing and conversational synthesis. Candidate filtering (budget constraints, stock validation) and mathematical ranking are executed deterministically in TypeScript to prevent hallucinations and conserve LLM API quotas.
5. **Unified TypeScript Toolchain:** Both the application layer and `@agorio/sdk` run in TypeScript on Node.js/Next.js. No polyglot runtime (Python/Node) overhead or inter-process RPC boundaries.

---

## 2. Architecture & Monorepo Layout

The application integrates with `@agorio/sdk` as an in-process library:

```text
agorio/
├── src/                          # @agorio/sdk Core (Implemented)
│   ├── agent/                    # ShoppingAgent, AgentChain, SubAgent
│   ├── client/                   # UcpClient, AcpClient, McpClient, Ap2Client
│   ├── adapters/                 # Shopify, WooCommerce, BigCommerce
│   ├── llm/                      # GeminiAdapter, ClaudeAdapter, OpenAIAdapter
│   └── mock/                     # MockMerchant for local testing & CI
├── plugins/                      # @agorio plugins (Implemented)
│   ├── spending-controls/        # Daily/per-transaction budget caps
│   ├── approval-workflow/        # Human-in-the-loop approval triggers
│   ├── audit-trail/              # Structured action logging
│   └── agent-identity/           # Cryptographic agent attestation
├── apps/
│   └── web/                      # Next.js 14+ Full-Stack Application (Planned)
│       ├── app/
│       │   ├── (auth)/           # Clerk sign-in / sign-up routes
│       │   ├── (dashboard)/      # Chat, Wallet, Order History, Audit UI
│       │   └── api/              # REST & SSE API Route Handlers
│       │       ├── sessions/     # Session creation & message streaming
│       │       ├── mandates/     # Mandate creation & authorization
│       │       ├── me/           # Profile & wallet spend settings
│       │       └── healthz/      # Health check endpoints
│       ├── components/           # UI Components (ChatBox, ProposalCard, PasskeyModal)
│       ├── lib/
│       │   ├── agent/            # agorio ShoppingAgent runner & wrapper
│       │   ├── db/               # Drizzle ORM schema, migrations, Neon client
│       │   ├── prava/            # Prava passkey & WebAuthn bridge
│       │   └── catalog/          # pgvector embedding helper
│       └── drizzle/              # SQL migration files
├── tests/                        # Vitest test suite
├── ARCHITECTURE.md               # Canonical system architecture
└── Workflow.md                   # This development workflow
```

---

## 3. Environment & Toolchain Setup (Phase 0)

### 3.1 Prerequisites
- **Node.js:** v20.10.0+ (LTS)
- **Package Manager:** npm or pnpm
- **Accounts & Keys:**
  - **Neon PostgreSQL:** Serverless database instance (with `vector` and `uuid-ossp` extensions enabled).
  - **Clerk Auth:** Free development instance for user identity and JWKS verification.
  - **Google Gemini API:** Free-tier API key for `GeminiAdapter` and text embeddings.
  - **Prava Developer Sandbox:** API keys and WebAuthn app credentials for biometric passkey testing.

### 3.2 Environment Variables Configuration

Create `.env.local` in the project root:

```bash
# ─── Database (Neon PostgreSQL) ───
DATABASE_URL="postgresql://user:password@ep-sample-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"

# ─── Authentication (Clerk) ───
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"

# ─── LLM Provider (Google Gemini) ───
GEMINI_API_KEY="AIzaSy..."

# ─── Prava Payments & Trust ───
PRAVA_API_KEY="prv_test_..."
PRAVA_API_URL="https://api.sandbox.prava.space"
NEXT_PUBLIC_PRAVA_CLIENT_KEY="prv_pub_..."

# ─── Application Settings ───
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NODE_ENV="development"
```

---

## 4. Phase-by-Phase Development Workflow

---

### Phase 1: Database Schema & Relational Foundation

#### Objective
Establish the relational tables, constraints, indexes, and Row-Level Security (RLS) policies in Neon PostgreSQL using Drizzle ORM.

#### Tasks
1. **Initialize Drizzle ORM:**
   - Define TypeScript schema in `apps/web/lib/db/schema.ts` matching [ARCHITECTURE.md §7](file:///c:/Users/Shubham/agorio/ARCHITECTURE.md#L174-L288):
     - `users`, `agent_sessions`, `intents`, `candidate_options`, `mandates`, `transactions`, `audit_log`, `product_embeddings`.
2. **Enforce Database Constraints:**
   - Unique constraint on `transactions.mandate_id` (guarantees a mandate can only be consumed once).
   - Check constraints: `amount_cents > 0`, `price_cents >= 0`.
   - Setup IVFFlat or HNSW cosine vector index on `product_embeddings.embedding`.
3. **Configure Migrations:**
   - Run `npx drizzle-kit generate` to produce SQL migrations.
   - Run `npx drizzle-kit migrate` to apply migrations to Neon.
4. **Row-Level Security (RLS):**
   - Apply SQL policies ensuring tenant data isolation based on `app.current_user_id`.

#### Verification & Acceptance
- `npx drizzle-kit migrate` executes cleanly against a fresh Neon branch.
- Attempting to insert two transactions referencing the same `mandate_id` fails with a SQL unique violation error.

---

### Phase 2: User Identity & Wallet Controls (Clerk Auth)

#### Objective
Enable passwordless sign-in and automated user profile provisioning, establishing spend limit controls before agent sessions start.

#### Tasks
1. **Clerk Integration:**
   - Wrap Next.js App Router in `<ClerkProvider>`.
   - Configure Next.js middleware (`middleware.ts`) to protect `/api/*` and dashboard routes.
2. **User Sync & Upsert:**
   - Implement `getOrCreateUser(clerkUserId)` helper.
   - On the first authenticated request, create the user row with default `daily_spend_limit_cents` (₹5,000.00 / $50.00).
3. **Wallet Spend Enforcement:**
   - Implement `/api/me/wallet` endpoint to allow users to update their daily budget cap.
   - Write SQL helper `calculateRolling24hSpend(userId)` to compute aggregate spend from `transactions` where `status = 'completed'` in the last 24 hours.

#### Verification & Acceptance
- Authenticated user can load `/api/me` and receive their user profile.
- Unauthenticated requests to `/api/sessions` immediately return `HTTP 401 Unauthorized`.

---

### Phase 3: Prava & AP2 Passkey Mandate Bridge

#### Objective
Wire `agorio`'s `Ap2Client` with Prava's WebAuthn biometric passkey challenge, ensuring payment tokens are cryptographically secured.

#### Tasks
1. **AP2 Client Initialization:**
   - Initialize `Ap2Client` from `@agorio/sdk` with merchant details and currency parameters.
2. **Mandate Lifecycle Handler:**
   - When a purchase candidate is approved, call `ap2Client.createIntentMandate()` and `ap2Client.attachCart()`.
   - Persist the pending mandate in the `mandates` table with `expires_at = now() + 10 minutes`.
3. **Frontend Biometric Challenge Modal:**
   - Build `PasskeyModal.tsx` in Next.js using Prava's client SDK.
   - Wire WebAuthn credentials ceremony (`navigator.credentials.get`).
4. **Signature Verification & Token Retrieval:**
   - Send biometric signature to `/api/mandates/{id}/authorize`.
   - Prava validates the signature and returns single-use token reference `prava_token_ref`.
   - Update mandate status to `approved`.

#### Verification & Acceptance
- Test biometric authorization ceremony in Prava sandbox.
- Verify `prava_token_ref` is received; verify zero raw card numbers or CVVs are logged.

---

### Phase 4: Agent Core Orchestration (`@agorio/sdk`)

#### Objective
Instantiate `ShoppingAgent` with user-specific context, wire discovery tools, and stream candidate proposals to the frontend via Server-Sent Events (SSE).

#### Tasks
1. **Agent Factory Implementation:**
   - Create `apps/web/lib/agent/runner.ts`:
     ```typescript
     import { ShoppingAgent, GeminiAdapter } from '@agorio/sdk';
     import { createSpendingControlsPlugin } from '@agorio/plugin-spending-controls';
     import { createApprovalWorkflowPlugin } from '@agorio/plugin-approval-workflow';
     import { createAuditTrailPlugin } from '@agorio/plugin-audit-trail';

     export function createAgentForSession(userId: string, remainingSpendCents: number) {
       return new ShoppingAgent({
         llm: new GeminiAdapter({ apiKey: process.env.GEMINI_API_KEY! }),
         plugins: [
           createSpendingControlsPlugin({ maxDailySpendCents: remainingSpendCents }),
           createApprovalWorkflowPlugin({ requireApprovalAbove: 0 }),
           createAuditTrailPlugin({
             onLog: (event) => saveAuditLogToDatabase(userId, event),
           }),
         ],
       });
     }
     ```
2. **Merchant Connectors Configuration:**
   - Attach Shopify, WooCommerce, or `MockMerchant` connectors to the agent.
3. **Real-time SSE Streaming (`/api/sessions/{id}/stream`):**
   - Stream agent thought tokens, tool calls, and structured `ProposalCard` JSON payloads to the client in real time.
4. **Proposal Card Component:**
   - Build `ProposalCard.tsx`: Displays merchant name, item image, price breakdown, agent rationale, and an "Approve & Buy" action button.

#### Verification & Acceptance
- Typing `"Find me headphones under ₹4,000"` returns a live proposal card within 4 seconds.
- Attempting to buy an item exceeding `remainingSpendCents` triggers `@agorio/plugin-spending-controls` rejection before proposing.

---

### Phase 5: Autonomous Checkout & Atomic Finalization

#### Objective
Connect user proposal confirmation to checkout execution, atomically committing mandate consumption and transaction records.

#### Tasks
1. **User Confirmation Gate:**
   - When the user clicks "Approve & Buy", send `POST /api/sessions/{id}/confirm`.
   - Trigger the Prava passkey modal (Phase 3).
2. **Autonomous Checkout Execution:**
   - Once the passkey is signed, pass the `SignedMandate` / `prava_token_ref` to `ShoppingAgent.completeCheckout()`.
   - The agent calls the merchant's checkout API (or mock merchant endpoint) and retrieves the merchant order ID.
3. **Atomic Database Transaction:**
   - Execute in Drizzle SQL transaction:
     ```typescript
     await db.transaction(async (tx) => {
       // 1. Mark mandate as consumed
       await tx.update(mandates)
         .set({ status: 'consumed', consumedAt: new Date() })
         .where(eq(mandates.id, mandateId));

       // 2. Insert transaction record
       await tx.insert(transactions).values({
         userId,
         sessionId,
         mandateId,
         pravaTokenRef,
         merchantId,
         merchantOrderId,
         amountCents,
         status: 'completed',
         receiptSummary,
       });
     });
     ```
4. **Receipt Generation:**
   - Stream confirmed `ReceiptCard` with order number, tracking link, and final summary back to the user chat interface.

#### Verification & Acceptance
- End-to-end flow completes: Chat request → Proposal card → Passkey touch → Checkout → Receipt card.
- Database confirms `mandates.status = 'consumed'` and `transactions.status = 'completed'`.

---

### Phase 6: Dashboards, History & Audit Viewer

#### Objective
Deliver user-facing interfaces for reviewing past orders, inspecting agent audit trails, and managing spending limits.

#### Tasks
1. **Order History Screen (`/history`):**
   - Query `transactions` table with cursor-based pagination.
   - Display merchant badges, receipt summaries, and timestamps.
2. **Audit Trail Explorer (`/sessions/[id]/audit`):**
   - Query `audit_log` table by `session_id`.
   - Render interactive timeline showing each agent decision, tool call, input, and output.
3. **Wallet Dashboard (`/wallet`):**
   - Display rolling 24-hour spend vs. daily spending cap with a visual progress bar.
   - Allow user to adjust daily budget threshold with immediate database update.

#### Verification & Acceptance
- User can view previous orders and drill into the granular audit trail of any past session.
- Users cannot view or query audit records or transactions belonging to other users.

---

## 5. Testing & Validation Strategy

The repository includes a comprehensive testing harness via **Vitest**.

### 5.1 Running Local Tests

```bash
# Run all unit and protocol tests
npm test

# Run tests in watch mode
npx vitest

# Run type checks
npm run typecheck
```

### 5.2 Deterministic Mock Merchant Testing

`@agorio/sdk` includes `MockMerchant`, which runs an in-memory HTTP server simulating UCP and ACP merchant endpoints:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShoppingAgent, GeminiAdapter, MockMerchant } from '@agorio/sdk';

describe('Autonomous Shopping Flow', () => {
  let merchant: MockMerchant;

  beforeEach(async () => {
    merchant = new MockMerchant({ port: 8089 });
    await merchant.start();
  });

  afterEach(async () => {
    await merchant.stop();
  });

  it('completes discovery, cart, and checkout deterministically', async () => {
    const agent = new ShoppingAgent({
      llm: new GeminiAdapter({ apiKey: process.env.GEMINI_API_KEY }),
    });

    const result = await agent.run(`Go to ${merchant.domain} and buy wireless headphones`);
    expect(result.checkout).toBeDefined();
    expect(result.checkout?.orderId).toContain('ord_');
  });
});
```

### 5.3 Safety & Double-Spend Tests

Specific test cases must verify financial safety boundaries:
1. **Double-Spend Rejection:** Consuming the same `mandate_id` twice must throw an immediate error.
2. **Expiration Enforcement:** Submitting a passkey signature after `expires_at` (10 minutes) must abort checkout.
3. **Spend Limit Cap:** Requesting an item priced higher than `daily_spend_limit_cents` must be rejected at the proposal phase.

---

## 6. Deployment & CI/CD Pipeline

### 6.1 GitHub Actions Workflow

On pull requests to `main`:
1. **Lint & Typecheck:** Run `npm run typecheck` and Biome/ESLint.
2. **Vitest Suite:** Run all unit and mock integration tests.
3. **Build Validation:** Run `npm run build` to ensure Next.js compiles without errors.

### 6.2 Production Deployment

- **Frontend & API:** Connect GitHub repository to **Vercel** (or Render / Fly.io for containerized Node.js).
- **Environment Secrets:** Inject `DATABASE_URL`, `CLERK_SECRET_KEY`, `GEMINI_API_KEY`, and `PRAVA_API_KEY` into Vercel Project Settings.
- **Database Migrations:** Run `drizzle-kit migrate` as part of the build step or via a GitHub Actions deployment hook.
- **Health Verification:** Validate `/api/healthz` and `/api/readyz` post-deployment.

---

## 7. Operations & Incident Response Playbook

| Scenario | Immediate Operational Action |
|---|---|
| **LLM Provider Outage** | Configure `ShoppingAgent` to switch to secondary adapter (e.g., Groq / Claude). Frontend displays polite retry prompt. |
| **Prava Gateway Latency** | Proposal generation remains unaffected; mandate issuance indicates gateway delay. Pre-create Prava sessions at turn start. |
| **Database Connection Spikes** | Enable connection pooling (`pgbouncer` / Neon pooled connection string `?sslmode=require`). |
| **Suspected Agent Hallucination** | Inspect `audit_log` table for the session ID to review the exact tool calls and inputs. Replay turn against `MockMerchant`. |
