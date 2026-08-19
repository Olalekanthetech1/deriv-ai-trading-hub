const STRATEGY_MAP_KEY = 'deriv_contract_strategies';

export const tradeStrategyStore = {
  lastStrategy: 'Manual',
  setStrategy(strategy: string) {
    this.lastStrategy = strategy;
  },
  getStrategy() {
    return this.lastStrategy || 'Manual';
  },
  tagContract(contractId: number | string, strategy?: string) {
    if (!contractId) return;
    const strat = strategy || this.getStrategy();
    try {
      const stored = localStorage.getItem(STRATEGY_MAP_KEY);
      const map = stored ? JSON.parse(stored) : {};
      map[contractId] = strat;
      localStorage.setItem(STRATEGY_MAP_KEY, JSON.stringify(map));
    } catch {
      // ignore
    }
  },
  getContractStrategy(contractId: number | string): string {
    if (!contractId) return 'Manual';
    try {
      const stored = localStorage.getItem(STRATEGY_MAP_KEY);
      if (stored) {
        const map = JSON.parse(stored);
        if (map[contractId]) return map[contractId];
      }
    } catch {
      // ignore
    }
    return this.lastStrategy || 'Manual';
  }
};
