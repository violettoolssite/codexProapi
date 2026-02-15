# Codex Pro API

Exposes **Codex** (gpt-5.3-codex) as an **OpenAI-compatible API** so you can use it in Cline, Cursor, or any client that supports OpenAI-style endpoints.

**中文说明请见 [README.zh-CN.md](README.zh-CN.md)。**

---

## Screenshots

**Accounts — add Codex accounts via Login with Codex (OAuth):**

![Accounts](accounts.png)

**Models — view available models and quota:**

![Models](models.png)

---

## How to get started

### Option 1: Desktop app (recommended)

If you prefer not to use the command line:

1. Open [GitHub Releases](https://github.com/violettoolssite/codexProapi/releases).
2. Pick the latest release (e.g. `v1.0.7`) and download the **Windows installer** from **Assets**: `Codex Pro API Setup x.x.x.exe` (you can choose install path and desktop/Start menu shortcuts).  
   **Note:** The desktop app is **Windows only** for now; on macOS or Linux, use the command-line option below.
3. Install and run; the config page opens **inside the app window** (no browser). Closing the app stops the local service. Accounts and data are stored in your local user data directory, separate from the install folder.

### Option 2: Command line

You need **Node.js** 18 or later. In a terminal:

```bash
npm install -g codex-proapi
codex-proapi
```

Or run `npm start` from the project directory after `npm install`. Then open **http://localhost:1455/** in your browser. Default port is **1455**; with global install, account and usage data are stored in `~/.codex-proapi/`.

---

## Use in your client (Cline, Cursor, etc.)

| Setting     | Value |
|------------|--------|
| **Base URL** | `http://localhost:1455/v1` (must include `/v1`; or your host/port + `/v1`) |
| **Model**    | `gpt-5.3-codex` (or `gpt-5.2-codex`, `gpt-5-codex`, `gpt-5`, `gpt-4`) |
| **API Key**  | Any value (not validated; auth is from your Codex accounts) |

**Steps:**

1. Add accounts at **http://localhost:1455/** on the Accounts page via **Login with Codex** (or **Add account** → **Paste JSON**).
2. In your client, set the **Base URL** (must include `/v1`) and **model** as above; API Key can be anything.
3. Send requests as usual; the proxy will use your configured accounts.

---

## "Region not supported" or access_denied when logging in

If you see **region restriction**, **access_denied**, or similar after clicking "Login with Codex", your region or network may not be supported. You can:

1. **Use a VPN** and try "Login with Codex" again.
2. **Paste auth.json instead**: On a device where Codex login works (e.g. another computer or a browser with VPN), open `~/.codex/auth.json` (Windows: `%USERPROFILE%\\.codex\\auth.json`), copy its contents, then go to Accounts → Add account → Paste JSON and submit.

The same instructions are shown on the page when this error appears.

### VPN on but still "unsupported region"?

- **Make sure the login page uses the VPN too**: After clicking "Login with Codex" you are redirected to OpenAI’s login; that page must also go through your VPN. If only some apps use the proxy and the browser does not, the login page still sees your real IP. Use system-wide or browser proxy and ensure it’s on before clicking login.
- **Try another VPN server or provider**: Some servers may still be detected as unsupported, or leak IP/DNS. Try a different node (e.g. US) or another VPN.
- **Prefer pasting auth.json**: On any environment where Codex login works (e.g. another machine with VPN, or a browser that already logged in with VPN), open `~/.codex/auth.json`, copy its contents, then in Codex Pro API go to Accounts → Add account → Paste JSON. No OAuth on this machine needed.

---

## Getting 403 when using a shared / hosted link

If you open the service via a link provided by someone else (e.g. `https://example.com`) and get **403** or "Token exchange failed" at the last step of "Login with Codex", the issue is with the server’s OAuth callback configuration. Contact **whoever provides that link** to fix the domain and callback settings; you don’t need to change anything on your side.

---

## Features

- **Multi-account round-robin** — Requests use your added accounts in turn; if one fails, the next is used automatically.
- **Config page** — Dashboard, Models (quota), Accounts (OAuth or paste JSON), Logs, Settings (language, base URL). Data refreshes every 5 seconds.
- **Responsive UI** — Works on desktop and mobile; sidebar collapses to a menu on small screens.
- **Bilingual** — Interface and logs in English and 简体中文.

Multi-turn conversation is supported; send `messages` in the usual OpenAI format and the proxy will handle the rest.

---

## Using [free.violetteam.cloud](https://free.violetteam.cloud/) for verification

If you use [free.violetteam.cloud](https://free.violetteam.cloud/) to receive verification emails (e.g. when registering a ChatGPT/Codex account), delivery can be a bit slow—please wait. If you still don’t receive the code after a long time, click **Resend verification code**.
