# Autonomous Commerce Agent (ACA) 🛒⚡

An autonomous, multi-merchant quick-commerce AI agent featuring **Model Context Protocol (MCP)** integrations for **Swiggy Instamart** and **Zepto**, cryptographic biometric passkey authorizations via **Prava AP2**, and an **Executive Blue** real-time comparison dashboard.

---

## 🌟 Key Features

### 1. 🤖 Multi-Merchant Quick-Commerce MCP
- **Swiggy Instamart Live MCP (`https://mcp.swiggy.com/im`):** Real-time product search (`search_products`), live cart assembly (`update_cart`, `get_cart`), itemized bill breakdown, and live dark store courier dispatch.
- **Zepto Live MCP (`https://mcp.zepto.co.in/mcp`):** Dynamic discovery of 23 tools over Streamable HTTP SSE, with real-time web catalog fallback.
- **Multi-Merchant Basket Comparator:** Parallel price, delivery ETA, surge pricing, and availability comparison across platforms.

### 2. ⭐ "The One Best Choice" Decision Spotlight
- Automatically analyzes delivery speed, item freshness, per-unit pricing, and delivery fees.
- Spotlights the optimal merchant and variant with high-resolution CDN images, verified in-stock badges, discount chips, and transparent decision rationale.
- Direct clickable deep links (`🔗 View Product on Swiggy Instamart ↗` / `🔗 View on Zepto ↗`).
- Interactive catalog allows one-click switching of product variants (e.g. 200g vs 500g vs 1kg).

### 3. 👤 User Identity & Delegated Agency
- User Login, Sign-Up, and instant Profile Switcher.
- The AI agent acts and orders strictly on behalf of the active authenticated user profile.
- Persistent delivery addresses, GPS coordinates, and pincodes for localized dark store routing.

### 4. 🛡️ Prava AP2 Biometric Passkeys & Financial Guardrails
- **Biometric Passkey Gating (FIDO2 / WebAuthn):** Cryptographic `CartMandate` challenge verification prior to funds release.
- **AP2 Trust Layer:** Single-use `prava_token_ref` prevents replay attacks and double-spending.
- **Daily Spend Limits:** Automatic budget enforcement with rolling 24-hour spend tracking against user caps.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    User["👤 User (Buyer)"] -->|Natural Language Prompt / UI| Server["🌐 Executive Blue Dashboard & API"]
    Server -->|Session & Auth| AuthMgr["🔐 User Identity / Delegation"]
    Server -->|Parallel Query| MCPMgr["⚡ MCP Manager"]
    MCPMgr -->|Streamable HTTP / SSE| Swiggy["🛍️ Swiggy Instamart MCP"]
    MCPMgr -->|Streamable HTTP / SSE| Zepto["⚡ Zepto MCP"]
    Swiggy -->|Live Catalog & Stock| Comparator["⚖️ Basket Comparator & Evaluator"]
    Zepto -->|Live Catalog & Stock| Comparator
    Comparator -->|"The One Best Choice"| UI["🖥️ Chat UI & Spotlight Card"]
    UI -->|Proceed to Checkout| Guardrails["🛡️ Spend Limit & Budget Guardrails"]
    Guardrails -->|Mandate Challenge| Prava["🔑 Prava AP2 Biometric Passkey"]
    Prava -->|Signed Mandate| Dispatch["📦 Dark Store Courier Dispatch"]
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ or 20+
- npm or pnpm

### 1. Clone the Repository
```bash
git clone https://github.com/06sushmita/Autonomous-commerce-agent.git
cd Autonomous-commerce-agent
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy the example environment configuration:
```bash
cp .env.example .env.local
```

Edit `.env.local` to configure your keys (or run with mock defaults):
```env
# Database (Neon PostgreSQL or SQLite fallback)
DATABASE_URL="postgresql://user:password@localhost:5432/commerce_db"

# Prava Payments & AP2 Trust Layer
PRAVA_API_KEY="sk_live_..."
PRAVA_SECRET_KEY="sk_live_..."
PRAVA_API_URL="https://sandbox.api.prava.space"

# Quick Commerce MCP Endpoints
SWIGGY_MCP_URL="https://mcp.swiggy.com/im"
SWIGGY_AUTH_TOKEN="Bearer ..."
ZEPTO_MCP_URL="https://mcp.zepto.co.in/mcp"
ZEPTO_AUTH_TOKEN="Bearer ..."
```

### 4. Start the Application
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser to experience the **Executive Blue** autonomous commerce dashboard.

### 5. Run the Test Suite
```bash
npm test
```
All 76 unit and integration tests across 5 test suites run seamlessly with full coverage.

---

## 🔒 Security & Privacy Notice
- **Zero Secrets in Repository:** Real API tokens, secret keys, and JWT credentials must **never** be committed. All local secrets remain strictly isolated in `.env.local` (enforced via `.gitignore`).
- **Cryptographic AP2 Mandates:** Transactions require explicit client-side passkey authorization signatures before any order execution occurs.

---

## 📄 License
This project is licensed under the MIT License.
