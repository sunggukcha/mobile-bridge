import {
  boundedRichDeliveryId,
  boundedRichMessageIds,
  boundedRichPartCount,
  mergeRichDeliverySnapshot,
} from './rich-delivery-progress.mjs';

export function classifyOutboxDependencyFailures(entries, {
  isExpired = () => false,
  isExhausted = () => false,
} = {}) {
  const outbox = Array.isArray(entries) ? entries : [];
  const expiredIds = new Set();
  const exhaustedIds = new Set();
  const knownIds = new Set(outbox.map((entry) => entry?.id).filter(Boolean));
  for (const entry of outbox) {
    if (!entry?.id) continue;
    if (isExpired(entry)) expiredIds.add(entry.id);
    else if (isExhausted(entry)) exhaustedIds.add(entry.id);
  }

  const failedIds = new Set([...expiredIds, ...exhaustedIds]);
  const dependencyFailures = new Map();
  // A dependency that vanished without being checkpointed as delivered is not
  // evidence of success. Fail closed so a completion marker cannot overtake a
  // truncated/corrupt prerequisite.
  for (const entry of outbox) {
    if (!entry?.id || failedIds.has(entry.id)) continue;
    const missingDependencies = normalizeOutboxIds(entry.afterOutboxIds)
      .filter((id) => !knownIds.has(id));
    if (missingDependencies.length === 0) continue;
    dependencyFailures.set(entry.id, missingDependencies);
    failedIds.add(entry.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of outbox) {
      if (!entry?.id || failedIds.has(entry.id)) continue;
      const failedDependencies = normalizeOutboxIds(entry.afterOutboxIds)
        .filter((id) => failedIds.has(id));
      if (failedDependencies.length === 0) continue;
      dependencyFailures.set(entry.id, failedDependencies);
      failedIds.add(entry.id);
      changed = true;
    }
  }

  return { expiredIds, exhaustedIds, dependencyFailures };
}

export function clearDeliveredOutboxDependencies(entry, deliveredIds) {
  const dependencies = normalizeOutboxIds(entry?.afterOutboxIds);
  if (dependencies.length === 0 || !deliveredIds?.size) return entry;
  const remaining = dependencies.filter((id) => !deliveredIds.has(id));
  if (remaining.length === dependencies.length) return entry;
  return { ...entry, afterOutboxIds: remaining };
}

export function upsertDedupeOutboxEntry(entries, incoming, {
  payloadFingerprint = defaultPayloadFingerprint,
} = {}) {
  const outbox = Array.isArray(entries) ? entries : [];
  if (!incoming?.dedupeKey) {
    return { entries: [...outbox, incoming], entry: incoming };
  }

  const matchingIndexes = [];
  for (let index = 0; index < outbox.length; index += 1) {
    if (outbox[index]?.dedupeKey === incoming.dedupeKey) matchingIndexes.push(index);
  }
  if (matchingIndexes.length === 0) {
    return { entries: [...outbox, incoming], entry: incoming };
  }

  const canonicalIndex = matchingIndexes[0];
  const canonical = outbox[canonicalIndex];
  const samePayload = payloadFingerprint(canonical) === payloadFingerprint(incoming);
  const hasPartialDelivery = boundedRichPartCount(canonical.deliveredPartCount) > 0
    || boundedRichMessageIds(canonical.deliveredMessageIds).length > 0
    || boundedRichPartCount(canonical.deliveredMessageCount) > 0
    || boundedRichPartCount(canonical.partialPartMessageCount) > 0;
  if (!samePayload && hasPartialDelivery) {
    const error = new Error(
      `cannot replace partially delivered outbox entry for dedupe key ${incoming.dedupeKey}`,
    );
    error.code = 'OUTBOX_PARTIAL_DEDUPE_REPLACEMENT';
    throw error;
  }

  const duplicateIds = new Set(matchingIndexes
    .map((index) => outbox[index]?.id)
    .filter((id) => id && id !== canonical.id));
  const preservedDependencies = normalizeOutboxIds([
    ...normalizeOutboxIds(canonical.afterOutboxIds),
    ...normalizeOutboxIds(incoming.afterOutboxIds),
  ])
    .map((id) => duplicateIds.has(id) ? canonical.id : id)
    .filter((id) => id !== canonical.id);
  const deliveryProgress = samePayload
    ? mergeRichDeliverySnapshot(canonical, incoming)
    : {
        deliveredPartCount: boundedRichPartCount(incoming.deliveredPartCount),
        deliveredMessageIds: boundedRichMessageIds(incoming.deliveredMessageIds),
        deliveredMessageCount: boundedRichPartCount(
          incoming.deliveredMessageCount
          ?? boundedRichMessageIds(incoming.deliveredMessageIds).length,
        ),
        partialPartMessageCount: boundedRichPartCount(incoming.partialPartMessageCount),
        continuationChannelId: boundedRichDeliveryId(incoming.continuationChannelId) || null,
      };
  const replacement = {
    ...incoming,
    id: canonical.id,
    createdAt: canonical.createdAt || incoming.createdAt,
    attempts: Number(canonical.attempts || 0),
    nextAttemptAt: canonical.nextAttemptAt || incoming.nextAttemptAt,
    lastError: incoming.lastError || canonical.lastError || null,
    afterOutboxIds: preservedDependencies,
    ...deliveryProgress,
  };
  const next = [];
  for (let index = 0; index < outbox.length; index += 1) {
    if (index === canonicalIndex) {
      next.push(replacement);
      continue;
    }
    if (matchingIndexes.includes(index)) continue;
    const candidate = outbox[index];
    if (duplicateIds.size === 0) {
      next.push(candidate);
      continue;
    }
    next.push({
      ...candidate,
      afterOutboxIds: normalizeOutboxIds(candidate.afterOutboxIds)
        .map((id) => duplicateIds.has(id) ? canonical.id : id),
    });
  }
  return { entries: next, entry: replacement };
}

export function normalizeOutboxIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
}

function defaultPayloadFingerprint(entry) {
  return JSON.stringify(entry);
}
