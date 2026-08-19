import type { DerivWS } from '@deriv/core';
import type { OpenPosition } from '@/hooks/use-open-positions';

export async function waitForContractSettlement(
  ws: DerivWS,
  contractId: number,
  timeoutMs: number = 60000 * 5 // Max 5 mins fallback
): Promise<OpenPosition> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(new Error(`Timeout waiting for contract ${contractId} to settle.`));
      }
    }, timeoutMs);

    const unsubscribe = ws.onMessage((data) => {
      if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
        const contract = data.proposal_open_contract as OpenPosition;
        if (contract.contract_id === contractId) {
          const isClosed = !!contract.is_sold || !!contract.is_expired || contract.status !== 'open';
          if (isClosed) {
            settled = true;
            cleanup();
            resolve(contract);
          }
        }
      }
    });

    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
    };
  });
}
