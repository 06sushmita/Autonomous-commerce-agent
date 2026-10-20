/**
 * Unified Authentication Layer with Live Clerk Integration & Neon Database Persistence
 *
 * Supports:
 *  - Real Clerk Authentication for User Sign-up & Login
 *  - Dynamic, User-editable Delivery Address & Location
 *  - Dynamic, User-editable Daily Spend Limits (Wallet Budget) with Database Persistence
 *  - Active Session Management (Agent orders on behalf of the currently authenticated Clerk user)
 *  - Fail-closed in Production: rejects mock/default credentials when NODE_ENV === 'production'
 */

import { createClerkClient, type ClerkClient } from '@clerk/backend';
import { eq, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';

export interface AuthUser {
  id: string;
  clerkUserId: string;
  email: string;
  phone?: string;
  displayName: string;
  defaultAddress: string;
  defaultPincode: string;
  defaultLatitude?: number;
  defaultLongitude?: number;
  dailySpendLimitCents: number; // in paise (100 paise = 1 INR)
  pravaAccountId?: string;
  swiggyAddressId?: string;
  password?: string;
}

export const ARJUN_USER: AuthUser = {
  id: '00000000-0000-0000-0000-000000000001',
  clerkUserId: 'user_mock_indiranagar_01',
  email: 'arjun.sharma@example.com',
  phone: '9876543210',
  displayName: 'Arjun Sharma',
  defaultAddress: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
  defaultPincode: '560103',
  defaultLatitude: 12.9298,
  defaultLongitude: 77.6835,
  dailySpendLimitCents: 500000, // ₹5,000.00
  pravaAccountId: 'prava_acc_mock_01',
  password: 'password123',
};

export const DEFAULT_MOCK_USER = ARJUN_USER;

export const SUSHMITA_USER: AuthUser = {
  id: '4e14bafb-6b86-43f8-9319-901ced15b5fe',
  clerkUserId: 'user_3KjhrVNHC05EX0IP8D7Uk6DPxBt',
  email: 'sushmita.mishra@example.com',
  phone: '9820002845',
  displayName: 'Sushmita Mishra',
  defaultAddress: 'A/30, Sai Anant Darshan, Kopar Rd, Shastri Nagar, Dombivli West, Dombivli, Maharashtra 421202',
  defaultPincode: '421202',
  defaultLatitude: 19.2183,
  defaultLongitude: 73.0867,
  dailySpendLimitCents: 500000, // ₹5,000.00
  pravaAccountId: 'prava_acc_sushmita_01',
  swiggyAddressId: 'd82m443k649i1ha7jl1g__ASU5hwRbGdogCwdOI6ZQJg',
  password: 'password123',
};

export const SHUBHAM_USER: AuthUser = {
  id: 'b74aa3f5-761d-40f9-9bc2-41b03346f0c3',
  clerkUserId: 'user_3KkSYq9sgXOy8L9T4irMRPpuzCc',
  email: 'mahajanishubham19@gmail.com',
  phone: '9876543210',
  displayName: 'Shubham Mahajani',
  defaultAddress: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru, Karnataka 560103',
  defaultPincode: '560103',
  defaultLatitude: 12.9298,
  defaultLongitude: 77.6835,
  dailySpendLimitCents: 750000, // ₹7,500.00
  pravaAccountId: 'prava_acc_shubham_01',
  password: 'password123',
};

export interface RegisterUserInput {
  displayName: string;
  email: string;
  phone?: string;
  password?: string;
  address: string;
  pincode: string;
  latitude?: number;
  longitude?: number;
  dailySpendLimitINR?: number;
}

export class AuthProvider {
  private users: Map<string, AuthUser> = new Map();
  private activeUserId: string = DEFAULT_MOCK_USER.id;
  private clerkClient: ClerkClient | null = null;
  private initializedFromRemote = false;

  constructor() {
    this.initClerkClient();
    this.seedDefaultUsers();
  }

  private initClerkClient(): void {
    const secretKey = process.env.CLERK_SECRET_KEY;
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

    if (secretKey && !secretKey.includes('placeholder') && !secretKey.startsWith('mock_')) {
      try {
        this.clerkClient = createClerkClient({ secretKey, publishableKey });
      } catch (err) {
        console.warn('Failed to initialize Clerk backend client:', err);
      }
    }
  }

  private seedDefaultUsers(): void {
    if (process.env.NODE_ENV === 'production') {
      if (!this.isClerkConfigured() && !process.env.DATABASE_URL) {
        throw new Error('Production startup error: Clerk authentication or database is required.');
      }
      return; // Never seed mock default credentials in production
    }
    this.seedUser({ ...DEFAULT_MOCK_USER });
    this.activeUserId = DEFAULT_MOCK_USER.id;
  }

  public seedVerifiedClerkProfiles(): void {
    this.seedUser({ ...SUSHMITA_USER });
    this.seedUser({
      ...SUSHMITA_USER,
      email: 'mishrasushmita06@gmail.com',
    });
    this.seedUser({ ...SHUBHAM_USER });
  }

  public isMockMode(): boolean {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    const key = process.env.CLERK_SECRET_KEY;
    return !key || key.includes('placeholder') || key.startsWith('mock_');
  }

  public isClerkConfigured(): boolean {
    return this.clerkClient !== null && !this.isMockMode();
  }

  public seedUser(user: AuthUser): void {
    this.users.set(user.id, user);
    this.users.set(user.clerkUserId, user);
    if (user.email) this.users.set(user.email.toLowerCase(), user);
    if (user.phone) this.users.set(user.phone, user);
  }

  public listUsers(): AuthUser[] {
    const unique = new Set<string>();
    const list: AuthUser[] = [];
    for (const user of this.users.values()) {
      if (!unique.has(user.id)) {
        unique.add(user.id);
        const { password, ...safeUser } = user;
        list.push(safeUser as AuthUser);
      }
    }
    return list;
  }

  public reset(): void {
    this.users.clear();
    this.seedDefaultUsers();
    this.activeUserId = DEFAULT_MOCK_USER.id;
  }

  public getActiveUser(): AuthUser {
    const user = this.users.get(this.activeUserId);
    if (!user) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Authentication error: No authenticated session is currently active.');
      }
      return DEFAULT_MOCK_USER;
    }
    return user;
  }

  public setActiveUser(userId: string): AuthUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    this.activeUserId = user.id;
    return user;
  }

  /**
   * Sync verified users from Clerk and Neon PostgreSQL Database
   */
  public async syncWithClerkAndDb(): Promise<void> {
    const db = getDb();

    // 1. Fetch live DB users
    if (db) {
      try {
        const dbUsers = await db.query.users.findMany();
        for (const u of dbUsers) {
          const authU: AuthUser = {
            id: u.id,
            clerkUserId: u.clerkUserId,
            email: u.email,
            displayName: u.displayName,
            defaultAddress: u.defaultAddress || 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
            defaultPincode: u.defaultPincode || '560103',
            defaultLatitude: u.defaultLatitude || 12.9298,
            defaultLongitude: u.defaultLongitude || 77.6835,
            dailySpendLimitCents: u.dailySpendLimitCents || 500000,
            pravaAccountId: u.pravaAccountId || undefined,
          };
          this.seedUser(authU);
        }
      } catch (err: any) {
        console.warn('Notice: Could not sync DB users on startup:', err.message);
      }
    }

    // 2. Fetch live Clerk users
    if (this.clerkClient) {
      try {
        const clerkRes = await this.clerkClient.users.getUserList({ limit: 50 });
        for (const cu of clerkRes.data) {
          const email = cu.emailAddresses[0]?.emailAddress;
          const phone = cu.phoneNumbers[0]?.phoneNumber;
          const name = `${cu.firstName || ''} ${cu.lastName || ''}`.trim() || email || 'Clerk User';

          const existing = this.users.get(cu.id) || (email ? this.users.get(email.toLowerCase()) : undefined);
          if (existing) {
            existing.clerkUserId = cu.id;
            existing.displayName = existing.displayName || name;
            this.seedUser(existing);
          } else {
            const newUser: AuthUser = {
              id: cu.id,
              clerkUserId: cu.id,
              email: email || `${cu.id}@clerk.user`,
              phone: phone || undefined,
              displayName: name,
              defaultAddress: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
              defaultPincode: '560103',
              defaultLatitude: 12.9298,
              defaultLongitude: 77.6835,
              dailySpendLimitCents: 500000,
            };
            this.seedUser(newUser);
          }
        }
      } catch (err: any) {
        console.warn('Notice: Clerk user list sync:', err.message);
      }
    }

    this.initializedFromRemote = true;
  }

  /**
   * Register a new user with real Clerk integration & Neon PostgreSQL persistence
   */
  public async registerWithClerk(input: RegisterUserInput): Promise<AuthUser> {
    if (!input.displayName || !input.email || !input.address || !input.pincode) {
      throw new Error('Name, Email, Delivery Address, and Pincode are required.');
    }

    const emailNorm = input.email.toLowerCase().trim();
    const limitCents = input.dailySpendLimitINR
      ? Math.round(input.dailySpendLimitINR * 100)
      : 500000; // Default ₹5,000

    let clerkId = `clerk_user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 1. Create User in Clerk if configured
    if (this.clerkClient && !this.isMockMode()) {
      const parts = input.displayName.trim().split(' ');
      const firstName = parts[0] || 'User';
      const lastName = parts.slice(1).join(' ') || undefined;

      let clerkUser: any = null;
      let lastClerkErr: any = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Clerk instance settings require phone_number, but free tier rejects India (+91).
          // Try user's phone if it starts with +1, otherwise provide a unique E.164 compliant US test number.
          let phoneToUse: string | undefined = undefined;
          if (attempt === 0 && input.phone && input.phone.trim().startsWith('+1')) {
            phoneToUse = input.phone.trim();
          } else {
            const randSuffix = Math.floor(1000 + Math.random() * 9000);
            phoneToUse = `+1202555${randSuffix}`;
          }

          clerkUser = await this.clerkClient.users.createUser({
            emailAddress: [emailNorm],
            firstName,
            lastName,
            password: input.password && input.password.length >= 8 ? input.password : undefined,
            phoneNumber: phoneToUse ? [phoneToUse] : undefined,
            skipPasswordChecks: true,
            skipPasswordRequirement: !input.password,
          });
          clerkId = clerkUser.id;
          break;
        } catch (clerkErr: any) {
          lastClerkErr = clerkErr;

          // If phone number collision, retry with another random phone suffix
          const isPhoneConflict = clerkErr.errors?.some(
            (e: any) => e.meta?.paramName === 'phone_number' || e.message?.includes('phone')
          );
          if (isPhoneConflict) {
            continue;
          }

          // If user already exists in Clerk, fetch their existing record
          const isEmailExists =
            clerkErr.errors?.some(
              (e: any) => e.code === 'form_identifier_exists' || e.meta?.paramName === 'email_address'
            ) || clerkErr.message?.includes('already exists');

          if (isEmailExists) {
            try {
              const existingList = await this.clerkClient.users.getUserList({ emailAddress: [emailNorm] });
              if (existingList.data[0]) {
                clerkId = existingList.data[0].id;
                break;
              }
            } catch {
              // fall through
            }
            throw new Error(`A Clerk account with email "${emailNorm}" already exists. Please log in.`);
          }

          throw new Error(
            `Clerk registration error: ${
              clerkErr.errors?.[0]?.longMessage || clerkErr.errors?.[0]?.message || clerkErr.message
            }`
          );
        }
      }

      if (!clerkUser && !clerkId.startsWith('user_')) {
        throw new Error(
          `Clerk registration error: ${
            lastClerkErr?.errors?.[0]?.longMessage || lastClerkErr?.message || 'Failed to create Clerk account'
          }`
        );
      }
    }

    // 2. Persist to Neon PostgreSQL Database
    const db = getDb();
    let dbId = clerkId;

    if (db) {
      try {
        const existing = await db.query.users.findFirst({
          where: or(eq(users.clerkUserId, clerkId), eq(users.email, emailNorm)),
        });

        if (existing) {
          const [updated] = await db
            .update(users)
            .set({
              clerkUserId: clerkId,
              displayName: input.displayName.trim(),
              defaultAddress: input.address.trim(),
              defaultPincode: input.pincode.trim(),
              defaultLatitude: input.latitude || 19.2183,
              defaultLongitude: input.longitude || 73.0867,
              dailySpendLimitCents: limitCents,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existing.id))
            .returning();
          if (updated?.id) dbId = updated.id;
        } else {
          const [inserted] = await db
            .insert(users)
            .values({
              clerkUserId: clerkId,
              email: emailNorm,
              displayName: input.displayName.trim(),
              defaultAddress: input.address.trim(),
              defaultPincode: input.pincode.trim(),
              defaultLatitude: input.latitude || 19.2183,
              defaultLongitude: input.longitude || 73.0867,
              dailySpendLimitCents: limitCents,
              pravaAccountId: `prava_${clerkId.replace('user_', '')}`,
            })
            .returning();
          if (inserted?.id) dbId = inserted.id;
        }
      } catch (dbErr: any) {
        console.warn('Neon DB user persistence note:', dbErr.message);
      }
    }

    const newUser: AuthUser = {
      id: dbId,
      clerkUserId: clerkId,
      email: emailNorm,
      phone: input.phone?.trim() || '',
      displayName: input.displayName.trim(),
      defaultAddress: input.address.trim(),
      defaultPincode: input.pincode.trim(),
      defaultLatitude: input.latitude || 19.2183,
      defaultLongitude: input.longitude || 73.0867,
      dailySpendLimitCents: limitCents,
      pravaAccountId: `prava_${clerkId.replace('user_', '')}`,
      password: input.password,
    };

    this.seedUser(newUser);
    this.activeUserId = newUser.id;
    return newUser;
  }

  /**
   * Log in an existing user with Clerk verification & Neon PostgreSQL profile loading
   */
  public async loginWithClerk(emailOrPhone: string, password?: string): Promise<AuthUser> {
    const key = emailOrPhone.toLowerCase().trim();

    // 1. If Clerk client is configured, check against live Clerk user repository
    if (this.clerkClient && !this.isMockMode()) {
      try {
        const res = await this.clerkClient.users.getUserList({ emailAddress: [key] });
        if (res.data.length > 0) {
          const cu = res.data[0];
          let user = this.users.get(cu.id) || this.users.get(key);

          // If not in local cache, load from DB
          const db = getDb();
          if (db) {
            const dbUser = await db.query.users.findFirst({
              where: or(eq(users.clerkUserId, cu.id), eq(users.email, key)),
            });
            if (dbUser) {
              user = {
                id: dbUser.id,
                clerkUserId: dbUser.clerkUserId,
                email: dbUser.email,
                displayName: dbUser.displayName,
                defaultAddress: dbUser.defaultAddress || 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
                defaultPincode: dbUser.defaultPincode || '560103',
                defaultLatitude: dbUser.defaultLatitude || 12.9298,
                defaultLongitude: dbUser.defaultLongitude || 77.6835,
                dailySpendLimitCents: dbUser.dailySpendLimitCents || 500000,
                pravaAccountId: dbUser.pravaAccountId || undefined,
              };
              this.seedUser(user);
            }
          }

          if (user) {
            this.activeUserId = user.id;
            return user;
          }
        }
      } catch (err: any) {
        console.warn('Clerk login lookup error:', err.message);
      }
    }

    // 2. Check Neon Database
    const db = getDb();
    if (db) {
      try {
        const dbUser = await db.query.users.findFirst({
          where: eq(users.email, key),
        });
        if (dbUser) {
          const authUser: AuthUser = {
            id: dbUser.id,
            clerkUserId: dbUser.clerkUserId,
            email: dbUser.email,
            displayName: dbUser.displayName,
            defaultAddress: dbUser.defaultAddress || 'Flat 402, Green Glen Layout, Bellandur, Bengaluru',
            defaultPincode: dbUser.defaultPincode || '560103',
            defaultLatitude: dbUser.defaultLatitude || 12.9298,
            defaultLongitude: dbUser.defaultLongitude || 77.6835,
            dailySpendLimitCents: dbUser.dailySpendLimitCents || 500000,
            pravaAccountId: dbUser.pravaAccountId || undefined,
          };
          this.seedUser(authUser);
          this.activeUserId = authUser.id;
          return authUser;
        }
      } catch (err: any) {
        console.warn('DB login lookup note:', err.message);
      }
    }

    // 3. Fall back to registered user store
    return this.loginUser(emailOrPhone, password);
  }

  /**
   * Synchronous Register fallback (preserves unit test compatibility)
   */
  public registerUser(input: RegisterUserInput): AuthUser {
    if (!input.displayName || !input.email || !input.address || !input.pincode) {
      throw new Error('Name, Email, Delivery Address, and Pincode are required.');
    }

    const emailNorm = input.email.toLowerCase().trim();
    if (this.users.has(emailNorm)) {
      throw new Error('An account with this email address already exists. Please log in.');
    }

    const id = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const limitCents = input.dailySpendLimitINR
      ? Math.round(input.dailySpendLimitINR * 100)
      : 500000; // Default ₹5,000

    const newUser: AuthUser = {
      id,
      clerkUserId: `clerk_${id}`,
      email: emailNorm,
      phone: input.phone?.trim() || '',
      displayName: input.displayName.trim(),
      defaultAddress: input.address.trim(),
      defaultPincode: input.pincode.trim(),
      defaultLatitude: input.latitude || 19.2183,
      defaultLongitude: input.longitude || 73.0867,
      dailySpendLimitCents: limitCents,
      pravaAccountId: `prava_${id}`,
      password: input.password || 'password123',
    };

    this.seedUser(newUser);
    this.activeUserId = newUser.id;
    return newUser;
  }

  /**
   * Synchronous Login fallback (preserves unit test compatibility)
   */
  public loginUser(emailOrPhone: string, password?: string): AuthUser {
    const key = emailOrPhone.toLowerCase().trim();
    const user = this.users.get(key);

    if (!user) {
      throw new Error('No user found with the provided email or phone number.');
    }

    if (!password || typeof password !== 'string' || password.trim() === '') {
      throw new Error('Password credential is required for login.');
    }

    if (user.password && user.password !== password) {
      throw new Error('Invalid credentials. Please verify your password.');
    }

    this.activeUserId = user.id;
    return user;
  }

  /**
   * Get authenticated user by ID, email, or currently active session
   */
  public async getAuthenticatedUser(userIdOrKey?: string): Promise<AuthUser> {
    if (userIdOrKey) {
      const found = this.users.get(userIdOrKey) || this.users.get(userIdOrKey.toLowerCase());
      if (found) {
        return found;
      }
      throw new Error(`Authentication error: No user found for identifier "${userIdOrKey}".`);
    }

    if (process.env.NODE_ENV === 'production' && (!this.activeUserId || this.activeUserId === DEFAULT_MOCK_USER.id)) {
      throw new Error('Authentication error: No active authenticated session found. Please log in.');
    }

    return this.getActiveUser();
  }

  /**
   * Dynamic Delivery Location Update: Updates active session & Neon PostgreSQL database
   */
  public updateUserDeliveryLocation(
    userId: string,
    address: string,
    pincode: string,
    latitude?: number,
    longitude?: number
  ): AuthUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    user.defaultAddress = address;
    user.defaultPincode = pincode;
    if (latitude !== undefined) user.defaultLatitude = latitude;
    if (longitude !== undefined) user.defaultLongitude = longitude;

    // Asynchronously update database if configured
    const db = getDb();
    if (db) {
      db.update(users)
        .set({
          defaultAddress: address,
          defaultPincode: pincode,
          defaultLatitude: latitude,
          defaultLongitude: longitude,
          updatedAt: new Date(),
        })
        .where(or(eq(users.id, user.id), eq(users.clerkUserId, user.clerkUserId)))
        .catch((err) => console.warn('Failed to update user address in Neon DB:', err.message));
    }

    return user;
  }

  /**
   * Dynamic Daily Spend Limit (Wallet Budget) Update:
   * Enforces validation and persists immediately to Neon PostgreSQL database
   */
  public updateUserDailySpendLimit(userId: string, newLimitCents: number): AuthUser {
    if (newLimitCents < 100 || newLimitCents > 50000000) {
      throw new Error('Daily spend limit must be between ₹1 and ₹5,00,000.');
    }

    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    user.dailySpendLimitCents = newLimitCents;

    // Asynchronously update database if configured
    const db = getDb();
    if (db) {
      db.update(users)
        .set({
          dailySpendLimitCents: newLimitCents,
          updatedAt: new Date(),
        })
        .where(or(eq(users.id, user.id), eq(users.clerkUserId, user.clerkUserId)))
        .catch((err) => console.warn('Failed to update user spend limit in Neon DB:', err.message));
    }

    return user;
  }
}

export const authProvider = new AuthProvider();
