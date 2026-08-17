export const PRIORITY = Object.freeze({
  SYSTEM_MAINTENANCE: 0,
  ACTIVE_THREAD_FOLLOW_UP: 1,
  NORMAL_TOP_LEVEL_JOB: 2,
  BACKGROUND: 3,
});

export function classifyJob(input = {}) {
  if (input.systemMaintenance) return PRIORITY.SYSTEM_MAINTENANCE;
  if (input.background) return PRIORITY.BACKGROUND;
  if (input.threadId && input.isThreadReply !== false) return PRIORITY.ACTIVE_THREAD_FOLLOW_UP;
  return PRIORITY.NORMAL_TOP_LEVEL_JOB;
}

export class JobScheduler {
  constructor() {
    this.queues = new Map();
    this.channelOrder = new Map();
    for (const priority of Object.values(PRIORITY)) {
      this.queues.set(priority, new Map());
      this.channelOrder.set(priority, []);
    }
  }

  enqueue(job) {
    const priority = job.priority ?? classifyJob(job);
    const channelId = String(job.channelId || 'system');
    const priorityQueues = this.queues.get(priority);
    if (!priorityQueues.has(channelId)) {
      priorityQueues.set(channelId, []);
      this.channelOrder.get(priority).push(channelId);
    }
    priorityQueues.get(channelId).push({ ...job, priority, channelId });
  }

  next({ runningCount = 0, backgroundStartOnlyBelowRunning = 4, blockedThreadKeys = new Set() } = {}) {
    for (const priority of Object.values(PRIORITY).sort((a, b) => a - b)) {
      if (priority === PRIORITY.BACKGROUND && runningCount >= backgroundStartOnlyBelowRunning) continue;
      const job = this.nextFromPriority(priority, { blockedThreadKeys });
      if (job) return job;
    }
    return null;
  }

  size() {
    let count = 0;
    for (const priorityQueues of this.queues.values()) {
      for (const queue of priorityQueues.values()) count += queue.length;
    }
    return count;
  }

  queuedThreadJobs(threadKey) {
    return this.queuedJobs().filter((job) => jobThreadKey(job) === threadKey);
  }

  queuedJobs() {
    const jobs = [];
    for (const priorityQueues of this.queues.values()) {
      for (const queue of priorityQueues.values()) {
        jobs.push(...queue);
      }
    }
    return jobs;
  }

  removeQueuedThreadJobs(threadKey, { excludeIds = [], predicate = () => true } = {}) {
    const excluded = new Set(excludeIds.map((id) => String(id)));
    return this.removeQueuedJobs((job) =>
      jobThreadKey(job) === threadKey
        && !excluded.has(String(job.id || ''))
        && predicate(job),
    );
  }

  removeQueuedJobs(predicate) {
    const removed = [];
    for (const [priority, priorityQueues] of this.queues.entries()) {
      for (const [channelId, queue] of [...priorityQueues.entries()]) {
        const kept = [];
        for (const job of queue) {
          if (predicate(job)) removed.push(job);
          else kept.push(job);
        }
        if (kept.length > 0) priorityQueues.set(channelId, kept);
        else priorityQueues.delete(channelId);
      }
      this.channelOrder.set(
        priority,
        this.channelOrder.get(priority).filter((channelId) => priorityQueues.has(channelId)),
      );
    }
    return removed;
  }

  nextFromPriority(priority, { blockedThreadKeys = new Set() } = {}) {
    const priorityQueues = this.queues.get(priority);
    const order = this.channelOrder.get(priority);
    for (let attempts = 0; attempts < order.length; attempts += 1) {
      const channelId = order.shift();
      const queue = priorityQueues.get(channelId);
      if (!queue || queue.length === 0) {
        priorityQueues.delete(channelId);
        continue;
      }
      const runnableIndex = queue.findIndex((job) => !blockedThreadKeys.has(jobConcurrencyKey(job)));
      if (runnableIndex === -1) {
        order.push(channelId);
        continue;
      }

      const [job] = queue.splice(runnableIndex, 1);
      if (queue.length > 0) order.push(channelId);
      else priorityQueues.delete(channelId);
      return job;
    }
    return null;
  }
}

export function jobThreadKey(job = {}) {
  return `${String(job.channelId || 'system')}:${String(job.threadId || job.channelId || 'channel')}`;
}

export function jobConcurrencyKey(job = {}) {
  const explicit = String(job.concurrencyKey || '').trim();
  return explicit || jobThreadKey(job);
}
