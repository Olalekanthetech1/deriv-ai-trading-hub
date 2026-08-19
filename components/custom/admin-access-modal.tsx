'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Lock, KeyRound, AlertCircle, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setStoredAdminToken } from '@/lib/admin-client-auth';
import { toast } from 'sonner';

interface AdminAccessModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdminAccessModal({ open, onOpenChange }: AdminAccessModalProps) {
  const [passkey, setPasskey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passkey.trim()) {
      setError('Please enter the Admin Security Passkey.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: passkey.trim() }),
      });

      const data = await response.json();

      if (!response.ok || !data?.success) {
        setError(data?.error || 'Invalid Admin Passkey.');
        setIsSubmitting(false);
        return;
      }

      if (data?.token) {
        setStoredAdminToken(data.token);
      }

      toast.success('Admin authentication verified!', {
        icon: <ShieldCheck className="w-4 h-4 text-emerald-400" />,
      });

      setPasskey('');
      onOpenChange(false);
      router.push('/admin');
    } catch {
      setError('Network error verifying admin credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-slate-900 border-slate-800 text-slate-100 rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
        <DialogHeader className="space-y-2">
          <div className="mx-auto w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-1">
            <Lock className="w-6 h-6 animate-pulse" />
          </div>
          <DialogTitle className="text-xl font-bold text-center text-white">
            Admin Operations Portal
          </DialogTitle>
          <DialogDescription className="text-xs text-center text-slate-400">
            Enter the master security passkey to unlock the system Operations Center.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleAuthSubmit} className="space-y-4 pt-2">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-cyan-400" /> Security Passkey
            </label>
            <Input
              type="password"
              placeholder="••••••••••••"
              value={passkey}
              onChange={(e) => setPasskey(e.target.value)}
              autoFocus
              className="bg-slate-950 border-slate-800 focus:border-cyan-500 text-white placeholder:text-slate-600 rounded-xl"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="text-slate-400 hover:text-white text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Verifying...
                </>
              ) : (
                <>
                  <ShieldCheck className="w-3.5 h-3.5" /> Unlock Operations
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function useAdminGesture(onTrigger: () => void) {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const tapCountRef = useRef<number>(0);
  const lastTapRef = useRef<number>(0);

  const startLongPress = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onTrigger();
    }, 1200); // 1.2 second long press
  }, [onTrigger]);

  const endLongPress = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleMultiTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      tapCountRef.current += 1;
    } else {
      tapCountRef.current = 1;
    }
    lastTapRef.current = now;

    if (tapCountRef.current >= 3) {
      tapCountRef.current = 0;
      onTrigger();
    }
  }, [onTrigger]);

  return {
    onTouchStart: startLongPress,
    onTouchEnd: () => {
      endLongPress();
      handleMultiTap();
    },
    onMouseDown: startLongPress,
    onMouseUp: endLongPress,
    onMouseLeave: endLongPress,
  };
}
