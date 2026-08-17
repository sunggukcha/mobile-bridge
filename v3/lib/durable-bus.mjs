import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'lost']);
export const V3_SCHEMA_VERSION = 2;

export class DurableBus {
  constructor(filePath, {
    busyTimeoutMs = 5_000,
    synchronous = 'NORMAL',
  } = {}) {
    if (!filePath) throw new Error('SQLite bus path is required');
    this.filePath = filePath;
    if (filePath !== ':memory:') {
      const resolved = path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const descriptor = fs.openSync(resolved, 'a', 0o600);
      fs.closeSync(descriptor);
      fs.chmodSync(resolved, 0o600);
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec(`PRAGMA busy_timeout = ${positiveInteger(busyTimeoutMs, 5_000)}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA synchronous = ${normalizeSynchronous(synchronous)}`);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initialize();
    this.prepare();
  }

  initialize() {
    const existingVersion = Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version || 0,
    );
    if (existingVersion > V3_SCHEMA_VERSION) {
      throw new Error(
        `v3 coordination schema ${existingVersion} is newer than supported version ${V3_SCHEMA_VERSION}`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bus_messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        job_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        available_at_ms INTEGER NOT NULL,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS bus_messages_stream_sequence
        ON bus_messages(sender, recipient, job_id, sequence);
      CREATE INDEX IF NOT EXISTS bus_messages_pending
        ON bus_messages(recipient, acknowledged_at, available_at_ms, row_id);
      -- pendingMessages preserves per-job order with a correlated lookup for
      -- an earlier unacknowledged row. Without this partial index, SQLite can
      -- narrow that lookup only by recipient and scans the whole backlog once
      -- for every candidate message.
      CREATE INDEX IF NOT EXISTS bus_messages_unacknowledged_job
        ON bus_messages(recipient, job_id, row_id)
        WHERE acknowledged_at IS NULL;
      CREATE INDEX IF NOT EXISTS bus_messages_acknowledged_created
        ON bus_messages(created_at, row_id)
        WHERE acknowledged_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS stream_counters (
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        job_id TEXT NOT NULL DEFAULT '',
        next_sequence INTEGER NOT NULL,
        PRIMARY KEY (sender, recipient, job_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        inbound_message_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        concurrency_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        launch_attempts INTEGER NOT NULL DEFAULT 0,
        launcher_id TEXT,
        last_spawn_pid INTEGER,
        runner_id TEXT,
        worker_pid INTEGER,
        started_at TEXT,
        heartbeat_at_ms INTEGER,
        finished_at TEXT,
        last_error TEXT,
        cancel_reason TEXT,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_status_created
        ON jobs(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS jobs_concurrency_status
        ON jobs(concurrency_key, status);

      CREATE TABLE IF NOT EXISTS role_leases (
        role TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn('jobs', 'result_json', 'TEXT');
    this.ensureColumn('jobs', 'cancel_reason', 'TEXT');
    this.db.exec(`PRAGMA user_version = ${V3_SCHEMA_VERSION}`);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      // Reception and Workbench can start together against an older prototype
      // database. If the sibling process won the ALTER race, the migration is
      // already complete; otherwise preserve the real SQLite failure.
      const migrated = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((entry) => entry.name === column);
      if (!migrated) throw error;
    }
  }

  prepare() {
    this.statements = {
      messageById: this.db.prepare('SELECT * FROM bus_messages WHERE message_id = ?'),
      messageByRowId: this.db.prepare('SELECT * FROM bus_messages WHERE row_id = ?'),
      streamCounter: this.db.prepare(`
        SELECT next_sequence
        FROM stream_counters
        WHERE sender = ? AND recipient = ? AND job_id = ?
      `),
      upsertStreamCounter: this.db.prepare(`
        INSERT INTO stream_counters(sender, recipient, job_id, next_sequence)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sender, recipient, job_id)
        DO UPDATE SET next_sequence = excluded.next_sequence
      `),
      insertMessage: this.db.prepare(`
        INSERT INTO bus_messages(
          message_id, sender, recipient, job_id, kind, sequence,
          payload_json, created_at, available_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      pendingMessages: this.db.prepare(`
        SELECT current.*
        FROM bus_messages AS current
        WHERE current.recipient = ?
          AND current.acknowledged_at IS NULL
          AND current.available_at_ms <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM bus_messages AS earlier
            WHERE earlier.recipient = current.recipient
              AND earlier.job_id = current.job_id
              AND earlier.acknowledged_at IS NULL
              AND earlier.row_id < current.row_id
          )
        ORDER BY current.row_id ASC
        LIMIT ?
      `),
      unacknowledgedMessagesForJob: this.db.prepare(`
        SELECT *
        FROM bus_messages
        WHERE recipient = ?
          AND job_id = ?
          AND acknowledged_at IS NULL
        ORDER BY row_id ASC
        LIMIT ?
      `),
      acknowledgeMessage: this.db.prepare(`
        UPDATE bus_messages
        SET acknowledged_at = ?, acknowledged_by = ?, last_error = NULL
        WHERE row_id = ? AND acknowledged_at IS NULL
      `),
      orphanWorkerMessageSummary: this.db.prepare(`
        SELECT COUNT(*) AS count, MAX(created_at) AS newest_created_at
        FROM bus_messages
        WHERE recipient = ?
          AND job_id = ?
          AND acknowledged_at IS NULL
          AND substr(kind, 1, 7) = 'worker.'
      `),
      acknowledgeOrphanWorkerMessages: this.db.prepare(`
        UPDATE bus_messages
        SET acknowledged_at = ?, acknowledged_by = ?, last_error = NULL
        WHERE recipient = ?
          AND job_id = ?
          AND acknowledged_at IS NULL
          AND substr(kind, 1, 7) = 'worker.'
      `),
      deferMessage: this.db.prepare(`
        UPDATE bus_messages
        SET available_at_ms = ?,
            delivery_attempts = delivery_attempts + 1,
            last_error = ?
        WHERE row_id = ? AND acknowledged_at IS NULL
      `),
      pendingCount: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM bus_messages
        WHERE recipient = ? AND acknowledged_at IS NULL
      `),
      insertJob: this.db.prepare(`
        INSERT OR IGNORE INTO jobs(
          job_id, inbound_message_id, channel_id, thread_id, concurrency_key,
          priority, status, spec_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `),
      jobById: this.db.prepare('SELECT * FROM jobs WHERE job_id = ?'),
      queuedJobs: this.db.prepare(`
        SELECT *
        FROM jobs
        WHERE status = 'queued'
        ORDER BY priority ASC, created_at ASC
        LIMIT ?
      `),
      activeJobs: this.db.prepare(`
        SELECT *
        FROM jobs
        WHERE status IN ('launching', 'running', 'cancel_requested')
        ORDER BY created_at ASC
      `),
      allJobs: this.db.prepare(`
        SELECT *
        FROM jobs
        ORDER BY created_at ASC
        LIMIT ?
      `),
      reserveLaunch: this.db.prepare(`
        UPDATE jobs
        SET status = 'launching',
            launch_attempts = launch_attempts + 1,
            launcher_id = ?,
            updated_at = ?
        WHERE job_id = ? AND status = 'queued'
      `),
      recordSpawn: this.db.prepare(`
        UPDATE jobs
        SET last_spawn_pid = ?, updated_at = ?
        WHERE job_id = ?
          AND launcher_id = ?
          AND status IN ('launching', 'running')
      `),
      releaseLaunch: this.db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            launcher_id = NULL,
            last_error = ?,
            updated_at = ?
        WHERE job_id = ?
          AND launcher_id = ?
          AND status = 'launching'
      `),
      requeueOrphanedLaunch: this.db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            launcher_id = NULL,
            last_error = ?,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'launching'
          AND runner_id IS NULL
      `),
      claimJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'running',
            runner_id = ?,
            worker_pid = ?,
            started_at = COALESCE(started_at, ?),
            heartbeat_at_ms = ?,
            updated_at = ?
        WHERE job_id = ?
          AND status IN ('queued', 'launching')
          AND runner_id IS NULL
      `),
      heartbeatJob: this.db.prepare(`
        UPDATE jobs
        SET heartbeat_at_ms = ?, updated_at = ?
        WHERE job_id = ?
          AND runner_id = ?
          AND status IN ('running', 'cancel_requested')
      `),
      finishJob: this.db.prepare(`
        UPDATE jobs
        SET status = ?,
            finished_at = ?,
            heartbeat_at_ms = ?,
            updated_at = ?,
            last_error = ?,
            result_json = ?
        WHERE job_id = ?
          AND runner_id = ?
          AND status IN ('running', 'cancel_requested')
      `),
      requestCancelRunning: this.db.prepare(`
        UPDATE jobs
        SET status = 'cancel_requested',
            cancel_reason = ?,
            updated_at = ?
        WHERE job_id = ? AND status = 'running'
      `),
      cancelPendingJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'cancelled',
            finished_at = ?,
            updated_at = ?,
            last_error = ?,
            cancel_reason = ?
        WHERE job_id = ? AND status IN ('queued', 'launching')
      `),
      markJobLost: this.db.prepare(`
        UPDATE jobs
        SET status = 'lost',
            finished_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE job_id = ? AND status IN ('running', 'cancel_requested')
      `),
      markPendingJobLost: this.db.prepare(`
        UPDATE jobs
        SET status = 'lost',
            finished_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE job_id = ? AND status IN ('queued', 'launching')
      `),
      forceCancelJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'cancelled',
            finished_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE job_id = ? AND status = 'cancel_requested'
      `),
      requeueLostJob: this.db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            launcher_id = NULL,
            last_spawn_pid = NULL,
            runner_id = NULL,
            worker_pid = NULL,
            started_at = NULL,
            heartbeat_at_ms = NULL,
            finished_at = NULL,
            updated_at = ?,
            last_error = ?,
            cancel_reason = NULL,
            result_json = NULL
        WHERE job_id = ? AND status = 'lost'
      `),
      leaseByRole: this.db.prepare('SELECT * FROM role_leases WHERE role = ?'),
      insertLease: this.db.prepare(`
        INSERT INTO role_leases(role, owner_id, epoch, expires_at_ms, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      updateLease: this.db.prepare(`
        UPDATE role_leases
        SET owner_id = ?, epoch = ?, expires_at_ms = ?, updated_at = ?
        WHERE role = ?
      `),
      renewLease: this.db.prepare(`
        UPDATE role_leases
        SET expires_at_ms = ?, updated_at = ?
        WHERE role = ? AND owner_id = ? AND epoch = ?
      `),
      releaseLease: this.db.prepare(`
        DELETE FROM role_leases
        WHERE role = ? AND owner_id = ? AND epoch = ?
      `),
      deleteAcknowledged: this.db.prepare(`
        DELETE FROM bus_messages
        WHERE row_id IN (
          SELECT row_id
          FROM bus_messages
          WHERE acknowledged_at IS NOT NULL
            AND created_at < ?
          ORDER BY created_at ASC, row_id ASC
          LIMIT ?
        )
      `),
    };

    this.publishTransaction = (message) => this.withImmediateTransaction(() => {
      const duplicate = this.statements.messageById.get(message.messageId);
      if (duplicate) return { ...mapMessage(duplicate), inserted: false };

      const counter = this.statements.streamCounter.get(
        message.sender,
        message.recipient,
        message.jobId,
      );
      const sequence = Number(counter?.next_sequence || 1);
      this.statements.upsertStreamCounter.run(
        message.sender,
        message.recipient,
        message.jobId,
        sequence + 1,
      );
      const result = this.statements.insertMessage.run(
        message.messageId,
        message.sender,
        message.recipient,
        message.jobId,
        message.kind,
        sequence,
        JSON.stringify(message.payload),
        message.createdAt,
        message.availableAtMs,
      );
      const inserted = this.statements.messageByRowId.get(result.lastInsertRowid);
      return { ...mapMessage(inserted), inserted: true };
    });

    this.acquireLeaseTransaction = ({
      role,
      ownerId,
      ttlMs,
      nowMs,
    }) => this.withImmediateTransaction(() => {
      const current = this.statements.leaseByRole.get(role);
      const expiresAtMs = nowMs + ttlMs;
      const updatedAt = new Date(nowMs).toISOString();
      if (!current) {
        this.statements.insertLease.run(role, ownerId, 1, expiresAtMs, updatedAt);
        return { role, ownerId, epoch: 1, expiresAtMs };
      }
      if (current.owner_id === ownerId) {
        this.statements.updateLease.run(
          ownerId,
          current.epoch,
          expiresAtMs,
          updatedAt,
          role,
        );
        return { role, ownerId, epoch: current.epoch, expiresAtMs };
      }
      if (Number(current.expires_at_ms) > nowMs) return null;

      const epoch = Number(current.epoch) + 1;
      this.statements.updateLease.run(ownerId, epoch, expiresAtMs, updatedAt, role);
      return { role, ownerId, epoch, expiresAtMs };
    });
  }

  withImmediateTransaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the transaction's original error.
      }
      throw error;
    }
  }

  publish({
    messageId = randomUUID(),
    sender,
    recipient,
    jobId = '',
    kind,
    payload = {},
    createdAt = new Date().toISOString(),
    availableAtMs = Date.now(),
  }) {
    const message = {
      messageId: requiredText(messageId, 'messageId'),
      sender: requiredText(sender, 'sender'),
      recipient: requiredText(recipient, 'recipient'),
      jobId: String(jobId || ''),
      kind: requiredText(kind, 'kind'),
      payload: jsonValue(payload, 'payload'),
      createdAt: requiredText(createdAt, 'createdAt'),
      availableAtMs: finiteInteger(availableAtMs, Date.now()),
    };
    return this.publishTransaction(message);
  }

  pending(recipient, { limit = 200, nowMs = Date.now() } = {}) {
    return this.statements.pendingMessages
      .all(
        requiredText(recipient, 'recipient'),
        finiteInteger(nowMs, Date.now()),
        positiveInteger(limit, 200),
      )
      .map(mapMessage);
  }

  unacknowledgedForJob(recipient, jobId, { limit = 200 } = {}) {
    return this.statements.unacknowledgedMessagesForJob
      .all(
        requiredText(recipient, 'recipient'),
        requiredText(jobId, 'jobId'),
        positiveInteger(limit, 200),
      )
      .map(mapMessage);
  }

  acknowledge(rowId, actor) {
    const acknowledgedAt = new Date().toISOString();
    const result = this.statements.acknowledgeMessage.run(
      acknowledgedAt,
      requiredText(actor, 'actor'),
      positiveInteger(rowId),
    );
    return result.changes === 1;
  }

  acknowledgeOrphanWorkerRun(recipient, jobId, actor, {
    minAgeMs = 0,
    nowMs = Date.now(),
  } = {}) {
    const normalizedRecipient = requiredText(recipient, 'recipient');
    const normalizedJobId = requiredText(jobId, 'jobId');
    const normalizedActor = requiredText(actor, 'actor');
    const cutoffAgeMs = Math.max(0, finiteInteger(minAgeMs, 0));
    const observedNowMs = finiteInteger(nowMs, Date.now());
    return this.withImmediateTransaction(() => {
      const job = this.statements.jobById.get(normalizedJobId);
      if (job && !TERMINAL_JOB_STATUSES.has(job.status)) return 0;
      const summary = this.statements.orphanWorkerMessageSummary.get(
        normalizedRecipient,
        normalizedJobId,
      );
      const count = Number(summary?.count || 0);
      if (count === 0) return 0;
      const protectedTimestamps = [
        summary?.newest_created_at,
        job?.finished_at,
        job?.updated_at,
      ].filter(Boolean).map((value) => Date.parse(value));
      // Invalid timestamps make the age proof incomplete, so retain the run.
      if (protectedTimestamps.some((value) => !Number.isFinite(value))) return 0;
      const newestMs = Math.max(...protectedTimestamps);
      if (observedNowMs - newestMs < cutoffAgeMs) {
        return 0;
      }
      return this.statements.acknowledgeOrphanWorkerMessages.run(
        new Date(observedNowMs).toISOString(),
        normalizedActor,
        normalizedRecipient,
        normalizedJobId,
      ).changes;
    });
  }

  defer(rowId, error, { delayMs = 1_000, nowMs = Date.now() } = {}) {
    const result = this.statements.deferMessage.run(
      finiteInteger(nowMs, Date.now()) + Math.max(0, finiteInteger(delayMs, 1_000)),
      String(error?.message || error || '').slice(0, 4_000),
      positiveInteger(rowId),
    );
    return result.changes === 1;
  }

  pendingCount(recipient) {
    return Number(this.statements.pendingCount.get(requiredText(recipient, 'recipient'))?.count || 0);
  }

  createJob({
    jobId,
    inboundMessageId,
    channelId,
    threadId,
    concurrencyKey = '',
    priority = 2,
    spec,
    createdAt = new Date().toISOString(),
  }) {
    const normalizedJobId = requiredText(jobId, 'jobId');
    const normalizedChannelId = requiredText(channelId, 'channelId');
    const normalizedThreadId = requiredText(threadId, 'threadId');
    const result = this.statements.insertJob.run(
      normalizedJobId,
      requiredText(inboundMessageId, 'inboundMessageId'),
      normalizedChannelId,
      normalizedThreadId,
      String(concurrencyKey || `${normalizedChannelId}:${normalizedThreadId}`),
      finiteInteger(priority, 2),
      JSON.stringify(jsonValue(spec, 'spec')),
      requiredText(createdAt, 'createdAt'),
      new Date().toISOString(),
    );
    return {
      ...this.getJob(normalizedJobId),
      inserted: result.changes === 1,
    };
  }

  getJob(jobId) {
    const row = this.statements.jobById.get(requiredText(jobId, 'jobId'));
    return row ? mapJob(row) : null;
  }

  queuedJobs({ limit = 1_000 } = {}) {
    return this.statements.queuedJobs.all(positiveInteger(limit, 1_000)).map(mapJob);
  }

  activeJobs() {
    return this.statements.activeJobs.all().map(mapJob);
  }

  listJobs({ limit = 1_000 } = {}) {
    return this.statements.allJobs.all(positiveInteger(limit, 1_000)).map(mapJob);
  }

  schemaVersion() {
    return Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version || 0,
    );
  }

  reserveLaunch(jobId, {
    launcherId,
    at = new Date().toISOString(),
  }) {
    const result = this.statements.reserveLaunch.run(
      requiredText(launcherId, 'launcherId'),
      requiredText(at, 'at'),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  recordSpawn(jobId, {
    launcherId,
    pid,
    at = new Date().toISOString(),
  }) {
    const result = this.statements.recordSpawn.run(
      positiveInteger(pid),
      requiredText(at, 'at'),
      requiredText(jobId, 'jobId'),
      requiredText(launcherId, 'launcherId'),
    );
    return result.changes === 1;
  }

  releaseLaunch(jobId, {
    launcherId,
    error = '',
    at = new Date().toISOString(),
  }) {
    const result = this.statements.releaseLaunch.run(
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(at, 'at'),
      requiredText(jobId, 'jobId'),
      requiredText(launcherId, 'launcherId'),
    );
    return result.changes === 1;
  }

  requeueOrphanedLaunch(jobId, {
    error = 'launcher disappeared before worker claimed the job',
    at = new Date().toISOString(),
  } = {}) {
    const result = this.statements.requeueOrphanedLaunch.run(
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(at, 'at'),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  claimJob(jobId, {
    runnerId,
    pid,
    nowMs = Date.now(),
  }) {
    const now = new Date(nowMs).toISOString();
    const result = this.statements.claimJob.run(
      requiredText(runnerId, 'runnerId'),
      positiveInteger(pid),
      now,
      finiteInteger(nowMs, Date.now()),
      now,
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1 ? this.getJob(jobId) : null;
  }

  heartbeatJob(jobId, runnerId, { nowMs = Date.now() } = {}) {
    const result = this.statements.heartbeatJob.run(
      finiteInteger(nowMs, Date.now()),
      new Date(nowMs).toISOString(),
      requiredText(jobId, 'jobId'),
      requiredText(runnerId, 'runnerId'),
    );
    return result.changes === 1;
  }

  finishJob(jobId, runnerId, {
    status,
    error = '',
    result = null,
    nowMs = Date.now(),
  }) {
    if (!TERMINAL_JOB_STATUSES.has(status)) {
      throw new Error(`invalid terminal job status: ${status}`);
    }
    const now = new Date(nowMs).toISOString();
    const update = this.statements.finishJob.run(
      status,
      now,
      finiteInteger(nowMs, Date.now()),
      now,
      String(error?.message || error || '').slice(0, 8_000),
      result == null ? null : JSON.stringify(jsonValue(result, 'result')),
      requiredText(jobId, 'jobId'),
      requiredText(runnerId, 'runnerId'),
    );
    return update.changes === 1;
  }

  requestCancel(jobId, {
    reason = 'cancel requested by Workbench',
  } = {}) {
    const normalizedJobId = requiredText(jobId, 'jobId');
    const now = new Date().toISOString();
    const normalizedReason = String(reason || 'cancel requested by Workbench')
      .slice(0, 8_000);
    const running = this.statements.requestCancelRunning.run(
      normalizedReason,
      now,
      normalizedJobId,
    );
    if (running.changes === 1) return true;
    const pending = this.statements.cancelPendingJob.run(
      now,
      now,
      normalizedReason,
      normalizedReason,
      normalizedJobId,
    );
    return pending.changes === 1;
  }

  markJobLost(jobId, {
    error = 'detached Worker heartbeat expired',
    at = new Date().toISOString(),
  } = {}) {
    const result = this.statements.markJobLost.run(
      requiredText(at, 'at'),
      requiredText(at, 'at'),
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  markPendingJobLost(jobId, {
    error = 'detached Worker could not be launched',
    at = new Date().toISOString(),
  } = {}) {
    const result = this.statements.markPendingJobLost.run(
      requiredText(at, 'at'),
      requiredText(at, 'at'),
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  forceCancelJob(jobId, {
    error = 'cancelled after detached Worker disappeared',
    at = new Date().toISOString(),
  } = {}) {
    const result = this.statements.forceCancelJob.run(
      requiredText(at, 'at'),
      requiredText(at, 'at'),
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  requeueLostJob(jobId, {
    error = 'retrying lost detached Worker',
    at = new Date().toISOString(),
  } = {}) {
    const result = this.statements.requeueLostJob.run(
      requiredText(at, 'at'),
      String(error?.message || error || '').slice(0, 8_000),
      requiredText(jobId, 'jobId'),
    );
    return result.changes === 1;
  }

  acquireLease(role, ownerId, {
    ttlMs = 10_000,
    nowMs = Date.now(),
  } = {}) {
    return this.acquireLeaseTransaction({
      role: requiredText(role, 'role'),
      ownerId: requiredText(ownerId, 'ownerId'),
      ttlMs: positiveInteger(ttlMs, 10_000),
      nowMs: finiteInteger(nowMs, Date.now()),
    });
  }

  renewLease(lease, {
    ttlMs = 10_000,
    nowMs = Date.now(),
  } = {}) {
    if (!lease) return null;
    const expiresAtMs = finiteInteger(nowMs, Date.now()) + positiveInteger(ttlMs, 10_000);
    const result = this.statements.renewLease.run(
      expiresAtMs,
      new Date(nowMs).toISOString(),
      requiredText(lease.role, 'lease.role'),
      requiredText(lease.ownerId, 'lease.ownerId'),
      positiveInteger(lease.epoch),
    );
    return result.changes === 1 ? { ...lease, expiresAtMs } : null;
  }

  releaseLease(lease) {
    if (!lease) return false;
    const result = this.statements.releaseLease.run(
      requiredText(lease.role, 'lease.role'),
      requiredText(lease.ownerId, 'lease.ownerId'),
      positiveInteger(lease.epoch),
    );
    return result.changes === 1;
  }

  lease(role) {
    const row = this.statements.leaseByRole.get(requiredText(role, 'role'));
    return row ? mapLease(row) : null;
  }

  ownsLease(lease) {
    if (!lease) return false;
    const current = this.lease(lease.role);
    return Boolean(current)
      && current.ownerId === String(lease.ownerId)
      && current.epoch === Number(lease.epoch);
  }

  pruneAcknowledged({
    before = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
    limit = 250,
  } = {}) {
    return this.statements.deleteAcknowledged.run(
      requiredText(before, 'before'),
      positiveInteger(limit, 250),
    ).changes;
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

function mapMessage(row) {
  return {
    rowId: Number(row.row_id),
    messageId: row.message_id,
    sender: row.sender,
    recipient: row.recipient,
    jobId: row.job_id,
    kind: row.kind,
    sequence: Number(row.sequence),
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
    availableAtMs: Number(row.available_at_ms),
    acknowledgedAt: row.acknowledged_at || null,
    acknowledgedBy: row.acknowledged_by || null,
    deliveryAttempts: Number(row.delivery_attempts || 0),
    lastError: row.last_error || null,
  };
}

function mapJob(row) {
  return {
    jobId: row.job_id,
    inboundMessageId: row.inbound_message_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    concurrencyKey: row.concurrency_key,
    priority: Number(row.priority),
    status: row.status,
    spec: parseJson(row.spec_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    launchAttempts: Number(row.launch_attempts || 0),
    launcherId: row.launcher_id || null,
    lastSpawnPid: row.last_spawn_pid == null ? null : Number(row.last_spawn_pid),
    runnerId: row.runner_id || null,
    workerPid: row.worker_pid == null ? null : Number(row.worker_pid),
    startedAt: row.started_at || null,
    heartbeatAtMs: row.heartbeat_at_ms == null ? null : Number(row.heartbeat_at_ms),
    finishedAt: row.finished_at || null,
    lastError: row.last_error || null,
    cancelReason: row.cancel_reason || null,
    result: parseJson(row.result_json, null),
  };
}

function mapLease(row) {
  return {
    role: row.role,
    ownerId: row.owner_id,
    epoch: Number(row.epoch),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonValue(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value serializes to undefined');
    return value;
  } catch (error) {
    throw new Error(`${label} must be JSON serializable: ${error.message}`);
  }
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, fallback = null) {
  const number = Number.parseInt(value, 10);
  if (Number.isInteger(number) && number > 0) return number;
  if (fallback !== null) return fallback;
  throw new Error(`expected a positive integer, received ${value}`);
}

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : Math.trunc(fallback);
}

function normalizeSynchronous(value) {
  const normalized = String(value || 'NORMAL').toUpperCase();
  return ['OFF', 'NORMAL', 'FULL', 'EXTRA'].includes(normalized) ? normalized : 'NORMAL';
}
