import crypto from 'crypto';

export interface DraftInput {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    htmlBody?: string;
    inReplyTo?: string;
}

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    if (/[^\x00-\x7F]/.test(text)) {
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// A newline in a header value would let the caller add arbitrary headers
function assertSingleLine(name: string, value: string): void {
    if (/[\r\n]/.test(value)) {
        throw new Error(`${name} may not contain line breaks`);
    }
}

function base64Lines(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

/**
 * Builds an RFC 2822 message. Bodies are base64-encoded so any UTF-8 content survives.
 * Plain text only, or multipart/alternative when an HTML body is given.
 */
export function createEmailMessage(input: DraftInput): string {
    const addresses = [...input.to, ...(input.cc || []), ...(input.bcc || [])];
    for (const email of addresses) {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
        assertSingleLine('Recipient', email);
    }
    assertSingleLine('Subject', input.subject);
    if (input.inReplyTo) assertSingleLine('inReplyTo', input.inReplyTo);

    const parts = [
        'From: me',
        `To: ${input.to.join(', ')}`,
        input.cc?.length ? `Cc: ${input.cc.join(', ')}` : '',
        input.bcc?.length ? `Bcc: ${input.bcc.join(', ')}` : '',
        `Subject: ${encodeEmailHeader(input.subject)}`,
        input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : '',
        input.inReplyTo ? `References: ${input.inReplyTo}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    if (input.htmlBody) {
        const boundary = `----=_NextPart_${crypto.randomBytes(12).toString('hex')}`;
        parts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
        parts.push(`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
        parts.push(base64Lines(input.body), '');
        parts.push(`--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
        parts.push(base64Lines(input.htmlBody), '');
        parts.push(`--${boundary}--`);
    } else {
        parts.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
        parts.push(base64Lines(input.body));
    }

    return parts.join('\r\n');
}
