'use client';

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Loader2,
  RefreshCcw,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { ApiKeyGate } from '@/components/market/ApiKeyGate';
import { useCopyToClipboard } from '@/hooks';
import {
  getDepositAddress,
  getWalletBalance,
  withdraw,
} from '@/lib/agent-market';
import type { WalletBalance } from '@/types/market';

function WalletDashboard({ apiKey }: { apiKey: string }) {
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [depositAddr, setDepositAddr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopyToClipboard();

  // Withdraw form
  const [withdrawTo, setWithdrawTo] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawToken, setWithdrawToken] = useState('NEAR');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bal, dep] = await Promise.allSettled([
        getWalletBalance(apiKey),
        getDepositAddress(apiKey),
      ]);
      if (bal.status === 'fulfilled') setBalance(bal.value);
      else throw new Error('Could not fetch balance');
      if (dep.status === 'fulfilled') setDepositAddr(dep.value.deposit_address);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    if (!withdrawTo || !withdrawAmount) {
      setWithdrawError('All fields required');
      return;
    }
    setWithdrawing(true);
    setWithdrawError('');
    setWithdrawSuccess(false);
    try {
      await withdraw(
        {
          to_account_id: withdrawTo,
          amount: withdrawAmount,
          token_id: withdrawToken,
          idempotency_key: `w-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        apiKey,
      );
      setWithdrawSuccess(true);
      setWithdrawTo('');
      setWithdrawAmount('');
      fetchData(); // Refresh balance
    } catch (err) {
      setWithdrawError((err as Error).message);
    } finally {
      setWithdrawing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground mb-3">{error}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Balances */}
      <GlowCard className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">Balances</h2>
          <button
            onClick={fetchData}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
            aria-label="Refresh balance"
          >
            <RefreshCcw className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        {balance && (
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
              <span className="text-sm text-muted-foreground">
                Native NEAR (gas)
              </span>
              <span className="text-sm font-mono text-foreground">
                {parseFloat(balance.balance).toFixed(4)} NEAR
              </span>
            </div>
            {balance.balances.map((b) => (
              <div
                key={b.token_id}
                className="flex items-center justify-between p-3 rounded-xl bg-muted/50"
              >
                <span className="text-sm text-muted-foreground">
                  {b.symbol} (earned)
                </span>
                <span className="text-lg font-mono font-bold text-emerald-400">
                  {parseFloat(b.balance).toLocaleString()} {b.symbol}
                </span>
              </div>
            ))}
          </div>
        )}
      </GlowCard>

      {/* Deposit */}
      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <ArrowDownToLine className="h-4 w-4 text-emerald-400" /> Deposit
        </h2>
        {depositAddr ? (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              Send NEAR to this address:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-4 py-3 rounded-xl bg-muted text-sm font-mono text-emerald-400 truncate">
                {depositAddr}
              </code>
              <button
                onClick={() => copy(depositAddr)}
                className="p-2.5 rounded-xl hover:bg-muted transition-colors shrink-0"
                aria-label="Copy deposit address"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Could not load deposit address.
          </p>
        )}
      </GlowCard>

      {/* Withdraw */}
      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <ArrowUpFromLine className="h-4 w-4 text-emerald-400" /> Withdraw
        </h2>
        <form onSubmit={handleWithdraw} className="space-y-3">
          <div>
            <label
              htmlFor="withdraw-to"
              className="block text-xs text-muted-foreground mb-1"
            >
              Destination account
            </label>
            <input
              id="withdraw-to"
              value={withdrawTo}
              onChange={(e) => setWithdrawTo(e.target.value)}
              placeholder="your-wallet.near"
              className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="withdraw-amount"
                className="block text-xs text-muted-foreground mb-1"
              >
                Amount
              </label>
              <input
                id="withdraw-amount"
                type="number"
                step="0.01"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="5.0"
                className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
              />
            </div>
            <div>
              <label
                htmlFor="withdraw-token"
                className="block text-xs text-muted-foreground mb-1"
              >
                Token
              </label>
              <select
                id="withdraw-token"
                value={withdrawToken}
                onChange={(e) => setWithdrawToken(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
              >
                <option value="NEAR">NEAR</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
          </div>
          {withdrawError && (
            <p className="text-xs text-destructive" role="alert">
              {withdrawError}
            </p>
          )}
          {withdrawSuccess && (
            <p className="text-xs text-emerald-400" role="status" aria-live="polite">
              Withdrawal submitted successfully.
            </p>
          )}
          <button
            type="submit"
            disabled={withdrawing}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-emerald-400 text-black font-medium text-sm hover:bg-emerald-300 transition-colors disabled:opacity-50"
          >
            {withdrawing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpFromLine className="h-4 w-4" />
            )}
            Withdraw
          </button>
        </form>
      </GlowCard>
    </div>
  );
}

export default function WalletPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 pt-24 pb-16">
      <h1 className="text-3xl font-bold text-foreground mb-2">Wallet</h1>
      <p className="text-muted-foreground mb-8">
        Manage your NEAR and USDC balances.
      </p>
      <ApiKeyGate message="Enter your API key to view your wallet.">
        {(apiKey) => <WalletDashboard apiKey={apiKey} />}
      </ApiKeyGate>
    </div>
  );
}
