import { spawn, ChildProcess } from 'child_process';
import { getMlRuntimeSchemaContract, type MlRuntimeSchemaContract } from './ml-runtime-schema';

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
  onProgress?: (data: any) => void;
  trainingRunId?: string;
  modelType?: string;
}

type MlRuntimeAction = 'predict' | 'predict_ensemble' | 'train' | 'train_partitioned' | 'train_horizon_cohort' | 'train_unified_multi_horizon' | 'list_models' | 'ping' | 'backtest';
const CANONICAL_RUNTIME_ENTRYPOINT = 'ml_runtime_entry.py';
const DEFAULT_TRAINING_TIMEOUT_MS = 15 * 60 * 1000;

function trainingTimeoutMs(): number {
  const raw = process.env.ML_TRAINING_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : DEFAULT_TRAINING_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_TIMEOUT_MS;
  return Math.min(2 * 60 * 60 * 1000, Math.max(60_000, Math.trunc(value)));
}

function attachClientRoundTripTiming(data: any, roundTripMs: number): any {
  if (!data || typeof data !== 'object') return data;
  const next: Record<string, any> = { ...data };
  const metrics = next.metrics && typeof next.metrics === 'object' ? { ...next.metrics } : null;
  if (metrics) {
    const timings = metrics.timings && typeof metrics.timings === 'object' ? { ...metrics.timings } : {};
    timings.clientRoundTripMs = roundTripMs;
    metrics.timings = timings;
    next.metrics = metrics;
  } else {
    const timings = next.timings && typeof next.timings === 'object' ? { ...next.timings } : {};
    timings.clientRoundTripMs = roundTripMs;
    next.timings = timings;
  }
  return next;
}

function compactSequenceDatasetForTransport(dataset: unknown): unknown {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return dataset;
  const current = dataset as Record<string, any>;
  const sequences = current.featureSequences;
  if (!Array.isArray(sequences)) return dataset;
  if (sequences.length === 0) {
    return {
      ...current,
      featureSequences: {
        transportVersion: 1,
        featureRows: [],
      },
    };
  }

  const first = sequences[0];
  if (!Array.isArray(first) || first.length === 0) {
    throw new Error('INVALID_SEQUENCE_TRANSPORT_PAYLOAD');
  }

  const featureRows: unknown[] = [...first];
  for (let index = 1; index < sequences.length; index += 1) {
    const sequence = sequences[index];
    if (!Array.isArray(sequence) || sequence.length !== first.length) {
      throw new Error(`INVALID_SEQUENCE_TRANSPORT_ALIGNMENT:${index}`);
    }
    featureRows.push(sequence[sequence.length - 1]);
  }

  return {
    ...current,
    featureSequences: {
      transportVersion: 1,
      featureRows,
    },
  };
}

class MlRuntimeClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private liveTrainingDiagnostics = new Map<string, any>();
  private reqIdCounter = 0;
  private isReady = false;
  private buffer = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = 1000;

  private getRuntimeScript(): string {
    const configuredScript = process.env.PYTHON_ML_SCRIPT_PATH?.trim();
    const pythonScript = configuredScript || `scripts/${CANONICAL_RUNTIME_ENTRYPOINT}`;
    const scriptName = pythonScript.split(/[\\/]/).pop() || '';
    if (scriptName !== CANONICAL_RUNTIME_ENTRYPOINT) {
      throw new Error(`PYTHON_ML_SCRIPT_PATH must target the canonical ${CANONICAL_RUNTIME_ENTRYPOINT} entrypoint`);
    }
    return pythonScript;
  }

  private ensureRuntimeRunning() {
    if (this.child) return;
    try {
      const pythonScript = this.getRuntimeScript();
      this.child = spawn(/*turbopackIgnore: true*/ process.env.PYTHON_BIN || 'python3', [pythonScript], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2',
          OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
          OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || '1',
          MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '1',
          NUMEXPR_NUM_THREADS: process.env.NUMEXPR_NUM_THREADS || '1',
          TORCH_NUM_THREADS: process.env.TORCH_NUM_THREADS || '1',
          TORCH_N_THREADS: process.env.TORCH_N_THREADS || '1',
        },
      });
      this.child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === 'ready') {
              this.isReady = true;
              this.restartDelay = 1000;
              continue;
            }
            if (data.type === 'progress' && data.id && this.pending.has(data.id)) {
              const req = this.pending.get(data.id)!;
              const trainingRunId = typeof data.trainingRunId === 'string' ? data.trainingRunId : req.trainingRunId || '';
              const modelType = typeof data.modelType === 'string' ? data.modelType : req.modelType || '';
              if (trainingRunId && modelType) {
                this.liveTrainingDiagnostics.set(`${trainingRunId}:${modelType}`, {
                  phase: data.phase || 'running',
                  elapsedMs: Number(data.elapsedMs) || 0,
                  timings: data.timings && typeof data.timings === 'object' ? data.timings : {},
                  message: typeof data.message === 'string' ? data.message : null,
                  updatedAt: new Date().toISOString(),
                });
              }
              try { req.onProgress?.(data); } catch { /* diagnostics must never break training */ }
              continue;
            }
            if (data.id && this.pending.has(data.id)) {
              const req = this.pending.get(data.id)!;
              clearTimeout(req.timer);
              this.pending.delete(data.id);
              if (req.trainingRunId && req.modelType) this.liveTrainingDiagnostics.delete(`${req.trainingRunId}:${req.modelType}`);
              req.resolve(data);
            }
          } catch {
            /* ignore non-JSON stdout */
          }
        }
      });
      const onExit = () => {
        this.child = null;
        this.isReady = false;
        this.buffer = '';
        this.liveTrainingDiagnostics.clear();
        for (const req of this.pending.values()) {
          clearTimeout(req.timer);
          req.reject(new Error('Python ML runtime exited unexpectedly'));
        }
        this.pending.clear();
        this.scheduleRestart();
      };
      this.child.on('exit', onExit);
      this.child.on('error', onExit);
    } catch {
      this.child = null;
      this.isReady = false;
      this.scheduleRestart();
    }
  }

  private terminateTrainingRuntime() {
    const child = this.child;
    this.child = null;
    this.isReady = false;
    this.buffer = '';
    this.liveTrainingDiagnostics.clear();
    if (!child) return;
    try {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }, 2000);
      child.once('exit', () => clearTimeout(killTimer));
    } catch {
      // The child may have already exited; restart scheduling remains safe.
    }
    this.scheduleRestart();
  }

  private scheduleRestart() {
    if (this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(30000, this.restartDelay * 2);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureRuntimeRunning();
    }, delay);
  }

  private static readonly ALLOWED_ACTIONS = new Set<MlRuntimeAction>([
    'predict',
    'predict_ensemble',
    'train',
    'train_partitioned',
    'train_horizon_cohort',
    'train_unified_multi_horizon',
    'list_models',
    'ping',
    'backtest',
  ]);

  public async sendCommand(
    action: MlRuntimeAction,
    payload: Record<string, any> = {},
    options: { onProgress?: (data: any) => void } = {},
  ): Promise<any> {
    const remoteBackendUrl = process.env.ML_REMOTE_RUNTIME_URL?.trim() || process.env.RENDER_BACKEND_URL?.trim();
    if (remoteBackendUrl) {
      return this.sendCommandRemote(remoteBackendUrl, action, payload, options);
    }
    return this.sendCommandDirectLocal(action, payload, options);
  }

  private async sendCommandRemote(
    remoteUrl: string,
    action: MlRuntimeAction,
    payload: Record<string, any> = {},
    _options: { onProgress?: (data: any) => void } = {},
  ): Promise<any> {
    if (!MlRuntimeClient.ALLOWED_ACTIONS.has(action)) throw new Error(`Unauthorized ML runtime action: ${action}`);
    const normalizedUrl = remoteUrl.replace(/\/+$/, '');
    const endpoint = `${normalizedUrl}/api/ml/runtime`;
    const adminSecret = process.env.ADMIN_SECRET_KEY?.trim() || '';

    const defaultTimeoutMs = action === 'train' || action === 'train_partitioned' || action === 'train_horizon_cohort' || action === 'train_unified_multi_horizon'
      ? trainingTimeoutMs()
      : action === 'backtest'
        ? 60000
        : action === 'predict_ensemble'
          ? 30000
          : 5000;
    const configuredTimeout = Number(process.env.ML_PREDICT_ENSEMBLE_TIMEOUT_MS);
    const timeoutMs = action === 'predict_ensemble' && Number.isFinite(configuredTimeout) && configuredTimeout >= 5000 && configuredTimeout <= 60000
      ? configuredTimeout
      : defaultTimeoutMs;

    const roundTripStartedAt = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': adminSecret,
        },
        body: JSON.stringify({ action, payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({ error: `Remote HTTP ${response.status}` }));
        throw new Error(errorJson?.error || `Remote ML Runtime error (${response.status})`);
      }

      const data = await response.json();
      return attachClientRoundTripTiming(data, Date.now() - roundTripStartedAt);
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.message?.includes('timeout')) {
        throw new Error(`Remote ML runtime request ${action} timed out after ${timeoutMs}ms against ${normalizedUrl}`);
      }
      throw err;
    }
  }

  public async sendCommandDirectLocal(
    action: MlRuntimeAction,
    payload: Record<string, any> = {},
    options: { onProgress?: (data: any) => void } = {},
  ): Promise<any> {
    if (!MlRuntimeClient.ALLOWED_ACTIONS.has(action)) throw new Error(`Unauthorized ML runtime action: ${action}`);
    this.ensureRuntimeRunning();
    if (!this.child?.stdin?.writable) {
      const isServerless = Boolean(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
      if (isServerless) {
        throw new Error('Python ML runtime unavailable on serverless edge. Please set RENDER_BACKEND_URL in your Netlify environment variables pointing to your Render service.');
      }
      throw new Error('Python ML runtime unavailable');
    }

    const requestedSchema = payload.schemaContract as MlRuntimeSchemaContract | undefined;
    const durationContext = (typeof payload.durationValue === 'number' && typeof payload.durationUnit === 'string')
      ? { durationValue: payload.durationValue, durationUnit: payload.durationUnit as any }
      : undefined;
    const schemaContract = requestedSchema ?? await getMlRuntimeSchemaContract(durationContext);
    if (!schemaContract || typeof schemaContract !== 'object' || typeof schemaContract.schemaFingerprint !== 'string') {
      throw new Error('Invalid ML schema contract.');
    }
    const sanitized: Record<string, any> = { ...payload, schemaContract };
    if (typeof sanitized.symbol === 'string') sanitized.symbol = sanitized.symbol.replace(/[^A-Za-z0-9_]/g, '');
    if (sanitized.ticks !== undefined && !Array.isArray(sanitized.ticks)) throw new Error('ticks must be an array');

    if (action === 'train_partitioned') {
      sanitized.trainSequenceDataset = compactSequenceDatasetForTransport(sanitized.trainSequenceDataset);
      sanitized.validationSequenceDataset = compactSequenceDatasetForTransport(sanitized.validationSequenceDataset);
    }

    const id = `req_${Date.now()}_${++this.reqIdCounter}`;
    const packet = JSON.stringify({ action, id, ...sanitized }) + '\n';
    const roundTripStartedAt = Date.now();
    const trainingRunId = typeof payload.trainingRunId === 'string' ? payload.trainingRunId : '';
    const modelType = typeof payload.modelType === 'string' ? payload.modelType : '';

    return new Promise((resolve, reject) => {
      const defaultTimeoutMs = action === 'train' || action === 'train_partitioned' || action === 'train_horizon_cohort' || action === 'train_unified_multi_horizon'
        ? trainingTimeoutMs()
        : action === 'backtest'
          ? 60000
          : action === 'predict_ensemble'
            ? 30000
            : 5000;
      const configuredTimeout = Number(process.env.ML_PREDICT_ENSEMBLE_TIMEOUT_MS);
      const timeoutMs = action === 'predict_ensemble' && Number.isFinite(configuredTimeout) && configuredTimeout >= 5000 && configuredTimeout <= 60000
        ? configuredTimeout
        : defaultTimeoutMs;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (trainingRunId && modelType) this.liveTrainingDiagnostics.delete(`${trainingRunId}:${modelType}`);
        if (action === 'train' || action === 'train_partitioned' || action === 'train_horizon_cohort' || action === 'train_unified_multi_horizon') {
          this.terminateTrainingRuntime();
          reject(new Error(`ML_TRAINING_TIMEOUT: ${action} exceeded ${timeoutMs}ms; native runtime was terminated and will restart cleanly.`));
        } else {
          reject(new Error(`ML runtime request ${action} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (data: any) => resolve(attachClientRoundTripTiming(data, Date.now() - roundTripStartedAt)),
        reject,
        timer,
        onProgress: options.onProgress,
        trainingRunId,
        modelType,
      });

      try {
        this.child!.stdin!.write(packet);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (trainingRunId && modelType) this.liveTrainingDiagnostics.delete(`${trainingRunId}:${modelType}`);
        reject(err);
      }
    });
  }

  /**
   * Recycle the native runtime after a training request so native ML memory
   * (Torch/BLAS/allocator state) does not accumulate across queue items on
   * small Render instances. The runtime will restart lazily for the next job.
   */
  public resetAfterTraining(): void {
    if (this.pending.size > 0) return;
    this.terminateTrainingRuntime();
  }

  public getLiveTrainingDiagnostic(trainingRunId: string, modelType: string) {
    return this.liveTrainingDiagnostics.get(`${trainingRunId}:${modelType}`) || null;
  }

  public isAvailable() {
    this.ensureRuntimeRunning();
    return this.child !== null && this.isReady;
  }
}

export const mlRuntimeClient = new MlRuntimeClient();
