import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runAgentJob } from '../../lib/agent-runner.mjs';
import { formatErrorDetail } from '../../lib/error-detail.mjs';
import { createProgressUpdateForwarder } from '../../lib/job-progress.mjs';
import { parseServiceRestartRequestFromOutput } from '../../lib/service-restart-request.mjs';
import { WakeClient } from './ws-link.mjs';

export class WorkerRuntime extends EventEmitter {
  constructor({
    bus,
    bridgeConfig,
    jobId,
    token,
    workbenchUrl,
    instanceId = `worker-${randomUUID()}`,
    heartbeatMs = 3_000,
    reconnectMinMs = 200,
    reconnectMaxMs = 5_000,
    agentRunner = runAgentJob,
    onLog = null,
  } = {}) {
    super();
    if (!bus || !bridgeConfig || !jobId || !token || !workbenchUrl) {
      throw new Error('WorkerRuntime bus, bridgeConfig, jobId, token, and workbenchUrl are required');
    }
    this.bus = bus;
    this.bridgeConfig = bridgeConfig;
    this.jobId = String(jobId);
    this.token = token;
    this.workbenchUrl = workbenchUrl;
    this.instanceId = instanceId;
    this.heartbeatMs = Math.max(250, Number(heartbeatMs) || 3_000);
    this.agentRunner = agentRunner;
    this.onLog = onLog;
    this.abortController = new AbortController();
    this.heartbeatTimer = null;
    this.running = false;
    this.client = new WakeClient({
      url: workbenchUrl,
      token,
      role: 'worker',
      instanceId,
      reconnectMinMs,
      reconnectMaxMs,
      onWake: (frame) => {
        if (
          frame?.action === 'cancel'
          && String(frame.jobId || '') === this.jobId
        ) {
          this.abort(frame.reason || 'cancel requested by Workbench');
        }
      },
      onError: (error) => this.log('worker-link-error', { error: error.message }),
    });
    this.client.on('connected', () => {
      this.client.wake({
        recipient: 'workbench',
        jobId: this.jobId,
        pending: this.bus.pendingCount('workbench'),
      });
    });
  }

  async run() {
    const claimed = this.bus.claimJob(this.jobId, {
      runnerId: this.instanceId,
      pid: process.pid,
    });
    if (!claimed) {
      await this.log('worker-claim-rejected', {
        jobId: this.jobId,
        instanceId: this.instanceId,
      });
      return { claimed: false };
    }
    this.running = true;
    this.client.start();
    this.startHeartbeat();
    const fullProtocol = Number(claimed.spec.protocolVersion || 1) >= 2;
    const progress = fullProtocol
      ? directUpdatePublisher(this)
      : createProgressUpdateForwarder({
          delayMs: this.bridgeConfig.jobProgressForwardDelayMs,
          verbose: Boolean(claimed.spec.job?.verboseProgress),
          send: (content) => this.publish('worker.progress', { content }),
          onError: (error) => this.log('worker-progress-persist-failed', {
            error: error.message,
          }),
        });

    try {
      const result = claimed.spec.workerMode === 'mock'
        ? await this.runMock(claimed.spec, progress)
        : await this.runAgent(claimed.spec, progress);
      await progress.flush();
      progress.stop();
      const restartRequest = fullProtocol
        ? null
        : parseServiceRestartRequestFromOutput(result.output);
      const durableResult = jsonSafeResult({
        ...result,
        output: restartRequest
          ? restartRequest.visibleText || '작업 결과 본문이 제공되지 않았습니다.'
          : result.output,
      });
      const committed = this.bus.finishJob(this.jobId, this.instanceId, {
        status: 'completed',
        result: durableResult,
      });
      if (!committed) {
        await this.log('worker-terminal-commit-rejected', {
          jobId: this.jobId,
          requestedStatus: 'completed',
          durableStatus: this.bus.getJob(this.jobId)?.status || null,
        });
        return {
          claimed: true,
          status: this.bus.getJob(this.jobId)?.status || 'lost',
          result,
        };
      }
      try {
        await this.publish('worker.completed', {
          result: durableResult,
          output: durableResult.output,
          worker: durableResult.worker || null,
          workerLabel: durableResult.workerLabel || null,
          workerEffort: durableResult.workerEffort || null,
          attempts: durableResult.attempts || [],
          restartExplanation: restartRequest
            ? {
                reason: restartRequest.reason,
                improvement: restartRequest.improvement,
              }
            : null,
        });
      } catch (error) {
        // The terminal result in jobs is authoritative. A replacement
        // Workbench can settle from it even if the wake/event write failed.
        await this.log('worker-terminal-event-persist-failed', {
          jobId: this.jobId,
          status: 'completed',
          error: formatErrorDetail(error),
        });
      }
      await this.log('worker-completed', {
        jobId: this.jobId,
        worker: result.worker || null,
      });
      return { claimed: true, status: 'completed', result };
    } catch (error) {
      await progress.flush().catch(() => {});
      progress.stop();
      const current = this.bus.getJob(this.jobId);
      const cancelled = current?.status === 'cancel_requested'
        || this.abortController.signal.aborted;
      const status = cancelled ? 'cancelled' : 'failed';
      const abortReason = String(
        current?.cancelReason
        || this.abortController.signal.reason
        || error.abortReason
        || error.message
        || 'cancel requested by Workbench',
      );
      const detail = cancelled
        ? `worker cancelled: ${abortReason}`
        : formatErrorDetail(error);
      const errorMeta = workerErrorMetadata(error);
      if (cancelled) {
        errorMeta.aborted = true;
        errorMeta.cancelled = true;
        errorMeta.abortReason = abortReason;
      }
      const failureResult = jsonSafeResult({
        error: detail,
        errorMeta,
        cancelled,
        worker: error.worker || null,
        attempts: error.workerAttempts || [],
        workerTranscripts: error.workerTranscripts || [],
      });
      const committed = this.bus.finishJob(this.jobId, this.instanceId, {
        status,
        error: detail,
        result: failureResult,
      });
      if (committed) {
        try {
          await this.publish('worker.failed', {
            error: detail,
            errorMeta: failureResult.errorMeta,
            cancelled,
            result: failureResult,
            workerAttempts: failureResult.attempts,
            workerTranscripts: failureResult.workerTranscripts,
          });
        } catch (publishError) {
          // finishJob above is authoritative. Keep the original worker
          // failure intact even when the terminal event cannot be persisted.
          await this.log('worker-terminal-event-persist-failed', {
            jobId: this.jobId,
            status,
            error: formatErrorDetail(publishError),
          });
        }
      } else {
        await this.log('worker-terminal-commit-rejected', {
          jobId: this.jobId,
          requestedStatus: status,
          durableStatus: this.bus.getJob(this.jobId)?.status || null,
        });
      }
      await this.log('worker-failed', {
        jobId: this.jobId,
        status: committed ? status : this.bus.getJob(this.jobId)?.status || status,
        error: detail,
      });
      return {
        claimed: true,
        status: committed ? status : this.bus.getJob(this.jobId)?.status || status,
        error,
      };
    } finally {
      this.running = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.client.stop();
    }
  }

  async runAgent(spec, progress) {
    return this.agentRunner({
      config: this.bridgeConfig,
      job: spec.job,
      prompt: spec.prompt,
      search: Boolean(spec.job.search),
      onUpdate: (update) => progress.add(update),
      onWorkerStart: (workerInfo) => this.publish('worker.started', { workerInfo }),
      signal: this.abortController.signal,
      // The worker owns its lifecycle. A Workbench restart must never make
      // runAgentJob treat the provider process as a bridge-shutdown casualty.
      isShuttingDown: () => false,
    });
  }

  async runMock(spec, progress) {
    const plan = spec.mockPlan || {
      startDelayMs: 20,
      updateDelayMs: 100,
      updates: ['mock worker progress'],
      finalDelayMs: 100,
      output: 'mock worker completed',
      fail: false,
    };
    await abortableDelay(plan.startDelayMs, this.abortController.signal);
    await this.publish('worker.started', {
      workerInfo: {
        worker: 'mock',
        workerLabel: 'mock',
      },
    });
    for (const update of plan.updates) {
      await abortableDelay(plan.updateDelayMs, this.abortController.signal);
      progress.add({
        worker: 'codex',
        type: 'response_text',
        text: String(update),
      });
      await progress.flush();
    }
    await abortableDelay(plan.finalDelayMs, this.abortController.signal);
    if (plan.fail) throw new Error(plan.output || 'mock worker failure');
    return {
      output: plan.output,
      worker: 'mock',
      workerLabel: 'mock',
      attempts: [{ worker: 'mock', status: 'succeeded' }],
    };
  }

  publish(kind, payload) {
    const message = this.bus.publish({
      sender: 'worker',
      recipient: 'workbench',
      jobId: this.jobId,
      kind,
      payload,
    });
    const websocketSent = this.client.wake({
      recipient: 'workbench',
      jobId: this.jobId,
      rowId: message.rowId,
      messageId: message.messageId,
    });
    this.emit('published', message, { websocketSent });
    return message;
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const current = this.bus.getJob(this.jobId);
      if (current?.status === 'cancel_requested') {
        this.abort(current.cancelReason || 'cancel requested by Workbench');
        return;
      }
      const updated = this.bus.heartbeatJob(this.jobId, this.instanceId);
      if (!updated && this.running) this.abort('job ownership lost');
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  abort(reason = 'worker stopping') {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async log(type, payload = {}) {
    this.emit('log', type, payload);
    await this.onLog?.(type, payload);
  }
}

function directUpdatePublisher(runtime) {
  return {
    add(update) {
      runtime.publish('worker.update', {
        update: jsonSafeResult(update),
      });
    },
    async flush() {},
    stop() {},
  };
}

function jsonSafeResult(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Error) {
      return {
        name: entry.name,
        message: entry.message,
        stack: entry.stack,
        code: entry.code ?? null,
      };
    }
    if (typeof entry === 'bigint') return String(entry);
    return entry;
  }));
}

export function workerErrorMetadata(error) {
  if (!error) return {};
  const metadata = jsonSafeResult({
    ...error,
    name: error.name || 'Error',
    message: error.message || String(error),
    stack: error.stack || '',
  });
  // These potentially large structures already have dedicated normalized
  // fields in the terminal payload and should not be duplicated.
  delete metadata.workerAttempts;
  delete metadata.workerTranscripts;
  return metadata;
}

function abortableDelay(ms, signal) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(reason) {
  const error = new Error(String(reason || 'worker aborted'));
  error.aborted = true;
  return error;
}
