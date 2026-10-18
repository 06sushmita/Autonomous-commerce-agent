/**
 * Zepto Quick-Commerce MCP - OAuth 2.1 PKCE Token Generator
 *
 * Implements the official Zepto authentication flow:
 *  1. Dynamic client registration (RFC 7591) with https://auth.zepto.co.in/register
 *  2. Generates cryptographic PKCE code_verifier and code_challenge (S256)
 *  3. Opens official Zepto authorization page for Indian mobile number OTP login
 *  4. Captures OAuth redirect code on local callback listener (with manual paste fallback)
 *  5. Exchanges authorization code for live Bearer access token at https://auth.zepto.co.in/token
 *  6. Stores live token securely in .env.local as ZEPTO_AUTH_TOKEN
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { exec } from 'node:child_process';

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const ZEPTO_AUTH_SERVER = 'https://auth.zepto.co.in';
const ZEPTO_REGISTER_ENDPOINT = `${ZEPTO_AUTH_SERVER}/register`;
const ZEPTO_AUTHORIZE_ENDPOINT = `${ZEPTO_AUTH_SERVER}/authorize`;
const ZEPTO_TOKEN_ENDPOINT = `${ZEPTO_AUTH_SERVER}/token`;

const SUPPORTED_SCOPES = [
  'tools:read',
  'tools:write',
  'dev.ucp.shopping.cart:manage',
  'dev.ucp.shopping.catalog.search:read',
  'dev.ucp.shopping.catalog.lookup:read',
  'dev.ucp.common.location.search:read',
  'dev.ucp.common.location.lookup:read',
  'dev.ucp.shopping.order:manage',
  'dev.ucp.shopping.checkout:manage',
].join(' ');

async function getZeptoToken(): Promise<void> {
  console.log('======================================================');
  console.log('⚡ Zepto Quick-Commerce MCP - OAuth 2.1 PKCE Auth');
  console.log('======================================================\n');

  // Determine port: port 80 is official whitelisted URI http://localhost/callback
  // Fallback to port 3000 if 80 is occupied or restricted
  let port = 80;
  let redirectUri = `http://localhost/callback`;

  // 1. Register dynamic client via RFC 7591
  console.log('1. Registering dynamic client with Zepto Auth Server...');
  let clientId = '';

  try {
    const regRes = await fetch(ZEPTO_REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Autonomous Commerce Agent',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });

    if (regRes.status === 201 || regRes.ok) {
      const regData = (await regRes.json()) as any;
      clientId = regData.client_id;
      console.log(`✅ Registered client ID: ${clientId}`);
    } else {
      // Try fallback redirect_uri with port 3000
      port = 3000;
      redirectUri = `http://localhost:${port}/callback`;
      const fallbackRes = await fetch(ZEPTO_REGISTER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Autonomous Commerce Agent',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      const regData = (await fallbackRes.json()) as any;
      clientId = regData.client_id;
      console.log(`✅ Registered client ID (port ${port}): ${clientId}`);
    }
  } catch (err: any) {
    console.error(`Dynamic registration failed: ${err.message}`);
    process.exit(1);
  }

  // 2. Generate PKCE verifier & challenge (S256)
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL(ZEPTO_AUTHORIZE_ENDPOINT);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', SUPPORTED_SCOPES);
  authUrl.searchParams.set('state', state);

  const authUrlString = authUrl.toString();

  // Exchange code function
  const exchangeCodeForToken = async (code: string) => {
    console.log('\n3. Exchanging authorization code for live Bearer token...');
    try {
      const tokenRes = await fetch(ZEPTO_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokenData = (await tokenRes.json()) as any;
      if (tokenData.access_token) {
        console.log('\n======================================================');
        console.log('🎉 ZEPTO MCP BEARER TOKEN OBTAINED');
        console.log('======================================================');
        console.log(`Bearer ${tokenData.access_token}\n`);

        // Update .env.local
        const envPath = '.env.local';
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf-8');
          if (envContent.includes('ZEPTO_AUTH_TOKEN=')) {
            envContent = envContent.replace(
              /ZEPTO_AUTH_TOKEN="[^"]*"/,
              `ZEPTO_AUTH_TOKEN="Bearer ${tokenData.access_token}"`
            );
          } else {
            envContent += `\nZEPTO_AUTH_TOKEN="Bearer ${tokenData.access_token}"\n`;
          }
          fs.writeFileSync(envPath, envContent);
          console.log('✅ Automatically updated ZEPTO_AUTH_TOKEN in .env.local!');
        }
        process.exit(0);
      } else {
        console.error('Failed to obtain token from Zepto auth server:', tokenData);
        process.exit(1);
      }
    } catch (e: any) {
      console.error('Token exchange error:', e.message);
      process.exit(1);
    }
  };

  // 3. Start local HTTP listener to capture the OAuth redirect code
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '', `http://localhost:${port}`);
    if (parsedUrl.pathname === '/callback') {
      const code = parsedUrl.searchParams.get('code');
      const err = parsedUrl.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication Failed</h1><p>${err}</p>`);
        server.close();
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
              <h1 style="color: #6C5CE7;">⚡ Zepto MCP Authenticated!</h1>
              <p>You can close this tab and return to your terminal.</p>
            </body>
          </html>
        `);
        server.close();
        await exchangeCodeForToken(code);
      }
    }
  });

  server.on('error', (err: any) => {
    console.warn(`Local port listener note: ${err.message}. Manual paste mode active.`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Local callback server listening at ${redirectUri}`);
  });

  console.log('\n2. Opening browser for Zepto Mobile OTP Login...');
  console.log(`URL: ${authUrlString}\n`);

  const startCmd =
    process.platform === 'win32'
      ? `start "" "${authUrlString}"`
      : `open "${authUrlString}"`;
  exec(startCmd, (err) => {
    if (err) {
      console.log('Please open the URL above manually in your browser.');
    }
  });

  // Also support manual input if browser does not redirect to localhost
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    '\nIf automated redirect does not trigger, paste the redirect URL or authorization code here:\n> ',
    async (answer) => {
      rl.close();
      server.close();
      let code = answer.trim();
      if (code.includes('code=')) {
        try {
          const u = new URL(code);
          code = u.searchParams.get('code') || code;
        } catch {
          const match = code.match(/code=([^&]+)/);
          if (match) code = match[1];
        }
      }
      if (code) {
        await exchangeCodeForToken(code);
      }
    }
  );
}

getZeptoToken().catch((err) => {
  console.error('Fatal auth error:', err);
  process.exit(1);
});
