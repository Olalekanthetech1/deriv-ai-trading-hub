import WebSocket from 'ws';
import { getApiBaseUrl } from '@deriv/core';

export interface DerivAccountSnapshot {
  account_id: string;
  account_type: string;
  currency: string;
  balance: string;
  group?: string;
  status?: string;
}

export interface DerivAuthorizeResponse {
  authorize: {
    account_list: Array<{
      account_category?: string;
      account_type?: string;
      created_at?: number;
      currency?: string;
      is_disabled?: number;
      is_virtual?: number;
      landing_company_name?: string;
      loginid: string;
    }>;
    balance: number;
    currency: string;
    email?: string;
    fullname?: string;
    is_virtual?: number;
    landing_company_name?: string;
    loginid: string;
    user_id?: number;
  };
}

export interface DerivProposalResponse {
  proposal?: { id: string; ask_price: number; payout: number; longcode: string; display_value: string; spot: number; spot_time: number };
  error?: { code: string; message: string };
}

export interface DerivBuyResponse {
  buy?: { balance_after: number; buy_price: number; contract_id: number; longcode: string; payout: number; purchase_time: number; shortcode: string; start_time: number; transaction_id: number };
  error?: { code: string; message: string };
}

export interface DerivContractStatus {
  is_settled: boolean;
  is_won: boolean;
  profit: number;
  payout: number;
  status: string;
  exit_tick?: number;
  exit_tick_time?: number;
}

export class DerivAuthenticationError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'DerivAuthenticationError';
    this.status = status;
    this.code = code;
  }
}

type PendingRequest = { resolve: (val: any) => void; reject: (err: any) => void };
type DerivBalancePayload = { balance?: { balance?: number | string; currency?: string; loginid?: string } };

function getDerivAppId(): string {
  const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID?.trim();
  if (!appId) throw new DerivAuthenticationError('DERIV_APP_ID_MISSING', 'NEXT_PUBLIC_DERIV_APP_ID is not configured.');
  return appId;
}

function normalizeAccounts(payload: unknown): DerivAccountSnapshot[] {
  if (!payload || typeof payload !== 'object') throw new Error('DERIV_ACCOUNTS_RESPONSE_INVALID');
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('DERIV_ACCOUNTS_RESPONSE_INVALID');
  return data.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`DERIV_ACCOUNTS_RESPONSE_INVALID_AT_${index}`);
    const account = raw as Record<string, unknown>;
    const accountId = typeof account.account_id === 'string' ? account.account_id.trim() : '';
    const accountType = typeof account.account_type === 'string' ? account.account_type.trim() : '';
    const currency = typeof account.currency === 'string' ? account.currency.trim() : '';
    const rawBalance = account.balance;
    const balance = typeof rawBalance === 'number' || typeof rawBalance === 'string' ? String(rawBalance) : '';
    if (!accountId || !accountType || !currency || balance === '') throw new Error(`DERIV_ACCOUNTS_RESPONSE_INVALID_AT_${index}`);
    return { account_id: accountId, account_type: accountType, currency, balance, group: typeof account.group === 'string' ? account.group : undefined, status: typeof account.status === 'string' ? account.status : undefined };
  });
}

async function fetchDerivAccounts(token: string, appId: string): Promise<DerivAccountSnapshot[]> {
  const response = await fetch(`${getApiBaseUrl()}/accounts`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': appId, Accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new DerivAuthenticationError('DERIV_AUTHENTICATION_FAILED', 'Deriv rejected the access token while fetching trading accounts.', response.status);
    throw new Error(`DERIV_ACCOUNTS_REQUEST_FAILED_${response.status}`);
  }
  const accounts = normalizeAccounts(payload);
  if (accounts.length === 0) throw new Error('DERIV_NO_TRADING_ACCOUNTS');
  return accounts;
}

async function fetchDerivWebSocketOtp(token: string, appId: string, accountId: string): Promise<string> {
  const response = await fetch(`${getApiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/otp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': appId, Accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new DerivAuthenticationError('DERIV_AUTHENTICATION_FAILED', 'Deriv rejected the access token while creating the authenticated WebSocket session.', response.status);
    if (response.status === 400 || response.status === 404) throw new DerivAuthenticationError('DERIV_ACCOUNT_SESSION_UNAVAILABLE', `Deriv could not create an authenticated session for account ${accountId}.`, response.status);
    throw new Error(`DERIV_WS_OTP_REQUEST_FAILED_${response.status}`);
  }
  const url = payload && typeof payload === 'object' && 'data' in payload && payload.data && typeof payload.data === 'object' && typeof (payload.data as { url?: unknown }).url === 'string' ? String((payload.data as { url: string }).url) : '';
  if (!url.startsWith('wss://')) throw new Error('DERIV_WS_OTP_RESPONSE_INVALID');
  return url;
}

function buildAuthorizeSnapshot(accounts: DerivAccountSnapshot[], selected: DerivAccountSnapshot, balancePayload: DerivBalancePayload): DerivAuthorizeResponse['authorize'] {
  const balanceBlock = balancePayload.balance;
  const reportedLoginId = typeof balanceBlock?.loginid === 'string' ? balanceBlock.loginid : '';
  const reportedCurrency = typeof balanceBlock?.currency === 'string' ? balanceBlock.currency : '';
  const reportedBalance = typeof balanceBlock?.balance === 'number' || typeof balanceBlock?.balance === 'string' ? Number(balanceBlock.balance) : Number.NaN;
  const loginid = reportedLoginId || selected.account_id;
  const currency = reportedCurrency || selected.currency;
  const balance = Number.isFinite(reportedBalance) ? reportedBalance : Number(selected.balance);
  if (!loginid || !currency || !Number.isFinite(balance)) throw new Error('DERIV_BALANCE_RESPONSE_INVALID');
  if (reportedLoginId && reportedLoginId !== selected.account_id) throw new Error('DERIV_ACCOUNT_SESSION_MISMATCH');
  return { account_list: accounts.map((account) => ({ loginid: account.account_id, account_type: account.account_type, currency: account.currency, is_virtual: account.account_type.toLowerCase() === 'demo' ? 1 : 0 })), balance, currency, loginid, is_virtual: selected.account_type.toLowerCase() === 'demo' ? 1 : 0 };
}

export class DerivAuthenticatedClient {
  private ws: WebSocket | null = null;
  private token: string;
  private appId: string;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private connectPromise: Promise<DerivAuthorizeResponse['authorize']> | null = null;
  private targetAccountId: string | null = null;
  public authData: DerivAuthorizeResponse['authorize'] | null = null;

  constructor(token: string) {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new DerivAuthenticationError('DERIV_TOKEN_MISSING', 'A Deriv access token is required for authenticated operations.');
    this.token = normalizedToken;
    this.appId = getDerivAppId();
  }

  async getAccountsList() {
    const accounts = await fetchDerivAccounts(this.token, this.appId);
    return accounts.map((account) => ({ account_id: account.account_id, account_type: account.account_type, currency: account.currency, balance: account.balance, is_virtual: account.account_type.toLowerCase() === 'demo' ? 1 : 0 }));
  }

  async connect(targetAccountId?: string): Promise<DerivAuthorizeResponse['authorize']> {
    const requestedAccountId = targetAccountId?.trim() || this.targetAccountId || null;
    if (this.ws?.readyState === WebSocket.OPEN && this.authData && (!requestedAccountId || this.authData.loginid === requestedAccountId)) return this.authData;
    if (this.connectPromise) return this.connectPromise;
    this.targetAccountId = requestedAccountId;
    this.connectPromise = this.connectInternal(requestedAccountId).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async connectInternal(requestedAccountId: string | null): Promise<DerivAuthorizeResponse['authorize']> {
    const accounts = await fetchDerivAccounts(this.token, this.appId);
    const selected = requestedAccountId ? accounts.find((account) => account.account_id === requestedAccountId) : accounts[0];
    if (!selected) throw new DerivAuthenticationError('DERIV_ACCOUNT_NOT_FOUND', `The requested Deriv account ${requestedAccountId} is not available to this token.`);
    this.closeSocketOnly();
    const wsUrl = await fetchDerivWebSocketOtp(this.token, this.appId, selected.account_id);

    return new Promise((resolve, reject) => {
      let settled = false;
      const connectTimeout = setTimeout(() => { if (!settled) { settled = true; this.closeSocketOnly(); reject(new Error('DERIV_AUTHENTICATED_WS_TIMEOUT')); } }, 10000);
      try {
        const socket = new WebSocket(wsUrl);
        this.ws = socket;
        socket.on('open', async () => {
          if (settled) return;
          clearTimeout(connectTimeout);
          try {
            const balanceRes = await this.sendRaw<DerivBalancePayload>({ balance: 1 });
            const authSnapshot = buildAuthorizeSnapshot(accounts, selected, balanceRes);
            this.authData = authSnapshot;
            this.targetAccountId = authSnapshot.loginid;
            settled = true;
            resolve(authSnapshot);
          } catch (error) {
            if (!settled) { settled = true; this.closeSocketOnly(); reject(error); }
          }
        });
        socket.on('message', (data: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(data.toString());
            const requestId = typeof msg.req_id === 'number' ? msg.req_id : undefined;
            if (requestId === undefined || !this.pending.has(requestId)) return;
            const pending = this.pending.get(requestId)!;
            this.pending.delete(requestId);
            if (msg.error) pending.reject(new Error(String(msg.error.message || msg.error.code || 'Deriv WebSocket request failed')));
            else pending.resolve(msg);
          } catch (error) { console.error('[Deriv WS Parse Error]:', error); }
        });
        socket.on('error', () => { if (!settled) { clearTimeout(connectTimeout); settled = true; this.closeSocketOnly(); reject(new Error('DERIV_AUTHENTICATED_WS_ERROR')); } });
        socket.on('close', () => {
          clearTimeout(connectTimeout);
          for (const [, pending] of this.pending.entries()) pending.reject(new Error('DERIV_WS_CONNECTION_CLOSED'));
          this.pending.clear();
          this.ws = null;
          if (!settled) { settled = true; reject(new Error('DERIV_AUTHENTICATED_WS_CLOSED_DURING_CONNECT')); }
        });
      } catch (error) { clearTimeout(connectTimeout); settled = true; this.closeSocketOnly(); reject(error); }
    });
  }

  private async sendRaw<T = any>(payload: Record<string, any>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('DERIV_WS_NOT_CONNECTED');
    const id = this.reqId++;
    const fullPayload = { ...payload, req_id: id };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`Deriv API request ${payload.msg_type || Object.keys(payload)[0]} timed out`)); } }, 15000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.ws!.send(JSON.stringify(fullPayload)); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async send<T = any>(payload: Record<string, any>): Promise<T> {
    await this.connect(this.targetAccountId ?? undefined);
    return this.sendRaw<T>(payload);
  }

  async getProposal(params: { symbol: string; contract_type: 'CALL' | 'PUT'; amount: number; currency: string; duration: number; duration_unit: string }): Promise<DerivProposalResponse['proposal']> {
    const res = await this.send<{ proposal: any }>({ proposal: 1, amount: params.amount, basis: 'stake', contract_type: params.contract_type, currency: params.currency, duration: params.duration, duration_unit: params.duration_unit, underlying_symbol: params.symbol });
    return res.proposal;
  }

  async buyContract(proposalId: string, price: number): Promise<DerivBuyResponse['buy']> {
    const res = await this.send<{ buy: any }>({ buy: proposalId, price });
    return res.buy;
  }

  async waitForContractSettlement(contractId: number, timeoutMs = 60000): Promise<DerivContractStatus> {
    return new Promise((resolve) => {
      let isSettled = false;
      const timer = setTimeout(() => { if (!isSettled) { isSettled = true; resolve({ is_settled: false, is_won: false, profit: 0, payout: 0, status: 'timeout' }); } }, timeoutMs);
      const check = async () => {
        if (isSettled) return;
        try {
          const res = await this.send<{ proposal_open_contract?: any }>({ proposal_open_contract: 1, contract_id: contractId });
          const poc = res.proposal_open_contract;
          if (poc && poc.is_settleable) {
            isSettled = true;
            clearTimeout(timer);
            const profit = Number(poc.profit || 0);
            resolve({ is_settled: true, is_won: profit > 0, profit, payout: Number(poc.payout || 0), status: poc.status, exit_tick: poc.exit_tick, exit_tick_time: poc.exit_tick_time });
            return;
          }
        } catch {}
        if (!isSettled) setTimeout(check, 1000);
      };
      void check();
    });
  }

  async getTicksHistory(symbol: string, count = 20): Promise<{ time: number; quote: number }[]> {
    const res = await this.send<{ history?: { times: number[]; prices: number[] } }>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      style: 'ticks',
    });
    if (res.history?.times && res.history?.prices && Array.isArray(res.history.times) && Array.isArray(res.history.prices)) {
      return res.history.times.map((t, idx) => ({ time: Number(t), quote: Number(res.history!.prices[idx]) }));
    }
    return [];
  }

  async getBalance(): Promise<{ balance: number; currency: string; loginid: string }> {
    try {
      const res = await this.send<DerivBalancePayload>({ balance: 1 });
      const balance = res.balance;
      if (balance && Number.isFinite(Number(balance.balance)) && typeof balance.currency === 'string' && typeof balance.loginid === 'string') return { balance: Number(balance.balance), currency: balance.currency, loginid: balance.loginid };
      throw new Error('DERIV_BALANCE_RESPONSE_INVALID');
    } catch (wsError) {
      try {
        const accounts = await fetchDerivAccounts(this.token, this.appId);
        const loginid = this.targetAccountId || this.authData?.loginid || '';
        const selected = accounts.find((account) => account.account_id === loginid) ?? accounts[0];
        if (!selected || !Number.isFinite(Number(selected.balance))) throw new Error('DERIV_BALANCE_UNAVAILABLE');
        return { balance: Number(selected.balance), currency: selected.currency, loginid: selected.account_id };
      } catch (restError) {
        if (restError instanceof DerivAuthenticationError) throw restError;
        throw new Error(`DERIV_BALANCE_UNAVAILABLE: ${wsError instanceof Error ? wsError.message : 'WebSocket balance request failed'}`);
      }
    }
  }

  async switchAccount(targetLoginId: string): Promise<DerivAuthorizeResponse['authorize']> {
    const normalizedTarget = targetLoginId.trim();
    if (!normalizedTarget) throw new Error('DERIV_ACCOUNT_ID_REQUIRED');
    this.targetAccountId = normalizedTarget;
    this.close();
    return this.connect(normalizedTarget);
  }

  private closeSocketOnly(): void {
    try { this.ws?.removeAllListeners(); this.ws?.close(); } catch {}
    this.ws = null;
  }

  close(): void {
    this.closeSocketOnly();
    for (const [, pending] of this.pending.entries()) pending.reject(new Error('DERIV_WS_CLIENT_CLOSED'));
    this.pending.clear();
    this.connectPromise = null;
    this.authData = null;
  }
}
