# Autonomous Commerce Agent (ACA) — Implementation Plan (Approved & Updated)

**Target Domain:** Indian Quick-Commerce (Swiggy & Zepto) in INR (`₹`) with Biometric Human-in-the-Loop Passkey Gating  
**Core Technologies:** `@agorio/sdk` + Next.js 14+ Fullstack + Neon PostgreSQL (`pgvector`) + Prava Payments AP2 + Swiggy & Zepto MCP Servers  
**References:** [ARCHITECTURE (1).md](file:///c:/MYPROJECTS/MiniProject/ARCHITECTURE%20%281%29.md) | [Workflow (1).md](file:///c:/MYPROJECTS/MiniProject/Workflow%20%281%29.md) | [IMPLEMENTATION_PLAN.md](file:///c:/MYPROJECTS/MiniProject/IMPLEMENTATION_PLAN.md)

---

## 1. Approved Technical Decisions & Architecture Adjustments

Following user specifications, the following design decisions are locked:

1. **Modular MCP Transport (Remote HTTP/SSE Primary):**
   - Connect to official Swiggy Builders Club MCP (`mcp.swiggy.com/im`, `mcp.swiggy.com/food`) and Zepto MCP via streamable HTTP/SSE.
   - Decouple the transport layer using a modular client factory (`McpTransportAdapter`), allowing zero-code-change switching between Remote SSE/HTTP and local `stdio` child process execution.
   - Implement realistic mock fixtures for offline development and CI environments.

2. **Delivery Location & Geofencing Context:**
   - Store default delivery address, pincode, and optional GPS coordinates in the `users` table:
     - `default_address text`
     - `default_pincode varchar(10)`
     - `default_latitude double precision`
     - `default_longitude double precision`
   - Store effective delivery location in `agent_sessions` (`delivery_location jsonb`).
   - The agent explicitly verifies or confirms delivery location with the user before finalizing the cart or requesting passkey authorization.

3. **Prava Live Sandbox & Mocked Clerk Auth:**
   - Integrate Prava Payments using the live API key via environment variable `PRAVA_API_KEY` and target Prava's documented sandbox endpoint (`https://api.sandbox.prava.space`).
   - Keep Clerk mocked behind a unified `AuthProvider` interface. When `CLERK_SECRET_KEY` is absent, the system authenticates as a deterministic local mock user (`mock-user-01`, default address in Bengaluru/Mumbai) with full RLS support, enabling seamless local execution.
   - Zero secrets committed to Git; all keys read strictly from `.env.local`.

4. **Strict Financial Guardrails Before Purchase:**
   - **Spending Limit Gate:** Enforced via `@agorio/plugin-spending-controls` against `user.daily_spend_limit_cents` minus rolling 24-hour completed transaction volume.
   - **Order Validation Gate:** Validates dark-store stock availability, surge fees, and total checkout amount against user-specified budget before proposing.
   - **Payment Authorization Gate:** Passkey (FIDO WebAuthn) challenge via Prava generates an AP2 `SignedMandate` with single-use `prava_token_ref`.
   - **Double-Spend Invariance:** Enforced via database engine constraint `UNIQUE (mandate_id)` in the `transactions` table.

---

## 2. Updated Relational Data Model

~~~sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TYPE mandate_status AS ENUM ('pending', 'approved', 'expired', 'consumed', 'revoked');
CREATE TYPE transaction_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
CREATE TYPE session_status AS ENUM ('active', 'completed', 'abandoned');

-- 1. Users Table with Delivery Location and Daily Spend Caps
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  default_address text,
  default_pincode varchar(10),
  default_latitude double precision,
  default_longitude double precision,
  prava_account_id text UNIQUE,
  daily_spend_limit_cents integer NOT NULL DEFAULT 500000, -- Default ₹5,000.00
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Agent Sessions with Active Delivery Location Context
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status session_status NOT NULL DEFAULT 'active',
  delivery_location jsonb NOT NULL DEFAULT '{}'::jsonb, -- Active address & pincode
  session_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_agent_sessions_user_started ON agent_sessions (user_id, started_at DESC);

-- 3. Intents Table
CREATE TABLE intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  raw_message text NOT NULL,
  structured_goal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Candidate Options (Ranked Quick-Commerce Proposals)
CREATE TABLE candidate_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  merchant_id text NOT NULL,        -- 'swiggy_instamart', 'swiggy_food', 'zepto'
  merchant_name text NOT NULL,
  item_name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency text NOT NULL DEFAULT 'INR',
  delivery_fee_cents integer NOT NULL DEFAULT 0,
  eta_minutes integer,
  product_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  rank integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_candidate_options_session ON candidate_options (session_id, rank);

-- 5. Mandates Table (AP2 Lifecycle)
CREATE TABLE mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  mandate_id text NOT NULL UNIQUE,  -- AP2 mandateId / Prava mandate ID
  merchant_id text NOT NULL,        -- 'swiggy' or 'zepto'
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'INR',
  status mandate_status NOT NULL DEFAULT 'pending',
  raw_mandate jsonb NOT NULL,       -- Full AP2 CartMandate structure
  signed_mandate jsonb,             -- Full AP2 SignedMandate with WebAuthn signature
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mandates_user_status ON mandates (user_id, status, expires_at);

-- 6. Transactions Table (Double-Spend Proof)
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  mandate_id uuid NOT NULL UNIQUE REFERENCES mandates(id), -- Enforces Single-Use
  prava_token_ref text NOT NULL,
  merchant_id text NOT NULL,
  merchant_order_id text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'INR',
  status transaction_status NOT NULL DEFAULT 'pending',
  receipt_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_user_created ON transactions (user_id, created_at DESC);

-- 7. Audit Log Table
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES agent_sessions(id),
  user_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  agent_step text,
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_session ON audit_log (session_id, created_at);

-- 8. Product Embeddings (Semantic Search Fallback)
CREATE TABLE product_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id text NOT NULL,
  item_id text NOT NULL,
  item_name text NOT NULL,
  category text,
  price_cents integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768) NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, item_id)
);
CREATE INDEX idx_product_embeddings_vector ON product_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
~~~

---

## 3. Modular Quick-Commerce MCP Architecture

```mermaid
flowchart LR
    subgraph AgentLayer["ShoppingAgent (@agorio/sdk)"]
        A[ShoppingAgent]
        SC[@agorio/plugin-spending-controls]
        AW[@agorio/plugin-approval-workflow]
    end

    subgraph MCPManager["MCP Manager & Transport Layer"]
        Mgr[McpToolRegistry]
        Adapter[Modular Transport Adapter<br/>Remote HTTP/SSE | Stdio | Mock]
    end

    subgraph QuickCommerceBackends["Live MCP Endpoints"]
        Swiggy["Swiggy MCP<br/>(mcp.swiggy.com/im & /food)"]
        Zepto["Zepto MCP<br/>(Quick Commerce Catalog)"]
        MockFixtures["Deterministic Mock Fixtures<br/>(Offline / CI)"]
    end

    A --> SC
    A --> AW
    A --> Mgr
    Mgr --> Adapter
    Adapter -->|HTTP/SSE| Swiggy
    Adapter -->|HTTP/SSE| Zepto
    Adapter -.->|Fallback / Dev| MockFixtures
```

---

## 4. Implementation Phasing

### Phase 1: Project Setup & Monorepo Foundation
- Initialize TypeScript workspace (`package.json`, `tsconfig.json`).
- Install `@agorio/sdk`, `@agorio/plugin-spending-controls`, `@agorio/plugin-approval-workflow`, `@agorio/plugin-audit-trail`, `@modelcontextprotocol/sdk`, `drizzle-orm`, `zod`, `vitest`.
- Establish `.env.local` template (strictly gitignored).

### Phase 2: Relational Persistence Layer (Drizzle ORM)
- Implement `lib/db/schema.ts` with all 8 tables, location fields, and double-spend unique constraint.
- Implement rolling 24-hour spend calculation helper.
- Setup Mock Auth helper with automatic mock user provisioning when Clerk is not configured.

### Phase 3: Modular Swiggy & Zepto MCP Clients
- Implement `lib/mcp/transport.ts` supporting Remote HTTP/SSE and fallback mock handlers.
- Implement `lib/mcp/swiggy-mcp.ts` with tools: search, item details, cart management, delivery estimate.
- Implement `lib/mcp/zepto-mcp.ts` with tools: product search, dark store inventory check, cart assembly, checkout session.
- Implement `lib/mcp/mcp-manager.ts` exposing aggregated tools to `ShoppingAgent`.

### Phase 4: Prava Payments & AP2 Passkey Bridge
- Implement `lib/prava/client.ts` targeting Prava's documented sandbox (`https://api.sandbox.prava.space`).
- Implement AP2 mandate creation (`createIntentMandate`, `attachCart`) with 10-minute expiry.
- Implement signature verification and single-use `prava_token_ref` extraction.

### Phase 5: Agent Core & Governance Integration
- Instantiate `ShoppingAgent` with spending controls and approval workflow.
- Implement delivery location confirmation in conversation flow before checkout.
- Enforce order validation (budget cap, stock, delivery time) prior to mandate generation.
- Execute atomic checkout commit: `mandates.status = 'consumed'` + `transactions` insert.

### Phase 6: Automated Test Suite & Financial Verification
- Vitest suite testing:
  - Spending limit rejection when cart exceeds remaining daily allowance.
  - Double-spend rejection on `transactions.mandate_id`.
  - Delivery address confirmation flow.
  - Mock and live MCP tool execution.
