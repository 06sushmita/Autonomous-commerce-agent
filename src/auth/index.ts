/**
 * Unified Authentication Layer
 *
 * Supports:
 *  - User Registration (Sign Up) with Delivery Location, Phone, and Daily Spend Limit
 *  - User Authentication (Login) by Email or Phone Number
 *  - Active Session Management (Agent orders on behalf of the currently logged-in user)
 *  - Pre-seeded Verified Profiles (Sushmita Mishra for Dombivli & Arjun Sharma for Bengaluru)
 */

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
  id: 'user_sushmita_01',
  clerkUserId: 'user_sushmita_mishra',
  email: 'sushmita.mishra@example.com',
  phone: '9820002845',
  displayName: 'Sushmita Mishra',
  defaultAddress: 'A/30, Sai Anant Darshan, Sai Anant Darshan, Kopar Rd, Shastri Nagar, Dombivli West, Dombivli, Maharashtra 421202',
  defaultPincode: '421202',
  defaultLatitude: 19.2183,
  defaultLongitude: 73.0867,
  dailySpendLimitCents: 500000, // ₹5,000.00
  pravaAccountId: 'prava_acc_sushmita_01',
  swiggyAddressId: 'd82m443k649i1ha7jl1g__ASU5hwRbGdogCwdOI6ZQJg',
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

  constructor() {
    this.seedDefaultUsers();
  }

  private seedDefaultUsers(): void {
    this.seedUser({ ...DEFAULT_MOCK_USER });
    this.activeUserId = DEFAULT_MOCK_USER.id;
  }

  public isMockMode(): boolean {
    const key = process.env.CLERK_SECRET_KEY;
    return !key || key.includes('placeholder') || key.startsWith('mock_');
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
  }

  public getActiveUser(): AuthUser {
    return this.users.get(this.activeUserId) || SUSHMITA_USER;
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
   * Register a new user with custom delivery address, pincode, and spend limit
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
   * Log in an existing user via email or phone
   */
  public loginUser(emailOrPhone: string, password?: string): AuthUser {
    const key = emailOrPhone.toLowerCase().trim();
    const user = this.users.get(key);

    if (!user) {
      throw new Error('No user found with the provided email or phone number.');
    }

    if (password && user.password && user.password !== password) {
      throw new Error('Invalid credentials. Please verify your password.');
    }

    this.activeUserId = user.id;
    return user;
  }

  /**
   * Get authenticated user by ID, email, or currently active session
   */
  public async getAuthenticatedUser(userIdOrKey?: string): Promise<AuthUser> {
    if (!userIdOrKey) {
      return this.getActiveUser();
    }
    const found = this.users.get(userIdOrKey) || this.users.get(userIdOrKey.toLowerCase());
    if (found) {
      return found;
    }
    return this.getActiveUser();
  }

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
    return user;
  }

  public updateUserDailySpendLimit(userId: string, newLimitCents: number): AuthUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    user.dailySpendLimitCents = newLimitCents;
    return user;
  }
}

export const authProvider = new AuthProvider();
