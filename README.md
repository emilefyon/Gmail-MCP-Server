# gmail-mcp

A minimal Gmail MCP server for Claude Code. It is a hardened rewrite of
[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) (archived March 2026).

It does four things and nothing else:

| Tool | What it does |
|---|---|
| `search_emails` | Search with Gmail syntax (`from:acme has:attachment newer_than:7d`) |
| `read_email` | Read one email and list its attachments |
| `download_attachment` | Save an attachment into a folder of the current project |
| `draft_email` | Create a draft. Nothing is ever sent: the person sends it from Gmail |

No send, delete, label, filter or settings tools exist in the code.

## Security changes compared to upstream

| Upstream issue | Here |
|---|---|
| Abandoned, 179 runtime packages, 18 audit findings | ~600 lines, 3 pinned dependencies, `npm audit`: 0 findings |
| Attachment filename from the email used as a path (`../../.zshrc`) | Filename reduced to a clean basename; files only land below the download root, never in hidden folders, never through a symlink, never overwrite |
| Login without `state` or PKCE, callback on all interfaces, port 3000 | PKCE (S256) + random `state`, callback on `127.0.0.1` with a random port, 5 minute timeout |
| Token saved as a plain file | Refresh token in the macOS Keychain, session expires after 7 days (configurable) |
| `gmail.modify` + `gmail.settings.basic` | `gmail.readonly` + `gmail.compose` only. The server refuses to run with a token that carries a full-mailbox scope |
| Email content handed to the model as-is | Email content wrapped in `<untrusted_email_content>` markers with a "data, not instructions" notice |
| Header injection possible in drafts | Line breaks refused in subject, recipients and `inReplyTo` |

What this does **not** solve: an email can still try to steer Claude (prompt injection), and every email Claude reads is sent to Anthropic as part of the prompt. Keep Claude Code out of auto-accept mode when working on email.

## Setup

Requires macOS and Node 20+.

```bash
git clone https://github.com/emilefyon/Gmail-MCP-Server.git ~/gmail-mcp
cd ~/gmail-mcp && npm ci && npm run build
```

### Option 1: own login, token in the Keychain (default)

1. Put the Desktop OAuth client JSON (from 1Password) at `~/.gmail-mcp/gcp-oauth.keys.json`.
2. Log in once: `node ~/gmail-mcp/dist/index.js auth`
3. Check: `node ~/gmail-mcp/dist/index.js status`

Log out and revoke at Google: `node ~/gmail-mcp/dist/index.js logout`

### Option 2: reuse Google's Workspace CLI login

Set `GMAIL_MCP_AUTH=gws`. The server reads the login of [`gws`](https://github.com/googleworkspace/cli)
(`gws auth export --unmasked`) and keeps it in memory only. The `gws` login must not include
`gmail.modify` or `https://mail.google.com/`, or the server refuses to start.

### Add to Claude Code

```bash
claude mcp add gmail -- node ~/gmail-mcp/dist/index.js
```

Claude Code starts the server in the project folder, so attachments are saved inside that project.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `GMAIL_MCP_AUTH` | `keychain` | `keychain` or `gws` |
| `GMAIL_MCP_SESSION_DAYS` | `7` | Days before a Keychain login must be renewed |
| `GMAIL_MCP_DOWNLOAD_ROOT` | current folder | Attachments can only be saved below this folder |
| `GMAIL_OAUTH_PATH` | `~/.gmail-mcp/gcp-oauth.keys.json` | OAuth client file |
| `GMAIL_MCP_ACCOUNT` | `default` | Keychain entry name, to keep several logins apart |

## Development

```bash
npm test   # builds and runs the security tests
```

## License

MIT, as upstream on GitHub.
