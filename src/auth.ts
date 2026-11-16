import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { readSecret, writeSecret, deleteSecret } from './keychain.js';

/**
 * Two ways to get a Gmail access token:
 *  - "keychain" (default): our own browser login (PKCE + state, loopback on 127.0.0.1),
 *    refresh token kept in the macOS Keychain and expired after GMAIL_MCP_SESSION_DAYS.
 *  - "gws": reuse the login of Google's Workspace CLI (`gws auth login`), held in memory only.
 */

export const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
];

// Scopes that open the whole mailbox for writing or deletion: refused, whatever the provider
const FORBIDDEN_SCOPES = [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.insert',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/gmail.settings.sharing',
];

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const KEYCHAIN_ACCOUNT = process.env.GMAIL_MCP_ACCOUNT || 'default';
const SESSION_DAYS = Number(process.env.GMAIL_MCP_SESSION_DAYS || 7);
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type AuthProvider = 'keychain' | 'gws';

export function authProvider(): AuthProvider {
    const value = process.env.GMAIL_MCP_AUTH || 'keychain';
    if (value !== 'keychain' && value !== 'gws') {
        throw new Error(`GMAIL_MCP_AUTH must be "keychain" or "gws", got "${value}"`);
    }
    return value;
}

interface StoredSession {
    refresh_token: string;
    created_at: number;
}

function loadClientKeys(): { client_id: string; client_secret?: string } {
    if (!fs.existsSync(OAUTH_PATH)) {
        throw new Error(`OAuth client file not found at ${OAUTH_PATH}. Get it from 1Password (see README).`);
    }
    const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
    const keys = keysContent.installed;
    if (!keys) {
        throw new Error('OAuth client file must be a "Desktop app" client (an "installed" key).');
    }
    return keys;
}

function sessionExpired(session: StoredSession): boolean {
    return Date.now() - session.created_at > SESSION_DAYS * 24 * 60 * 60 * 1000;
}

async function assertScopes(client: OAuth2Client): Promise<void> {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('No access token received from Google');
    const info = await client.getTokenInfo(token);
    const forbidden = info.scopes.filter(s => FORBIDDEN_SCOPES.includes(s));
    if (forbidden.length > 0) {
        throw new Error(
            `This login grants more than read + compose (${forbidden.join(', ')}). ` +
            'Log in again with only gmail.readonly and gmail.compose.'
        );
    }
}

/**
 * Interactive browser login. Run from a terminal with `gmail-mcp auth`.
 */
export async function login(): Promise<void> {
    if (authProvider() === 'gws') {
        throw new Error('With GMAIL_MCP_AUTH=gws, log in with: gws auth login -s gmail');
    }
    const keys = loadClientKeys();
    const server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

    const client = new OAuth2Client(keys.client_id, keys.client_secret, redirectUri);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString('hex');

    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
    });

    console.error('Opening the browser for Google login. If it does not open, visit:\n' + authUrl);
    execFile('open', [authUrl]);

    const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            server.close();
            reject(new Error('Login timed out after 5 minutes'));
        }, LOGIN_TIMEOUT_MS);

        server.on('request', (req, res) => {
            const url = new URL(req.url || '/', redirectUri);
            if (url.pathname !== '/oauth2callback') {
                res.writeHead(404);
                res.end();
                return;
            }
            const returnedState = url.searchParams.get('state') || '';
            const returnedCode = url.searchParams.get('code');
            const stateOk = returnedState.length === state.length &&
                crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));

            if (!stateOk || !returnedCode) {
                res.writeHead(400);
                res.end('Login failed: invalid callback. You can close this window.');
                return;
            }
            res.writeHead(200);
            res.end('Login successful. You can close this window.');
            clearTimeout(timer);
            server.close();
            resolve(returnedCode);
        });
    });

    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token');
    }
    client.setCredentials(tokens);
    await assertScopes(client);

    const session: StoredSession = { refresh_token: tokens.refresh_token, created_at: Date.now() };
    await writeSecret(KEYCHAIN_ACCOUNT, JSON.stringify(session));
    if (!(await readSecret(KEYCHAIN_ACCOUNT))) {
        throw new Error('Token was not saved to the macOS Keychain');
    }
    console.error(`Logged in. Session valid for ${SESSION_DAYS} days, stored in the macOS Keychain.`);
}

/**
 * Revokes the token at Google and removes it from the Keychain.
 */
export async function logout(): Promise<void> {
    const raw = await readSecret(KEYCHAIN_ACCOUNT);
    if (raw) {
        const session = JSON.parse(raw) as StoredSession;
        const keys = loadClientKeys();
        const client = new OAuth2Client(keys.client_id, keys.client_secret);
        await client.revokeToken(session.refresh_token).catch(() => undefined);
    }
    await deleteSecret(KEYCHAIN_ACCOUNT);
    console.error('Logged out: token revoked and removed from the Keychain.');
}

async function keychainClient(): Promise<OAuth2Client> {
    const raw = await readSecret(KEYCHAIN_ACCOUNT);
    if (!raw) {
        throw new Error('Not logged in. Run `gmail-mcp auth` in a terminal.');
    }
    const session = JSON.parse(raw) as StoredSession;
    if (sessionExpired(session)) {
        await logout();
        throw new Error(`Session older than ${SESSION_DAYS} days. Run \`gmail-mcp auth\` in a terminal.`);
    }
    const keys = loadClientKeys();
    const client = new OAuth2Client(keys.client_id, keys.client_secret);
    client.setCredentials({ refresh_token: session.refresh_token });
    client.on('tokens', tokens => {
        // Google rarely rotates the refresh token; keep the original session start
        if (tokens.refresh_token) {
            writeSecret(KEYCHAIN_ACCOUNT, JSON.stringify({ ...session, refresh_token: tokens.refresh_token }))
                .catch(error => console.error('Could not update the Keychain:', error.message));
        }
    });
    return client;
}

async function gwsClient(): Promise<OAuth2Client> {
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile('gws', ['auth', 'export', '--unmasked'], (error, out) => {
            if (error) {
                reject(new Error('Could not read the gws login. Install gws and run: gws auth login -s gmail'));
                return;
            }
            resolve(out.toString());
        });
    });
    const creds = JSON.parse(stdout);
    if (!creds.client_id || !creds.refresh_token) {
        throw new Error('Unexpected output from `gws auth export`: no client_id or refresh_token');
    }
    // Held in memory only, never written to disk by this server
    const client = new OAuth2Client(creds.client_id, creds.client_secret);
    client.setCredentials({ refresh_token: creds.refresh_token });
    return client;
}

/**
 * Returns an authorized client, after checking it carries no full-mailbox scope.
 */
export async function getClient(): Promise<OAuth2Client> {
    const client = authProvider() === 'gws' ? await gwsClient() : await keychainClient();
    await assertScopes(client);
    return client;
}

export async function status(): Promise<string> {
    if (authProvider() === 'gws') {
        await getClient();
        return 'Provider: gws. Login OK, scopes OK.';
    }
    const raw = await readSecret(KEYCHAIN_ACCOUNT);
    if (!raw) return 'Provider: keychain. Not logged in.';
    const session = JSON.parse(raw) as StoredSession;
    const expires = new Date(session.created_at + SESSION_DAYS * 24 * 60 * 60 * 1000);
    return `Provider: keychain. Session expires ${expires.toISOString()}${sessionExpired(session) ? ' (expired)' : ''}.`;
}
