'use client';

import { useEffect, useState } from 'react';
import { Cloud, GitCommit, CheckCircle2, AlertTriangle, Clock, RefreshCw } from 'lucide-react';

interface DeployData {
  id: string;
  status: string; // 'created', 'build_in_progress', 'update_in_progress', 'live', 'deactivated', 'build_failed', 'update_failed', 'canceled'
  createdAt: string;
  finishedAt: string | null;
  commit: string | null;
  message: string;
}

export function RenderDeploymentWidget() {
  const [deploy, setDeploy] = useState<DeployData | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch('/api/admin/render-deployment', { cache: 'no-store' });
      const json = await res.json();
      
      if (json.configured === false) {
        setConfigured(false);
      } else if (json.success && json.deploy) {
        setConfigured(true);
        setDeploy(json.deploy);
        setError(null);
      } else if (json.error) {
        setConfigured(true);
        setError(json.error);
      }
    } catch (e) {
      console.error(e);
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000); // Check every 20s
    return () => clearInterval(interval);
  }, []);

  if (loading && configured === null) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex animate-pulse items-center gap-3">
          <div className="h-4 w-4 rounded-full bg-white/10" />
          <div className="h-4 w-32 rounded-md bg-white/10" />
        </div>
      </div>
    );
  }

  if (configured === false) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud className="h-4 w-4 text-slate-400" />
          Render Deployment Status
        </h3>
        <p className="mt-2 text-xs text-slate-500">
          Not configured. Set RENDER_API_KEY and RENDER_SERVICE_ID in environment variables to monitor deployment progress.
        </p>
      </div>
    );
  }

  const isLive = deploy?.status === 'live';
  const isFailed = deploy?.status?.includes('failed') || deploy?.status === 'canceled';
  const isBuilding = deploy?.status?.includes('progress') || deploy?.status === 'created';

  let statusTone = 'text-slate-400 border-white/10 bg-white/5';
  let StatusIcon = Clock;
  let pulse = false;

  if (isLive) {
    statusTone = 'text-emerald-300 border-emerald-400/20 bg-emerald-400/10';
    StatusIcon = CheckCircle2;
  } else if (isFailed) {
    statusTone = 'text-red-300 border-red-400/20 bg-red-400/10';
    StatusIcon = AlertTriangle;
  } else if (isBuilding) {
    statusTone = 'text-amber-300 border-amber-400/20 bg-amber-400/10';
    StatusIcon = RefreshCw;
    pulse = true;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud className="h-4 w-4 text-slate-400" />
          Render Deployment
        </h3>
        <div className="flex items-center gap-2">
          {error ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-400/20 bg-red-400/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-red-300">
              <AlertTriangle className="h-3 w-3" />
              API ERROR
            </span>
          ) : deploy ? (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone}`}>
              {pulse && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />}
              <StatusIcon className={`h-3 w-3 ${pulse ? 'animate-spin' : ''}`} />
              {deploy.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      </div>

      {deploy && !error && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/5 bg-black/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <GitCommit className="h-3 w-3" /> Commit
            </p>
            <p className="truncate text-xs font-semibold text-slate-200">
              {deploy.commit ? <span className="mr-1.5 font-mono text-cyan-400">{deploy.commit}</span> : null}
              {deploy.message}
            </p>
          </div>
          
          <div className="rounded-xl border border-white/5 bg-black/20 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <Clock className="h-3 w-3" /> Timeline
            </p>
            <p className="text-xs text-slate-300">
              {deploy.finishedAt 
                ? `Finished at ${new Date(deploy.finishedAt).toLocaleTimeString()}`
                : `Started at ${new Date(deploy.createdAt).toLocaleTimeString()}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
