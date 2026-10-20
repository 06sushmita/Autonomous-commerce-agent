/**
 * Prava Payments Client (AP2 Biometric Passkey Gateway)
 *
 * Connects to Prava's documented sandbox/live gateway using PRAVA_API_KEY.
 * Converts human WebAuthn biometric passkey signatures into scoped, single-use payment token references.
 * Guarantees zero raw card data liability: never touches PANs, CVVs, or cardholder credentials.
 * Fails closed in production: non-success status, invalid format, or missing signature verification throws errors.
 */

export class PravaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PravaConfigurationError';
  }
}

export class PravaApiError extends Error {
  public statusCode?: number;
  public responseBody?: string;

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = 'PravaApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class PravaVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PravaVerificationError';
  }
}

export interface PasskeyChallengeRequest {
  mandateId: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  userId: string;
}

export interface PasskeyChallengeResponse {
  challengeId: string;
  mandateId: string;
  rpId: string;
  challenge: string; // Base64URL encoded challenge
  timeoutMs: number;
  allowCredentials?: Array<{ id: string; type: string }>;
}

export interface PasskeyVerificationRequest {
  mandateId: string;
  challengeId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string;
}

export interface PravaTokenResponse {
  success: boolean;
  pravaTokenRef: string; // Single-use scoped payment token reference
  mandateId: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
  error?: string;
}

export interface PravaAuthorizationProvider {
  isConfigured(): boolean;
  createPasskeyChallenge(request: PasskeyChallengeRequest): Promise<PasskeyChallengeResponse>;
  verifyPasskeyAndIssueToken(
    request: PasskeyVerificationRequest,
    merchantId: string,
    amountCents: number,
    currency?: string
  ): Promise<PravaTokenResponse>;
}

export class PravaPaymentsClient implements PravaAuthorizationProvider {
  private secretKey?: string;
  private publishableKey?: string;
  private apiUrl: string;

  constructor() {
    this.secretKey = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY;
    this.publishableKey =
      process.env.NEXT_PUBLIC_PRAVA_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_PRAVA_CLIENT_KEY ||
      process.env.PRAVA_CLIENT_KEY;

    if (process.env.PRAVA_API_URL) {
      this.apiUrl = process.env.PRAVA_API_URL;
    } else if (this.secretKey?.startsWith('sk_live_')) {
      this.apiUrl = 'https://api.prava.space';
    } else {
      this.apiUrl = 'https://sandbox.api.prava.space';
    }
  }

  public isSandbox(): boolean {
    return this.apiUrl.includes('sandbox');
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey && !this.secretKey.includes('placeholder'));
  }

  public getPublishableKey(): string | undefined {
    return this.publishableKey;
  }

  /**
   * Request a FIDO2 WebAuthn biometric passkey challenge from Prava
   */
  public async createPasskeyChallenge(
    request: PasskeyChallengeRequest
  ): Promise<PasskeyChallengeResponse> {
    if (!this.isConfigured()) {
      throw new PravaConfigurationError(
        'Prava payments client is unconfigured: PRAVA_SECRET_KEY or PRAVA_API_KEY is missing.'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/passkeys/challenge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify({
          mandate_id: request.mandateId,
          merchant_id: request.merchantId,
          amount: request.amountCents,
          currency: request.currency,
          user_id: request.userId,
        }),
      });
    } catch (netErr: any) {
      throw new PravaApiError(
        `Prava passkey challenge network request failed: ${netErr.message || 'connection error'}`
      );
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new PravaApiError(
        `Prava passkey challenge creation failed with status ${response.status}: ${errBody}`,
        response.status,
        errBody
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch (parseErr: any) {
      throw new PravaApiError(
        `Malformed JSON response from Prava passkey challenge API: ${parseErr.message}`,
        response.status
      );
    }

    if (!json?.challenge_id || !json?.challenge) {
      throw new PravaApiError(
        'Malformed Prava passkey challenge response: missing challenge_id or challenge',
        response.status
      );
    }

    return {
      challengeId: json.challenge_id,
      mandateId: request.mandateId,
      rpId: json.rp_id || 'localhost',
      challenge: json.challenge,
      timeoutMs: json.timeout_ms || 60000,
      allowCredentials: json.allow_credentials,
    };
  }

  /**
   * Verify the biometric passkey signature and issue a scoped, single-use payment token reference
   */
  public async verifyPasskeyAndIssueToken(
    request: PasskeyVerificationRequest,
    merchantId: string,
    amountCents: number,
    currency = 'INR'
  ): Promise<PravaTokenResponse> {
    if (!request.signature || typeof request.signature !== 'string' || request.signature.trim() === '') {
      throw new PravaVerificationError('Biometric passkey signature is required for payment authorization.');
    }

    if (!this.isConfigured()) {
      throw new PravaConfigurationError(
        'Prava payments client is unconfigured: PRAVA_SECRET_KEY or PRAVA_API_KEY is missing.'
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/passkeys/verify-and-tokenize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.secretKey}`,
        },
        body: JSON.stringify({
          mandate_id: request.mandateId,
          challenge_id: request.challengeId,
          client_data_json: request.clientDataJSON,
          authenticator_data: request.authenticatorData,
          signature: request.signature,
        }),
      });
    } catch (netErr: any) {
      throw new PravaApiError(
        `Prava passkey verification network request failed: ${netErr.message || 'connection error'}`
      );
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new PravaApiError(
        `Prava passkey verification failed with status ${response.status}: ${errBody}`,
        response.status,
        errBody
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch (parseErr: any) {
      throw new PravaApiError(
        `Malformed JSON response from Prava verification API: ${parseErr.message}`,
        response.status
      );
    }

    if (!json?.token_ref) {
      throw new PravaApiError(
        'Malformed Prava token response: token_ref missing from provider response',
        response.status
      );
    }

    return {
      success: true,
      pravaTokenRef: json.token_ref,
      mandateId: request.mandateId,
      merchantId,
      amountCents,
      currency,
      expiresAt: json.expires_at || new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }
}

/**
 * Mock Prava Provider for testing failure modes and isolated verification suites
 */
export class MockPravaPaymentsClient implements PravaAuthorizationProvider {
  private shouldFailVerification = false;
  private simulateError: Error | null = null;

  public setFailVerification(fail: boolean): void {
    this.shouldFailVerification = fail;
  }

  public setSimulateError(err: Error | null): void {
    this.simulateError = err;
  }

  public isConfigured(): boolean {
    return true;
  }

  private assertNotProduction(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new PravaConfigurationError(
        'MockPravaPaymentsClient cannot be used when NODE_ENV is production.'
      );
    }
  }

  public async createPasskeyChallenge(request: PasskeyChallengeRequest): Promise<PasskeyChallengeResponse> {
    this.assertNotProduction();
    if (this.simulateError) {
      throw this.simulateError;
    }

    return {
      challengeId: `test_chal_${Date.now()}`,
      mandateId: request.mandateId,
      rpId: 'localhost',
      challenge: Buffer.from(`test_challenge_${request.mandateId}`).toString('base64url'),
      timeoutMs: 60000,
    };
  }

  public async verifyPasskeyAndIssueToken(
    request: PasskeyVerificationRequest,
    merchantId: string,
    amountCents: number,
    currency = 'INR'
  ): Promise<PravaTokenResponse> {
    this.assertNotProduction();
    if (this.simulateError) {
      throw this.simulateError;
    }

    if (this.shouldFailVerification || !request.signature || request.signature === 'invalid_signature') {
      throw new PravaVerificationError('Passkey verification failed: Invalid cryptographic signature.');
    }

    return {
      success: true,
      pravaTokenRef: `prv_tok_${merchantId}_${Date.now()}`,
      mandateId: request.mandateId,
      merchantId,
      amountCents,
      currency,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }
}

// Active provider instance
const realPravaClient = new PravaPaymentsClient();

function resolveDefaultPravaClient(): PravaAuthorizationProvider {
  if (process.env.NODE_ENV === 'production' || process.env.PRAVA_LIVE === 'true') {
    return realPravaClient;
  }
  return new MockPravaPaymentsClient();
}

let activePravaClient: PravaAuthorizationProvider = resolveDefaultPravaClient();

export function getPravaClient(): PravaAuthorizationProvider {
  return activePravaClient;
}

export function setPravaClient(client: PravaAuthorizationProvider): void {
  if (process.env.NODE_ENV === 'production' && client instanceof MockPravaPaymentsClient) {
    throw new PravaConfigurationError('MockPravaPaymentsClient is prohibited in production.');
  }
  activePravaClient = client;
}

export function resetPravaClient(): void {
  activePravaClient = resolveDefaultPravaClient();
}

export const pravaClient = activePravaClient;
