import { execFile } from 'child_process';

/**
 * Minimal wrapper around the macOS `security` CLI.
 * Secrets are written through stdin (`security -i`), never as process arguments,
 * so they do not show up in `ps` output.
 */

const SERVICE = 'gmail-mcp';

function run(args: string[], input?: string): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
        const child = execFile('security', args, (error, stdout) => {
            if (error && typeof error.code !== 'number') {
                reject(error);
                return;
            }
            resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: stdout.toString() });
        });
        if (input !== undefined) {
            child.stdin?.end(input);
        }
    });
}

export async function readSecret(account: string): Promise<string | null> {
    const { code, stdout } = await run(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    if (code !== 0) return null;
    // Stored base64-encoded so the interactive `security -i` line needs no quoting
    return Buffer.from(stdout.trim(), 'base64').toString('utf8');
}

export async function writeSecret(account: string, secret: string): Promise<void> {
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    if (!/^[A-Za-z0-9._@-]+$/.test(account)) {
        throw new Error(`Invalid keychain account name: ${account}`);
    }
    const { code } = await run(['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${encoded}\n`);
    if (code !== 0) {
        throw new Error('Could not write the token to the macOS Keychain');
    }
}

export async function deleteSecret(account: string): Promise<void> {
    await run(['delete-generic-password', '-s', SERVICE, '-a', account]);
}
