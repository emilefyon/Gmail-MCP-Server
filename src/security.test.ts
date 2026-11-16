import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeFilename, resolveInside, writeNew } from './attachments.js';
import { createEmailMessage } from './mime.js';

function tempRoot(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-')));
}

test('safeFilename strips directories and hidden-file prefixes', () => {
    assert.equal(safeFilename('../../.zshrc', 'fallback'), 'zshrc');
    assert.equal(safeFilename('..\\..\\evil.bat', 'fallback'), 'evil.bat');
    assert.equal(safeFilename('/etc/passwd', 'fallback'), 'passwd');
    assert.equal(safeFilename('..', 'fallback'), 'fallback');
    assert.equal(safeFilename('', 'fallback'), 'fallback');
    assert.equal(safeFilename('RFP pack v2.pdf', 'fallback'), 'RFP pack v2.pdf');
    assert.equal(safeFilename('a\nb.pdf', 'fallback'), 'a_b.pdf');
});

test('resolveInside refuses paths outside the root', () => {
    const root = tempRoot();
    assert.throws(() => resolveInside(root, '../outside'));
    assert.throws(() => resolveInside(root, '/tmp'));
    assert.throws(() => resolveInside(root, 'rfp/../../outside'));
    assert.throws(() => resolveInside(root, '.git/hooks'));
    assert.throws(() => resolveInside(root, 'rfp/.claude'));
    assert.equal(resolveInside(root, 'rfp/acme'), path.join(root, 'rfp', 'acme'));
    assert.equal(resolveInside(root, '.'), root);
});

test('resolveInside refuses to follow a symlink out of the root', () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, 'link'));
    assert.throws(() => resolveInside(root, 'link/sub'));
    assert.equal(fs.existsSync(path.join(outside, 'sub')), false);
});

test('writeNew never overwrites', () => {
    const root = tempRoot();
    const first = writeNew(root, 'file.pdf', Buffer.from('a'));
    const second = writeNew(root, 'file.pdf', Buffer.from('b'));
    assert.equal(path.basename(first), 'file.pdf');
    assert.equal(path.basename(second), 'file (1).pdf');
    assert.equal(fs.readFileSync(first, 'utf8'), 'a');
});

test('createEmailMessage refuses header injection', () => {
    const base = { to: ['a@example.com'], subject: 'Hi', body: 'Hello' };
    assert.throws(() => createEmailMessage({ ...base, subject: 'Hi\r\nBcc: x@evil.com' }));
    assert.throws(() => createEmailMessage({ ...base, inReplyTo: '<id>\nBcc: x@evil.com' }));
    assert.throws(() => createEmailMessage({ ...base, to: ['not-an-email'] }));
});

test('createEmailMessage builds multipart with UTF-8 bodies', () => {
    const message = createEmailMessage({
        to: ['a@example.com'], subject: 'Offre été', body: 'Bonjour é', htmlBody: '<p>Bonjour é</p>',
    });
    assert.match(message, /Subject: =\?UTF-8\?B\?/);
    assert.match(message, /multipart\/alternative/);
    assert.ok(message.includes(Buffer.from('Bonjour é').toString('base64')));
});
