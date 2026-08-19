# Rise/Fall Trading App

A self-hosted Rise/Fall trading app built on the Deriv WebSocket API. Supports CALL (Rise) and PUT (Fall) contract types with an interactive SmartCharts chart, real-time tick streaming, and open/closed position management.

## Prerequisites

- Node.js 22 or later for the current production toolchain

## Step 1: Register Your App ID

1. Log in to your Deriv account and go to the [API Token page](https://app.deriv.com/account/api-token) to create a token with the required scopes.
2. Navigate to [App Registration](https://developers.deriv.com/dashboard/) and register a new application.
3. Set the **Redirect URI** to the URL where you will host this app (for example, `http://localhost:3000` for local development).
4. Copy the **App ID** shown after registration — you will need it in the next step.

## Step 2: Configure environment variables

Copy `.env.example` to the environment file used by your deployment and fill in the values required by that environment.

Example:

```bash
cp .env.example .env.local
```

```env
NEXT_PUBLIC_DERIV_APP_ID=your_app_id_here
NEXT_PUBLIC_DERIV_REDIRECT_URI=https://your-registered-redirect-uri.com
NEXT_PUBLIC_DERIV_APP_NAME=your_app_name_here
NEXT_PUBLIC_DERIV_REFERRAL_LINK=your_referral_link_here
NEXT_PUBLIC_DERIV_OAUTH_SCOPES=trade,account_manage
NEXT_PUBLIC_DERIV_ENV=production
```

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_DERIV_APP_ID` | Your Deriv app ID from the App Registration dashboard |
| `NEXT_PUBLIC_DERIV_REDIRECT_URI` | OAuth redirect URI — must exactly match the URI registered in your Deriv app |
| `NEXT_PUBLIC_DERIV_APP_NAME` | App name shown in the header |
| `NEXT_PUBLIC_DERIV_REFERRAL_LINK` | Affiliate referral link shown to unauthenticated users (optional) |
| `NEXT_PUBLIC_DERIV_OAUTH_SCOPES` | Comma-separated OAuth scopes (for example, `trade,account_manage`) |
| `NEXT_PUBLIC_DERIV_ENV` | `production` for the live Deriv endpoint; `preview` for staging |

Do not commit `.env.local`, `.env.production`, or other secret-bearing environment files. `.env.example` is the repository-safe template.

## Step 3: Local Development

```bash
npm install
npm run dev
```

The app is available at `http://localhost:3000`.

## Step 4: Production Build and Server

```bash
npm run build
npm run start
```

The current application is a Next.js server application, not a static `/out` export. The production container uses `next start` on port `3000` and listens on `0.0.0.0`.

For containerized deployment, the repository `Dockerfile` builds the application, runs the production dependency/security checks, and starts the server with the production `start` script.
