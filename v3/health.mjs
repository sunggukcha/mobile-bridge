#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableBus } from './lib/durable-bus.mjs';
import { isHealthFresh } from './lib/role-health.mjs';
import { loadV3RuntimeConfig } from './lib/runtime-config.mjs';

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export async function probeV3Health({
  env = process.env,
  repoRoot,
  requireWatchdog = false,
  nowMs = Date.now(),
} = {}) {
  const checks = [];
  let runtimeConfig = null;
  let supervisor = null;
  let watchdog = null;
  let bus = null;
  const record = (name, ok, detail) => {
    checks.push({
      name,
      status: ok ? 'pass' : 'fail',
      detail,
    });
  };

  try {
    runtimeConfig = loadV3RuntimeConfig(env, {
      repoRoot,
      createToken: false,
    });
    const systemRoot = path.join(
      runtimeConfig.bridgeConfig.stateRoot,
      '_system',
    );
    supervisor = await readJson(path.join(systemRoot, 'v3-supervisor.json'));
    record(
      'supervisor-state',
      Boolean(supervisor),
      supervisor
        ? `pid ${supervisor.pid}, revision ${supervisor.revision}`
        : 'v3-supervisor.json is missing',
    );
    if (supervisor) {
      record(
        'supervisor-process',
        pidAlive(supervisor.pid),
        `pid ${supervisor.pid}`,
      );
      record(
        'supervisor-heartbeat',
        isHealthFresh(supervisor, {
          nowMs,
          staleAfterMs: runtimeConfig.healthStaleMs * 2,
        }),
        `updated ${supervisor.updatedAt || 'never'}`,
      );
      record(
        'supervisor-overall',
        supervisor.overall?.healthy === true,
        String(supervisor.overall?.phase || 'unknown'),
      );
    }

    for (const role of ['reception', 'workbench']) {
      const roleState = supervisor?.roles?.[role];
      const health = roleState?.health;
      record(
        `${role}-process`,
        Boolean(roleState?.running && pidAlive(roleState.pid)),
        roleState ? `pid ${roleState.pid}` : 'role state is missing',
      );
      record(
        `${role}-heartbeat`,
        Boolean(health && isHealthFresh(health, {
          nowMs,
          staleAfterMs: runtimeConfig.healthStaleMs,
        })),
        health ? `updated ${health.updatedAt}` : 'health is missing',
      );
      record(
        `${role}-ready`,
        health?.ready === true,
        String(health?.phase || 'unknown'),
      );
    }

    const receptionDetails = supervisor?.roles?.reception?.health?.details;
    const workbenchDetails = supervisor?.roles?.workbench?.health?.details;
    record(
      'reception-internal-listener',
      Boolean(receptionDetails?.address?.url),
      String(receptionDetails?.address?.url || 'missing'),
    );
    record(
      'workbench-reception-link',
      workbenchDetails?.receptionConnected === true,
      workbenchDetails?.receptionConnected ? 'connected' : 'disconnected',
    );

    bus = new DurableBus(runtimeConfig.dbPath);
    for (const role of ['reception', 'workbench']) {
      const lease = bus.lease(role);
      const healthLease = supervisor?.roles?.[role]?.health?.details?.lease;
      const leaseOk = Boolean(
        lease
        && lease.expiresAtMs > nowMs
        && healthLease
        && lease.ownerId === healthLease.ownerId
        && lease.epoch === healthLease.epoch,
      );
      record(
        `${role}-lease`,
        leaseOk,
        lease
          ? `owner ${lease.ownerId}, epoch ${lease.epoch}, expires ${new Date(lease.expiresAtMs).toISOString()}`
          : 'lease is missing',
      );
    }

    if (requireWatchdog) {
      watchdog = await readJson(path.join(systemRoot, 'v3-watchdog.json'));
      record(
        'watchdog-state',
        Boolean(watchdog),
        watchdog
          ? `pid ${watchdog.pid}, supervisor ${watchdog.supervisorPid}`
          : 'v3-watchdog.json is missing',
      );
      if (watchdog) {
        record(
          'watchdog-process',
          pidAlive(watchdog.pid),
          `pid ${watchdog.pid}`,
        );
        record(
          'watchdog-heartbeat',
          isHealthFresh(watchdog, {
            nowMs,
            staleAfterMs: Math.max(
              runtimeConfig.healthStaleMs * 2,
              runtimeConfig.watchdogPollMs * 4,
            ),
          }),
          `updated ${watchdog.updatedAt || 'never'}`,
        );
        record(
          'watchdog-ownership',
          Number(watchdog.supervisorPid) === Number(supervisor?.pid),
          `watchdog=${watchdog.supervisorPid || 'none'}, supervisor=${supervisor?.pid || 'none'}`,
        );
        record(
          'watchdog-supervisor-observation',
          watchdog.supervisorHealthy === true
            && Number(watchdog.supervisorRevision) > 0,
          `healthy=${Boolean(watchdog.supervisorHealthy)}, revision=${watchdog.supervisorRevision || 'none'}`,
        );
      }
    }
  } catch (error) {
    record(
      'health-probe',
      false,
      error?.stack || error?.message || String(error),
    );
  } finally {
    bus?.close();
  }

  return {
    ok: checks.every((check) => check.status === 'pass'),
    checkedAt: new Date(nowMs).toISOString(),
    runtime: runtimeConfig
      ? {
          repoRoot: runtimeConfig.repoRoot,
          runtimeRoot: runtimeConfig.runtimeRoot,
          dbPath: runtimeConfig.dbPath,
          platformMode: runtimeConfig.platformMode,
        }
      : null,
    supervisor,
    watchdog,
    checks,
  };
}

async function waitForHealthy(options, waitMs) {
  const deadline = Date.now() + waitMs;
  let report;
  do {
    report = await probeV3Health(options);
    if (report.ok || Date.now() >= deadline) return report;
    await delay(Math.min(500, Math.max(50, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return report;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

if (invokedDirectly) {
  const waitMs = Math.max(
    0,
    Number.parseInt(
      argumentValue('--wait-ms', argumentValue('--wait', '0')),
      10,
    ) || 0,
  );
  const report = await waitForHealthy({
    requireWatchdog: process.argv.includes('--require-watchdog'),
  }, waitMs);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      process.stdout.write(
        `${check.status === 'pass' ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`,
      );
    }
    process.stdout.write(`bridge v3 health: ${report.ok ? 'healthy' : 'unhealthy'}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}
