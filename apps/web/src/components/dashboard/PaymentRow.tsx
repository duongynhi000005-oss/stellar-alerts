import React from 'react';
import { PaymentDTO } from '@stellar-alerts/shared';
import { CopyButton } from '../ui/CopyButton';

export interface PaymentRowProps {
  payment: PaymentDTO;
}

export const PaymentRow: React.FC<PaymentRowProps> = ({ payment }) => {
  return (
    <tr className="hover:bg-slate-800/30 transition-colors">
      <td className="py-3.5 px-4 text-xs font-mono text-slate-400 whitespace-nowrap">
        {new Date(payment.receivedAt).toLocaleString()}
      </td>
      <td className="py-3.5 px-4 font-semibold text-emerald-400 whitespace-nowrap">
        +{Number(payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </td>
      <td className="py-3.5 px-4 whitespace-nowrap">
        <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
          {payment.asset}
        </span>
      </td>
      <td className="py-3.5 px-4 font-mono text-xs text-slate-400 whitespace-nowrap">
        {payment.fromAddress ? (
          <div className="inline-flex items-center gap-2">
            <span title={payment.fromAddress}>
              {payment.fromAddress.length > 16
                ? `${payment.fromAddress.substring(0, 8)}...${payment.fromAddress.substring(payment.fromAddress.length - 8)}`
                : payment.fromAddress}
            </span>
            <CopyButton
              value={payment.fromAddress}
              label={`Copy sender address ${payment.fromAddress}`}
            />
          </div>
        ) : (
          'System / Genesis'
        )}
      </td>
      <td className="py-3.5 px-4 font-mono text-xs text-slate-400 whitespace-nowrap">
        <div className="inline-flex items-center gap-2">
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${payment.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors flex items-center gap-1"
          >
            <span>{payment.txHash ? `${payment.txHash.substring(0, 8)}...` : 'View Tx'}</span>
            <span className="text-[10px]">↗</span>
          </a>
          {payment.txHash && (
            <CopyButton
              value={payment.txHash}
              label={`Copy transaction hash ${payment.txHash}`}
            />
          )}
        </div>
      </td>
      <td className="py-3.5 px-4 whitespace-nowrap">
        <a
          href={`http://localhost:3001/payments/${payment.txHash}/receipt`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2.5 py-1 rounded-md text-xs font-medium bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 transition-colors inline-flex items-center gap-1 cursor-pointer"
          title="Download PDF Receipt"
        >
          <span>📄</span> Receipt
        </a>
      </td>
    </tr>
  );
};
