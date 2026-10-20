# Autonomous Commerce Agent --- Critical Fixes & Implementation Plan

**Repository:** `Shubham-Mahajani/Autonomous-commerce-agent`\
**Audience:** Codex working directly in this repository\
**Goal:** Fix the most serious security, payment-integrity,
data-integrity, and checkout-reliability problems without introducing
fake production behavior or silently changing product semantics.

------------------------------------------------------------------------

## Instructions for Antigravity

Act as a senior backend/security engineer. Inspect the repository before
editing, trace each affected call path, and implement the fixes in
small, verifiable stages.

### Non-negotiable rules

1.  **Do not fake security success.** A locally generated token,
    synthetic challenge, mocked signature, or shape-only validation must
    never authorize a real checkout.
2.  **Fail closed in production.** If authorization, identity, product
    availability, price, delivery fee, or a required limit check cannot
    be verified, stop checkout and return a safe error.
3.  **Do not trust client-supplied identity.** Resolve the user from a
    verified server-side session or token. A request parameter must not
    let a caller select another user's identity.
4.  **Use durable, concurrency-safe state for purchases and spend
    limits.** Process-local `Map`/`Set` instances are not sufficient for
    security-critical state.
5.  **Do not claim exactly-once external execution unless the merchant
    API guarantees it.** Use idempotency where supported, durable state
    transitions, and reconciliation for ambiguous outcomes.
6.  Preserve existing public API behavior where safe. If behavior must
    change for security, document the change and update tests and
    examples.
7.  Do not add real credentials, secrets, or production payment
    integrations that the repository does not already support. If a
    provider contract or key is missing, build a fail-closed adapter
    interface and document the required configuration.
8.  Do not mark a task complete just because TypeScript compiles. Add
    regression tests for each failure mode.
9.  Before implementation, inspect package scripts, current ORM/database
    setup, route handlers, test framework, environment configuration,
    and all callers of the affected functions. Adapt file names to the
    actual repository rather than creating a parallel architecture
    unnecessarily.
10. Do not delete useful functionality merely to make tests pass. Use
    explicit development/test adapters for mocks.

------------------------------------------------------------------------

## Executive summary --- priority order

  ----------------------------------------------------------------------------------------
  Priority          Area                         Risk                  Required outcome
  ----------------- ---------------------------- --------------------- -------------------
  P0                Payment/passkey              Fake or unverified    Real verification
                    authorization                authorization can be  only; production
                                                 treated as success    fails closed

  P0                Authentication and identity  Missing credentials   Verified identity
                                                 or caller-selected    comes from trusted
                                                 IDs may resolve to a  server context;
                                                 user                  ownership enforced

  P0                Checkout idempotency and     Concurrent requests,  Durable atomic
                    spending limits              restarts, or crashes  state and
                                                 can allow duplicate   reservations
                                                 purchases/overspend   

  P1                Product/price/availability   Missing upstream data Unknown data
                    data                         can be replaced by    remains unknown;
                                                 invented defaults and block unsafe
                                                 shown as real         checkout

  P1                Mandate lifecycle and        A crash or ambiguous  Explicit durable
                    checkout recovery            merchant response can state machine and
                                                 leave an order in an  reconciliation
                                                 unsafe state          

  P1                Configuration and            Mock mode or missing  Production startup
                    observability                provider              validation, safe
                                                 configuration may go  structured logs, no
                                                 unnoticed             secrets in logs

  P2                Test coverage and            Critical invariants   Unit, integration,
                    operational readiness        can regress           concurrency, and
                                                                       failure-injection
                                                                       tests
  ----------------------------------------------------------------------------------------

------------------------------------------------------------------------

# 1. P0 --- Remove fake payment authorization and fail closed

**Primary file to inspect:** `src/prava/client.ts`\
**Primary caller to inspect:** `src/agent/runner.ts`, especially
`authorizeAndExecuteCheckout()`\
**Related integration:** AP2 mandate construction/verification and
passkey/WebAuthn flow.

## Problem

The current Prava client appears to fall back to locally generated
challenge/token values when the remote authorization service fails or is
unavailable. A synthetic value such as `prv_tok_...` is not proof that a
user completed a valid passkey ceremony. A challenge with an RP ID such
as `localhost` is not a production WebAuthn challenge for the deployed
relying party.

The checkout path must not interpret an API error, timeout, malformed
response, or missing verification as successful authorization. A shape
check on a mandate or the mere presence of a `signature` field is not
cryptographic verification.

## Required changes

### 1.1 Separate provider integration from test mocks

-   Introduce or preserve a clear interface for Prava/passkey
    authorization, e.g. `PravaAuthorizationProvider`.
-   Have production code use a real provider implementation only.
-   Put fake challenges/tokens behind an explicit test-only mock
    implementation.
-   The mock must require an explicit test environment and must not be
    selected implicitly when production configuration is missing.
-   Never use `Math.random()`, timestamps, or predictable strings to
    create a value that looks like an authorization token.
-   Do not let a mock implementation return a production-shaped
    successful authorization in production.

### 1.2 Make failures fail closed

The production authorization method must return a typed failure or throw
a typed error for all of the following:

-   Provider API returns a non-success response.
-   Network timeout or connection error.
-   Provider response is malformed or missing required fields.
-   Challenge is expired, mismatched, or already consumed.
-   Signature or credential verification fails.
-   Required provider configuration is missing.
-   The authorization service is unavailable.

No catch block may convert these conditions into `{ success: true }`, a
locally generated token, or another success-shaped result.

### 1.3 Validate WebAuthn/passkey ceremonies correctly

Use a maintained, established WebAuthn implementation or the provider's
official verification API. Do not hand-roll cryptographic verification.

Verify, as applicable to the provider contract:

-   The challenge exactly matches the server-issued, single-use
    challenge.
-   The challenge is bound to the initiating user and the pending
    checkout/mandate.
-   The expected origin matches the configured production origin.
-   The RP ID matches the configured relying-party ID and deployment
    domain.
-   The credential belongs to the authenticated user.
-   The signature is cryptographically valid.
-   User presence and user verification satisfy the configured policy.
-   The challenge is unexpired and cannot be replayed.
-   The credential and challenge are associated with the expected
    ceremony type.

Do not assume the provider returns every field above. Read its official
contract and implement the exact checks it supports. If the provider
performs verification server-side, validate the provider's authenticated
response and documented status fields rather than duplicating
undocumented assumptions.

### 1.4 Bind user approval to the exact purchase

The approval must be bound to immutable purchase facts. At minimum,
validate the binding between the approved mandate and:

-   Authenticated user ID.
-   Merchant/provider ID.
-   Cart/order ID or stable cart fingerprint.
-   Item identifiers and quantities.
-   Total amount in integer minor currency units (e.g. paise), not
    floating-point rupees.
-   Currency.
-   Mandate ID and expiry.
-   Relevant payment method/authorization scope.

If any purchase-relevant field changes after approval, require fresh
authorization. Never reuse a token for a different cart, merchant,
amount, currency, or user.

### 1.5 Validate the mandate cryptographically and semantically

Inspect `buildAndVerifySignedMandate()` and related AP2 code. Replace
any shape-only "verification" with the actual supported
signature/issuer/key validation and schema validation. If signature
verification is implemented by a trusted upstream service, ensure that
the response is authenticated and its verified status is checked.

Validate expiry using server time. Reject missing, invalid, or expired
expiry fields. Avoid trusting client-provided timestamps or verification
flags.

### 1.6 Harden token handling

-   Keep authorization tokens server-side unless the documented protocol
    explicitly requires client exposure.
-   Never log raw tokens, passkey responses, signatures, or secrets.
-   Use a provider-returned token/authorization reference only after
    successful verification.
-   Store only the minimum necessary token reference, with encryption at
    rest if persistence is required.
-   Define token expiry and revocation/consumption behavior.
-   Do not invent a token if the provider does not issue one.

### 1.7 Configuration

Use explicit environment variables for provider endpoint, credentials,
allowed origin, and RP ID, following the provider's real contract. Add
startup validation that rejects missing or inconsistent production
settings. Do not assume `localhost` is valid outside local development.

Document how to run tests with the mock provider without making mock
mode available to production.

## Acceptance criteria

-   [ ] Provider timeout or HTTP 500 cannot authorize checkout.
-   [ ] Missing provider credentials make production startup fail or
    make the authorization service unavailable; no mock fallback occurs.
-   [ ] Invalid signature, wrong origin, wrong RP ID, wrong user, wrong
    challenge, expired challenge, and replayed challenge all fail.
-   [ ] Changing amount, currency, merchant, cart, quantity, or user
    after approval requires new authorization.
-   [ ] A successful checkout can only follow an explicit verified
    authorization result.
-   [ ] Test mocks are only selectable in an explicit test
    configuration.
-   [ ] No raw passkey or authorization secrets appear in logs.

------------------------------------------------------------------------

# 2. P0 --- Fix authentication and enforce server-side ownership(clerk for user signup and login)

**Primary file to inspect:** `src/auth/index.ts`\
**Related files:** route handlers, session initialization,
cart/mandate/checkout handlers, and all callers of
`getAuthenticatedUser()`.

## Problem

The current auth implementation appears to include hardcoded mock users
and a default password such as `password123`.
`loginUser(emailOrPhone, password?)` appears to accept a missing
password because the mismatch check only runs when a password is
supplied. `getAuthenticatedUser(userIdOrKey?)` appears to accept a
caller-provided identifier and may fall back to an active user when the
identifier is unknown.

These patterns are unsafe if reachable in production or if request
handlers use caller-controlled identifiers. Whether this is remotely
exploitable depends on route exposure and the surrounding trust
boundary; nevertheless, the identity model should be corrected before
real purchases are enabled.

## Required changes

### 2.1 Establish one trusted identity source

-   Determine how authentication reaches each route/tool/MCP operation.
-   Resolve the authenticated user from a verified server-side session,
    validated bearer token, or trusted authentication middleware.
-   Do not accept `userId`, `userIdOrKey`, email, phone, or an "active
    user" value as proof of identity.
-   If a route accepts a user ID to select a resource, compare it with
    the authenticated principal and perform authorization checks.
-   Remove fallback behavior that silently maps an unknown identity to
    an active/default user.
-   If no authenticated principal exists, return an unauthenticated
    error.

### 2.2 Remove insecure mock credentials from production

-   Remove hardcoded users/passwords from production execution paths.
-   Remove default passwords from registration.
-   If password auth is intentionally supported, require a password and
    hash it with a modern password-hashing algorithm/library
    (e.g. Argon2id or a maintained bcrypt implementation).
-   Never store plaintext passwords.
-   Use generic login errors to avoid account enumeration.
-   Add rate limiting and appropriate lockout/backoff controls to login
    and credential-verification endpoints.
-   If a hosted identity provider is already configured, integrate with
    it rather than inventing a second authentication system.

### 2.3 Make mock auth explicit and isolated

-   Keep demo users only in fixtures or an explicit development/test
    adapter.
-   Refuse mock-auth mode when `NODE_ENV=production` or the app's
    equivalent production flag is active.
-   Add a startup assertion/test proving production cannot boot with
    mock authentication enabled.
-   Do not infer development mode solely from missing environment
    variables.

### 2.4 Add authorization checks at every resource boundary

For every operation involving a user-owned object, verify ownership
server-side:

-   Cart read/update.
-   Cart-to-order conversion.
-   Mandate creation, reading, approval, and consumption.
-   Passkey challenge creation and verification.
-   Checkout execution and checkout status.
-   Spend profile and spending-limit changes.
-   Order history and transaction details.
-   Any MCP tool that reads or mutates a user's shopping/payment state.

Use the authenticated user ID from trusted middleware, not a user ID
embedded in tool arguments unless it is checked against that principal.

### 2.5 Use typed authentication/authorization errors

-   Missing/invalid session: `401 Unauthorized`.
-   Authenticated user without permission to access a resource:
    `403 Forbidden` or a consistent `404` policy to avoid leaking
    resource existence.
-   Invalid input: `400`/`422`, consistent with existing API
    conventions.
-   Do not silently switch identities or return another user's data.

### 2.6 Audit all identity fallback call sites

Search for `getAuthenticatedUser`, `initializeSession`, `userIdOrKey`,
`activeUser`, hardcoded passwords, and any `userId` accepted from
request payloads. Fix callers as well as the helper. A secure helper is
not enough if a route bypasses it.

## Acceptance criteria

-   [ ] Login fails when password/credential is missing.
-   [ ] No default production password or hardcoded production user
    exists.
-   [ ] Unknown user/session identifiers do not resolve to
    another/default user.
-   [ ] A user cannot read or mutate another user's cart, mandate,
    order, spend profile, or passkey challenge by changing an ID in the
    request.
-   [ ] MCP/tool calls enforce the same identity and ownership rules as
    HTTP routes.
-   [ ] Mock authentication is unavailable in production.
-   [ ] Tests cover unauthenticated, wrong-user, expired-session, and
    cross-user access attempts.

------------------------------------------------------------------------

# 3. P0 --- Make checkout idempotent and spending limits atomic/durable

**Primary files to inspect:** `src/agent/runner.ts`,
`src/db/spend-tracker.ts`, `src/db/schema.ts`\
**Related files:** DB client/migrations, merchant checkout adapter,
transaction/order records, and retry logic.

## Problem

The checkout path appears to use process-local `Set`/`Map` collections
for consumed mandates and transaction tracking. These are lost on
restart and are not shared across multiple server instances. If a
mandate is marked consumed only after a remote checkout call returns,
concurrent requests can both pass the initial check and submit the same
purchase. A crash after the merchant accepts an order but before the
local write can also make a retry submit a duplicate.

Likewise, spend-limit validation based on an in-memory/mock transaction
list is not safe for enforcing real money limits. Two concurrent
requests can both observe the same remaining budget and both proceed.

## Required changes

### 3.1 Persist purchase and mandate state

Use the repository's existing durable database/ORM if present. Add
migrations/schema changes as needed. Do not create an unrelated second
database if the current DB is suitable.

Persist at least:

-   Stable order/checkout ID.
-   User ID.
-   Merchant/provider ID.
-   Mandate ID.
-   Cart fingerprint or immutable order snapshot.
-   Currency and total in integer minor units.
-   Idempotency key.
-   Checkout state.
-   Provider/merchant order reference when available.
-   Spend reservation amount and reservation state.
-   Created/updated timestamps.
-   Failure/uncertainty metadata that does not include secrets.

Use database constraints for invariants, including a unique constraint
on the mandate's one-time consumption or an equivalent unique operation
key. Use foreign keys where appropriate.

### 3.2 Introduce an explicit checkout state machine

Define and document legal states. A suggested baseline:

`PENDING_AUTHORIZATION -> AUTHORIZED -> RESERVED -> SUBMITTING -> SUCCEEDED`

Failure/recovery states may include:

`REJECTED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `OUTCOME_UNKNOWN`,
`CANCELLED`, `RECONCILIATION_REQUIRED`.

Adapt the names to the existing model, but ensure the transitions are
explicit and enforced. Illegal transitions must fail. Do not reset a
consumed mandate to a reusable state merely because a request timed out.

### 3.3 Claim the mandate atomically before external side effects

-   Within a database transaction, validate ownership, expiry, current
    state, amount/currency/cart binding, and the mandate's one-time-use
    condition.
-   Atomically transition the mandate/checkout to a claimed or
    submitting state.
-   Enforce the one-time-use rule with a database unique constraint or
    conditional update, not only a preceding read.
-   If the claim fails because another request won the race, do not call
    the merchant.
-   Keep the DB transaction short; do not hold a database transaction
    open across a slow external network call unless the current
    architecture has a well-justified mechanism for doing so.

### 3.4 Add stable idempotency

-   Require or generate a stable idempotency key for a logical checkout
    operation.
-   Repeated requests with the same key and same payload must return the
    existing operation/status rather than create a new purchase.
-   Reuse of the same key with a different user, mandate, cart,
    merchant, or amount must be rejected.
-   Send the same idempotency key to the merchant/provider if that API
    documents support for it.
-   If the merchant does not support idempotency, do not pretend local
    idempotency guarantees exactly-once external execution. Use durable
    state plus status lookup/reconciliation and prevent blind retries
    when outcome is unknown.

### 3.5 Reserve spending budget atomically

Replace mock/in-memory spend calculations in the production path with a
durable mechanism.

-   Represent amounts as integer minor units and validate currency
    consistently.
-   Define the rolling window and timezone/time semantics explicitly.
-   Include completed purchases and active reservations in the
    applicable limit.
-   In one atomic DB transaction, calculate/lock or conditionally
    reserve available budget and create the reservation.
-   Ensure two concurrent checkouts cannot reserve more than the user's
    limit.
-   Release reservations on definitive failure/cancellation.
-   Convert a reservation to actual spend on confirmed success.
-   Do not release a reservation merely because a network request timed
    out; the merchant outcome may be unknown.
-   Reconcile or manually resolve uncertain orders safely.
-   Ensure changes to user limits themselves are authenticated,
    authorized, validated, and audited.

The exact SQL strategy depends on the current database. Use row locking,
serializable transactions, atomic conditional updates, or another proven
database-specific approach. Explain the chosen approach in code
comments/tests.

### 3.6 Make retries and crash recovery safe

Handle these cases deliberately:

1.  Process crashes before merchant request.
2.  Process crashes after sending request but before receiving response.
3.  Merchant accepts order but process crashes before recording success.
4.  Merchant returns a definitive failure.
5.  Merchant times out and the outcome cannot be determined.
6.  The client retries while the original operation is still running.
7.  Two application instances process the same mandate simultaneously.

For uncertain outcomes, mark the operation `OUTCOME_UNKNOWN` or
equivalent, query the merchant using a stable reference/idempotency key
if supported, and reconcile before attempting a new purchase. Do not
blindly resubmit.

### 3.7 Remove production reliance on process-local collections

The in-memory `consumedMandates` and `transactionLedger` may remain as
test fixtures or caches only if the database is the source of truth. A
cache must never authorize a checkout or override durable state.

## Acceptance criteria

-   [ ] Concurrent requests using the same mandate result in at most one
    merchant submission.
-   [ ] Two simultaneous purchases cannot exceed the configured spending
    limit.
-   [ ] Restarting the server does not reset consumed mandates, spend,
    idempotency records, or checkout state.
-   [ ] Two app instances observe the same mandate and budget state.
-   [ ] A retry with the same idempotency key returns the existing
    operation.
-   [ ] Same idempotency key with different payload is rejected.
-   [ ] A timeout does not automatically release spend reservation or
    cause blind resubmission.
-   [ ] Definitive failure releases reservations correctly; success
    finalizes spend exactly once in the local ledger.
-   [ ] Tests include concurrency and injected crashes/failures, not
    only sequential happy paths.

------------------------------------------------------------------------

# 4. P1 --- Stop fabricating product, price, stock, and delivery data

**Primary file to inspect:** `src/mcp/swiggy-mcp.ts`\
**Related files:** product normalization, cart builder, order summary,
price calculation, and checkout validation.

## Problem

The current integration appears to substitute plausible defaults when
live provider fields are missing---for example a fallback product price,
assuming an item is in stock, a default quantity, a default ETA, or a
delivery estimate inferred from a PIN code. Such values may be useful as
demo placeholders, but they must not be represented as verified live
data or used to authorize real purchases.

## Required changes

### 4.1 Preserve uncertainty in the data model

-   Use explicit nullable/unknown fields or a typed result that
    distinguishes verified data from missing data.
-   Do not silently replace missing price with a made-up amount.
-   Do not assume stock availability when the provider omitted stock
    information.
-   Do not substitute a default product quantity for an unknown
    quantity.
-   Do not present a hardcoded ETA or delivery fee as a live provider
    estimate.
-   If a demo needs sample data, label it visibly as simulated and keep
    it out of the production checkout path.

### 4.2 Separate display fallbacks from transaction facts

UI display defaults may be acceptable only if clearly marked and never
reused in transaction calculations. The backend must maintain a
distinction between:

-   Verified provider data.
-   Stale provider data.
-   Missing/unknown data.
-   Explicit demo/simulated data.

Only verified, sufficiently fresh price/availability/fee data may be
used for purchase authorization.

### 4.3 Revalidate before checkout

Immediately before submitting a checkout:

-   Fetch or validate current item IDs, prices, quantities,
    availability, fees, and total with the merchant/provider.
-   Recalculate the total server-side using integer minor units.
-   Compare it to the approved mandate.
-   If anything changed or is unknown, stop and require the user to
    review and approve the new purchase.
-   Never silently increase the amount beyond the approved amount.
-   Validate merchant/provider response schema and reject malformed
    responses.

### 4.4 Correct naming and source metadata

Return metadata such as `source`, `retrievedAt`, `isEstimated`, and
`isDemo` if useful to the API/UI. Do not call a value "live" or
"verified" unless it is actually verified by the provider. Avoid logging
personal delivery details unnecessarily.

## Acceptance criteria

-   [ ] Missing price does not become a plausible numeric price in
    production.
-   [ ] Missing stock status is not interpreted as in stock.
-   [ ] Missing delivery fee/ETA is shown as unknown or clearly
    estimated, never verified.
-   [ ] Checkout blocks when required price or availability data cannot
    be confirmed.
-   [ ] The final amount is recomputed server-side and must match the
    approved mandate.
-   [ ] Demo fixtures are explicit and cannot leak into production
    checkout.

------------------------------------------------------------------------

# 5. P1 --- Add production configuration validation and safe observability

## Required changes

-   Identify all environment variables required for authentication,
    database access, merchant integration, Prava/passkey verification,
    and AP2 verification.
-   Validate required configuration at startup in production. Fail fast
    with a clear, non-secret error when critical configuration is
    missing.
-   Never fall back to mock authorization/authentication/product data in
    production.
-   Keep secrets out of source control and logs. Check whether `.env`
    files or credentials were committed; if any real secret was exposed,
    remove it from the repository and rotate it. Do not print the secret
    in reports.
-   Use structured logs with request/operation correlation IDs.
-   Log security-relevant events: failed auth, ownership denial, invalid
    mandate, idempotency conflict, spend reservation, checkout state
    transition, provider failure, reconciliation required.
-   Do not log passwords, access tokens, passkey assertions, private
    keys, raw payment credentials, or unnecessary personal information.
-   Avoid returning stack traces or internal provider details to
    clients.
-   Add timeouts and bounded retries for upstream requests. Retry only
    operations known to be safe to retry; do not retry checkout blindly.
-   Make readiness checks distinguish application health from critical
    dependency readiness.

## Acceptance criteria

-   [ ] Production cannot silently start in mock mode.
-   [ ] Missing critical configuration produces a clear
    startup/configuration error.
-   [ ] Logs contain useful correlation IDs but no secrets.
-   [ ] Checkout calls have timeouts and safe retry policies.
-   [ ] Provider failures are observable without leaking sensitive
    payloads.

------------------------------------------------------------------------

# 6. P1 --- Validate all inputs and make money calculations deterministic

Review the request schemas and data boundaries for carts, mandates,
quantities, amounts, merchant IDs, postal codes, currency, and
idempotency keys.

Required behavior:

-   Validate input at API/MCP boundaries with the project's existing
    schema library if one exists.
-   Reject non-finite, negative, zero-when-disallowed, excessively
    large, or fractional quantities/amounts as appropriate.
-   Use integer minor units for currency. Do not use binary
    floating-point as the source of truth for money.
-   Recalculate all totals server-side; never trust a client-provided
    total.
-   Apply reasonable limits to request size, item count, quantity, and
    string lengths.
-   Normalize and validate IDs without silently coercing invalid values.
-   Keep currency explicit; never compare amounts across currencies
    without a defined conversion policy.
-   Ensure user-provided text cannot become SQL, shell, or unsafe log
    content.
-   Use parameterized DB queries/ORM operations.

Add tests for malformed JSON/input, invalid quantity, negative amounts,
currency mismatch, stale price, and oversized carts.

------------------------------------------------------------------------

# 7. P1 --- Review MCP/tool security and side-effect boundaries

Because this project exposes commerce operations through MCP tools,
inspect every tool that reads or mutates carts, product data, mandates,
user identity, spend limits, and checkout.

-   Require trusted authenticated context for sensitive operations.
-   Do not trust model-generated arguments for user identity, price,
    merchant authorization, or payment approval.
-   Treat LLM/agent output as untrusted input. Validate it against a
    schema before acting.
-   Read-only product discovery must be separated from purchase
    execution.
-   A tool call that initiates a purchase must pass through the same
    server-side authorization, mandate, spend-reservation, and
    idempotency path as any HTTP endpoint.
-   Do not allow the agent to skip confirmation/authorization by
    directly invoking a lower-level merchant method.
-   Require explicit user approval for a changed cart/total and bind the
    approval to the exact immutable checkout snapshot.
-   Enforce timeouts, output-size limits, and safe error handling for
    MCP calls.
-   Prevent prompt-injection content from product descriptions or
    merchant responses from changing tool permissions or bypassing
    policy. Treat retrieved content as data, not trusted instructions.

Add tests that attempt to call checkout without authorization, with a
different user ID, with an altered total, and with a reused mandate.

------------------------------------------------------------------------

# 8. Database and migration guidance

Before changing the schema:

1.  Inspect the current database technology, ORM, migration workflow,
    and existing schema.
2.  Reuse the existing approach and naming conventions.
3.  Add migrations rather than relying on runtime-only schema mutation.
4.  Add unique constraints and foreign keys that enforce critical
    invariants.
5.  Consider indexes for user ID, mandate ID, idempotency key, checkout
    status, and created timestamp.
6.  Ensure migrations are safe for existing development data and
    documented for deployment.
7.  Avoid storing raw passkey assertions, passwords, provider secrets,
    or unnecessary personal data.

Potential entities/fields (adapt to the existing model; do not create
duplicate concepts if equivalent tables already exist):

-   `checkout_operations`: ID, user ID, idempotency key, request/cart
    fingerprint, merchant ID, mandate ID, amount minor units, currency,
    state, provider reference, timestamps, failure category.
-   `mandate_consumptions` or a unique consumed/checkout relation:
    mandate ID, checkout ID, consumed timestamp.
-   `spend_reservations`: ID, user ID, checkout ID, amount minor units,
    currency, state, timestamps.
-   Durable transaction/order ledger: unique provider order/reference
    where available, checkout ID, confirmed amount, currency, final
    status.
-   Optional audit events: actor/user ID, action, resource ID, result,
    timestamp, correlation ID; never store secrets in audit payloads.

These are conceptual examples, not mandatory table names. Prefer a
minimal coherent schema.

------------------------------------------------------------------------

# 9. Required test plan

Use the project's existing test runner. If no test infrastructure
exists, add a minimal test setup consistent with the current
TypeScript/runtime stack and document the command.

## 9.1 Authorization tests

-   Provider HTTP error, timeout, malformed JSON, missing fields.
-   Invalid/missing signature.
-   Wrong origin/RP ID/user/challenge.
-   Expired and replayed challenge.
-   Mandate expiry and modified amount/currency/cart.
-   Production configuration missing: no mock fallback.
-   Explicit test mode: mock works only in tests.

## 9.2 Authentication and ownership tests

-   Missing password/session rejected.
-   Wrong password rejected.
-   Unknown identity does not fall back to active/default user.
-   User A cannot access User B's cart, mandate, order, spend profile,
    or passkey challenge.
-   MCP and HTTP paths enforce equivalent checks.
-   Production cannot enable mock authentication.

## 9.3 Idempotency and concurrency tests

-   Two simultaneous requests with the same mandate: one submission at
    most.
-   Two simultaneous checkouts whose combined amount exceeds the limit:
    at most the permitted amount is reserved/charged.
-   Same idempotency key and same payload: same operation returned.
-   Same key with different payload: conflict rejected.
-   Server restart preserves state.
-   Multiple service instances share durable state.
-   Crash/timeout after merchant submission: state becomes uncertain and
    no blind duplicate submission occurs.
-   Definitive failure releases reservation once.
-   Success finalizes transaction/spend once.

Use a real test database or a database-backed integration test for
concurrency guarantees. In-memory mocks alone cannot prove DB
locking/uniqueness behavior.

## 9.4 Product data tests

-   Missing price, stock, quantity, ETA, and fee remain unknown.
-   Explicit demo data is labeled and cannot be used for production
    checkout.
-   Provider price changes between cart and checkout require new
    approval.
-   Unavailable product blocks checkout.
-   Server-side total matches the provider's authoritative total.

## 9.5 Regression and quality checks

Run and report the actual result of the repository's applicable
commands, for example:

-   TypeScript type-check.
-   Lint.
-   Unit tests.
-   Integration tests.
-   Build.
-   Migration validation.

Do not claim a command passed unless it was run and its result was
observed. If an external provider or database is unavailable, mark the
corresponding integration test as blocked and explain why; do not
replace it with a false-success mock.

------------------------------------------------------------------------

# 10. Implementation sequence

Do not attempt a single giant rewrite. Implement in this order, keeping
each phase reviewable.

## Phase 0 --- Baseline and threat-path map

-   Inspect repository scripts, auth entry points, checkout flow,
    provider clients, database schema, and tests.
-   Map every path from user/agent input to merchant side effect.
-   Identify where identity, mandate, amount, stock, and spend checks
    occur.
-   Report the current behavior and planned file changes before making
    broad architectural changes.
-   Do not expose secrets while inspecting configuration.

**Deliverable:** a concise call-path map and list of changed files.

## Phase 1 --- Close immediate authorization bypasses

-   Remove local success fallback from production Prava client.
-   Make authorization errors explicit and fail closed.
-   Validate the mandate through a real supported verification contract.
-   Gate all mocks behind explicit test-only configuration.
-   Add regression tests proving provider failure cannot authorize
    checkout.

**Exit gate:** checkout is impossible without a verified authorization
result.

## Phase 2 --- Fix identity and ownership

-   Replace active/default-user fallback with a trusted authenticated
    principal.
-   Require credentials and remove default passwords.
-   Isolate mock users.
-   Add resource ownership checks to every sensitive route/tool.
-   Add cross-user access tests.

**Exit gate:** changing IDs in requests cannot change identity or access
another user's resources.

## Phase 3 --- Durable checkout and spending controls

-   Add persistent checkout state and idempotency.
-   Add atomic mandate consumption.
-   Add spend reservation and finalization.
-   Handle timeouts and unknown outcomes without blind retries.
-   Add database integration/concurrency tests.

**Exit gate:** concurrent/retried requests cannot bypass the one-time
mandate and spend budget rules.

## Phase 4 --- Correct product and pricing data

-   Remove fabricated transaction values.
-   Distinguish verified, estimated, stale, missing, and demo data.
-   Revalidate cart and totals immediately before checkout.
-   Require re-approval if any purchase-relevant fact changes.

**Exit gate:** checkout cannot proceed with unknown or unapproved
purchase facts.

## Phase 5 --- Hardening and documentation

-   Validate configuration.
-   Add structured safe logging, correlation IDs, timeout policy, and
    readiness checks.
-   Review MCP tools and all side-effect paths.
-   Run complete tests/build/lint/type-check.
-   Update `.env.example`, README, migration docs, and test instructions
    as appropriate.

**Exit gate:** operational setup and known limitations are documented,
and all required checks are reported truthfully.

------------------------------------------------------------------------

# 11. Definition of done

The work is not complete until all applicable items below are true:

-   [ ] No production path can convert provider failure into payment
    authorization success.
-   [ ] No production path uses a synthetic challenge/token to authorize
    a real purchase.
-   [ ] Real passkey/mandate verification follows the actual provider
    contract.
-   [ ] Authenticated identity comes from trusted server-side context.
-   [ ] Missing credentials and unknown identities are rejected.
-   [ ] All sensitive resources enforce ownership.
-   [ ] Mock auth/provider/product data cannot be enabled in production.
-   [ ] Mandate consumption is durable and atomic.
-   [ ] Checkout idempotency survives process restarts and multiple
    instances.
-   [ ] Spend-limit reservation is durable and concurrency-safe.
-   [ ] Ambiguous merchant outcomes are reconciled before retry.
-   [ ] Unknown product price/stock/fee data is not fabricated into
    transaction facts.
-   [ ] Final cart, amount, currency, and merchant are revalidated and
    match user approval.
-   [ ] MCP tools cannot bypass checkout controls.
-   [ ] Regression, integration, and concurrency tests exist and are
    run.
-   [ ] Migrations and required environment variables are documented.
-   [ ] Logs contain no secrets or sensitive authorization payloads.
-   [ ] Final report lists files changed, behavior changed, tests
    actually run, test results, migration steps, required configuration,
    and remaining provider-dependent limitations.

------------------------------------------------------------------------

# 12. Final report Codex must produce

When finished, return a concise implementation report with:

1.  **Changes made:** grouped by the priority sections above.
2.  **Important files changed:** path and one-line purpose.
3.  **Schema/migrations:** what changed and how to apply it.
4.  **Security guarantees:** specifically what is now enforced and
    where.
5.  **Tests run:** exact commands and observed results.
6.  **Tests not run:** why they could not run.
7.  **Configuration required:** variable names and descriptions only;
    never print secret values.
8.  **Provider dependencies:** any behavior that cannot be completed
    without official Prava/AP2/merchant API documentation or
    credentials.
9.  **Remaining risks:** explicitly distinguish unresolved risks from
    fixed issues.

If a required external provider contract is unavailable, do not invent
it. Implement the fail-closed boundary, add tests for failure behavior,
and document precisely what is needed to complete the real integration.
