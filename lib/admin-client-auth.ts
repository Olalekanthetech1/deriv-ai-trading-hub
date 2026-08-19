'use client';

const ADMIN_TOKEN_KEY = 'ai_trader_admin_token';

/**
 * Returns the admin token stored in sessionStorage if present.
 */
export function getStoredAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const sessionToken = window.sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (sessionToken) return sessionToken;
    const localToken = window.localStorage.getItem(ADMIN_TOKEN_KEY);
    if (localToken) {
      window.sessionStorage.setItem(ADMIN_TOKEN_KEY, localToken);
      return localToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists the admin token in client storage (sessionStorage + localStorage fallback)
 * to ensure API fetches pass authentication headers across submodules and iframes.
 */
export function setStoredAdminToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) {
      window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
      window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    } else {
      window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

/**
 * Wrapper around standard fetch that automatically attaches the x-admin-token header
 * if an admin token is available, and includes credentials for cookies.
 */
export async function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getStoredAdminToken();
  const headers = new Headers(init?.headers);

  if (token) {
    if (!headers.has('x-admin-token')) {
      headers.set('x-admin-token', token);
    }
    if (!headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`);
    }
  }

  const options: RequestInit = {
    ...init,
    headers,
    credentials: init?.credentials ?? 'same-origin',
  };

  return fetch(input, options);
}
