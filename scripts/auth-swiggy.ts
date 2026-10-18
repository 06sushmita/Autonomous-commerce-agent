/**
 * Swiggy Builders Club - OAuth 2.1 PKCE Token Generator
 *
 * Automatically:
 *  1. Registers client with Swiggy MCP Auth server
 *  2. Starts a local callback listener on http://localhost:3456/callback
 *  3. Generates PKCE code challenge and opens Swiggy login URL in default browser
 *  4. Exchanges the OTP authorization code for a live 5-day Bearer token
 *  5. Prints the token and updates .env.local
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { exec } from 'node:child_process';

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getSwiggyToken(): Promise<void> {
  const PORT = 3456;
  const redirectUri = `http://localhost:${PORT}/callback`;

  console.log('1. Registering with Swiggy MCP Auth (https://mcp.swiggy.com/auth)...');
  const regRes = await fetch('https://mcp.swiggy.com/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'AutonomousCommerceAgent',
      redirect_uris: [redirectUri],
    }),
  });

  const regData = (await regRes.json()) as any;
  const clientId = regData.client_id || 'swiggy-mcp';

  // 2. Generate PKCE verifier & challenge
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=${encodeURIComponent(
    clientId
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=mcp:tools%20mcp:resources%20mcp:prompts&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  // 3. Start local HTTP listener to capture the OAuth redirect code
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication Failed</h1><p>${err}</p>`);
        server.close();
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Swiggy MCP Authenticated!</h1><p>You can close this tab and return to your terminal.</p>`);

        console.log('\n2. Exchanging code for Swiggy Bearer token...');
        try {
          const tokenRes = await fetch('https://mcp.swiggy.com/auth/token', {
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
            console.log('🎉 SWIGGY BUILDER TOKEN OBTAINED (Valid for ~5 days)');
            console.log('======================================================');
            console.log(`Bearer ${tokenData.access_token}\n`);

            // Update .env.local
            const envPath = '.env.local';
            if (fs.existsSync(envPath)) {
              let envContent = fs.readFileSync(envPath, 'utf-8');
              if (envContent.includes('SWIGGY_AUTH_TOKEN=')) {
                envContent = envContent.replace(
                  /SWIGGY_AUTH_TOKEN="[^"]*"/,
                  `SWIGGY_AUTH_TOKEN="Bearer ${tokenData.access_token}"`
                );
              } else {
                envContent += `\nSWIGGY_AUTH_TOKEN="Bearer ${tokenData.access_token}"\n`;
              }
              fs.writeFileSync(envPath, envContent);
              console.log('✅ Automatically updated SWIGGY_AUTH_TOKEN in .env.local!');
            }
          } else {
            console.error('Failed to obtain token:', tokenData);
          }
        } catch (e: any) {
          console.error('Token exchange error:', e.message);
        }

        server.close();
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`\nOpening browser for Swiggy OTP Login...`);
    console.log(`URL: ${authUrl}\n`);
    const startCmd = process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}"`;
    exec(startCmd);
  });
}

getSwiggyToken().catch(console.error);
