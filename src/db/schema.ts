import {
  pgTable,
  text,
  varchar,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  uuid,
  bigserial,
  pgEnum,
  uniqueIndex,
  index,
  vector,
} from 'drizzle-orm/pg-core';

// Enums
export const mandateStatusEnum = pgEnum('mandate_status', [
  'pending',
  'approved',
  'expired',
  'consumed',
  'revoked',
]);

export const transactionStatusEnum = pgEnum('transaction_status', [
  'pending',
  'completed',
  'failed',
  'refunded',
]);

export const sessionStatusEnum = pgEnum('session_status', [
  'active',
  'completed',
  'abandoned',
]);

export const budgetReservationStatusEnum = pgEnum('budget_reservation_status', [
  'active',
  'committed',
  'released',
  'expired',
]);

export type MandateStatus = (typeof mandateStatusEnum.enumValues)[number];
export type TransactionStatus = (typeof transactionStatusEnum.enumValues)[number];
export type SessionStatus = (typeof sessionStatusEnum.enumValues)[number];
export type BudgetReservationStatus = (typeof budgetReservationStatusEnum.enumValues)[number];

// 1. Users Table with Delivery Location and Daily Spend Limit (₹5,000.00 default = 500,000 paise)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  defaultAddress: text('default_address'),
  defaultPincode: varchar('default_pincode', { length: 10 }),
  defaultLatitude: doublePrecision('default_latitude'),
  defaultLongitude: doublePrecision('default_longitude'),
  pravaAccountId: text('prava_account_id').unique(),
  dailySpendLimitCents: integer('daily_spend_limit_cents').notNull().default(500000), // In paise (100 paise = 1 INR)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 2. Agent Sessions with active delivery location
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: sessionStatusEnum('status').notNull().default('active'),
  deliveryLocation: jsonb('delivery_location').notNull().default({}), // Active confirmed address, pincode, lat/lng
  sessionMetadata: jsonb('session_metadata').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  index('idx_agent_sessions_user_started').on(table.userId, table.startedAt),
]);

// 3. Intents Table
export const intents = pgTable('intents', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  rawMessage: text('raw_message').notNull(),
  structuredGoal: jsonb('structured_goal').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 4. Candidate Options (Ranked Quick-Commerce Proposals from Swiggy / Zepto)
export const candidateOptions = pgTable('candidate_options', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  merchantId: text('merchant_id').notNull(), // 'swiggy_instamart', 'swiggy_food', 'zepto'
  merchantName: text('merchant_name').notNull(),
  itemName: text('item_name').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('INR'),
  deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
  etaMinutes: integer('eta_minutes'),
  productUrl: text('product_url'),
  metadata: jsonb('metadata').notNull().default({}),
  rank: integer('rank').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_candidate_options_session').on(table.sessionId, table.rank),
]);

// 5. Mandates Table (AP2 Mandate lifecycle)
export const mandates = pgTable('mandates', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id),
  mandateId: text('mandate_id').notNull().unique(), // AP2 unique mandateId
  merchantId: text('merchant_id').notNull(), // 'swiggy' or 'zepto'
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: mandateStatusEnum('status').notNull().default('pending'),
  rawMandate: jsonb('raw_mandate').notNull(), // Full AP2 CartMandate structure
  signedMandate: jsonb('signed_mandate'), // Full AP2 SignedMandate with WebAuthn signature
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_mandates_user_status').on(table.userId, table.status, table.expiresAt),
]);

// 6. Transactions Table (Enforces single-use mandate guarantee via UNIQUE constraint)
export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id),
  mandateId: uuid('mandate_id').notNull().references(() => mandates.id), // Guaranteed unique per transaction
  idempotencyKey: text('idempotency_key').unique(),
  pravaTokenRef: text('prava_token_ref').notNull(),
  merchantId: text('merchant_id').notNull(),
  merchantOrderId: text('merchant_order_id'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: transactionStatusEnum('status').notNull().default('pending'),
  receiptSummary: jsonb('receipt_summary').notNull().default({}),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_transactions_mandate_unique').on(table.mandateId),
  uniqueIndex('idx_transactions_idempotency_key').on(table.idempotencyKey),
  index('idx_transactions_user_created').on(table.userId, table.createdAt),
]);

// 7. Audit Log Table (Immutable ledger of all agent steps, MCP tool calls, and mandate events)
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId: uuid('session_id').references(() => agentSessions.id),
  userId: uuid('user_id').references(() => users.id),
  eventType: text('event_type').notNull(),
  agentStep: text('agent_step'),
  toolName: text('tool_name'),
  toolInput: jsonb('tool_input'),
  toolOutput: jsonb('tool_output'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_audit_log_session').on(table.sessionId, table.createdAt),
]);

// 8. Product Embeddings Table (Semantic Search Fallback with pgvector)
export const productEmbeddings = pgTable('product_embeddings', {
  id: uuid('id').defaultRandom().primaryKey(),
  merchantId: text('merchant_id').notNull(),
  itemId: text('item_id').notNull(),
  itemName: text('item_name').notNull(),
  category: text('category'),
  priceCents: integer('price_cents').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  embedding: vector('embedding', { dimensions: 768 }).notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_product_merchant_item').on(table.merchantId, table.itemId),
]);

// Inferred TypeScript Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;

export type Intent = typeof intents.$inferSelect;
export type NewIntent = typeof intents.$inferInsert;

export type CandidateOption = typeof candidateOptions.$inferSelect;
export type NewCandidateOption = typeof candidateOptions.$inferInsert;

export type Mandate = typeof mandates.$inferSelect;
export type NewMandate = typeof mandates.$inferInsert;

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

export type ProductEmbedding = typeof productEmbeddings.$inferSelect;
export type NewProductEmbedding = typeof productEmbeddings.$inferInsert;

// 9. Budget Reservations Table (Authoritative Backend Daily Budget Reservations)
export const budgetReservations = pgTable('budget_reservations', {
  id: uuid('id').defaultRandom().primaryKey(),
  reservationId: text('reservation_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mandateId: text('mandate_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: budgetReservationStatusEnum('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_budget_reservations_user_status').on(table.userId, table.status, table.expiresAt),
  uniqueIndex('idx_budget_reservations_mandate').on(table.mandateId),
]);

export type BudgetReservation = typeof budgetReservations.$inferSelect;
export type NewBudgetReservation = typeof budgetReservations.$inferInsert;
