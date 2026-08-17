export const MAX_RICH_DELIVERY_PARTS = 10_000;
export const MAX_RICH_DELIVERY_MESSAGE_IDS = 256;
export const MAX_RICH_DELIVERY_MESSAGE_ID_CHARS = 128;

export function boundedRichDeliveryId(value) {
  const id = String(value || '').trim();
  return id.length <= MAX_RICH_DELIVERY_MESSAGE_ID_CHARS ? id : '';
}

export function boundedRichPartCount(value) {
  return Math.min(
    MAX_RICH_DELIVERY_PARTS,
    Math.max(0, Math.trunc(Number(value) || 0)),
  );
}

export function boundedRichMessageIds(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '').trim().slice(0, MAX_RICH_DELIVERY_MESSAGE_ID_CHARS);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_RICH_DELIVERY_MESSAGE_IDS) break;
  }
  return result;
}

export function richDeliveryProgressFromError(error, platform) {
  const prefix = platform === 'slack' ? 'slack' : 'discord';
  const deliveredMessageIds = boundedRichMessageIds(
    error?.[`${prefix}CompletedMessageIds`]
    || (prefix === 'slack' ? error?.slackMessageIds : []),
  );
  const partialPartMessageCount = boundedRichPartCount(
    error?.[`${prefix}PartialPartMessageCount`],
  );
  const continuationChannelId = boundedRichDeliveryId(
    error?.[`${prefix}ContinuationChannelId`],
  );
  return {
    deliveredPartCount: boundedRichPartCount(error?.[`${prefix}CompletedParts`]),
    deliveredMessageIds,
    deliveredMessageCount: boundedRichPartCount(
      error?.[`${prefix}CompletedMessageCount`] ?? deliveredMessageIds.length,
    ),
    partialPartMessageCount,
    continuationChannelId: continuationChannelId || null,
  };
}

export function mergeRichDeliveryProgress(current = {}, incremental = {}) {
  const incrementalPartCount = boundedRichPartCount(incremental.deliveredPartCount);
  const partialPartMessageCount = incrementalPartCount > 0
    ? boundedRichPartCount(incremental.partialPartMessageCount)
    : boundedRichPartCount(
        boundedRichPartCount(current.partialPartMessageCount)
        + boundedRichPartCount(incremental.partialPartMessageCount),
      );
  const continuationChannelId = boundedRichDeliveryId(
    incremental.continuationChannelId || current.continuationChannelId,
  );
  const currentMessageCount = boundedRichPartCount(
    current.deliveredMessageCount
    ?? boundedRichMessageIds(current.deliveredMessageIds).length,
  );
  const incrementalMessageCount = boundedRichPartCount(
    incremental.deliveredMessageCount
    ?? boundedRichMessageIds(incremental.deliveredMessageIds).length,
  );
  return {
    deliveredPartCount: boundedRichPartCount(
      boundedRichPartCount(current.deliveredPartCount)
      + incrementalPartCount,
    ),
    deliveredMessageIds: boundedRichMessageIds([
      ...(Array.isArray(current.deliveredMessageIds) ? current.deliveredMessageIds : []),
      ...(Array.isArray(incremental.deliveredMessageIds) ? incremental.deliveredMessageIds : []),
    ]),
    deliveredMessageCount: boundedRichPartCount(
      currentMessageCount + incrementalMessageCount,
    ),
    partialPartMessageCount,
    continuationChannelId: continuationChannelId || null,
  };
}

export function mergeRichDeliverySnapshot(current = {}, incoming = {}) {
  const currentSnapshot = normalizedRichDeliverySnapshot(current);
  const incomingSnapshot = normalizedRichDeliverySnapshot(incoming);
  const winner = compareRichDeliverySnapshots(incomingSnapshot, currentSnapshot) > 0
    ? incomingSnapshot
    : currentSnapshot;
  return {
    deliveredPartCount: winner.deliveredPartCount,
    deliveredMessageIds: boundedRichMessageIds([
      ...(Array.isArray(current.deliveredMessageIds) ? current.deliveredMessageIds : []),
      ...(Array.isArray(incoming.deliveredMessageIds) ? incoming.deliveredMessageIds : []),
    ]),
    deliveredMessageCount: winner.deliveredMessageCount,
    partialPartMessageCount: winner.partialPartMessageCount,
    continuationChannelId: winner.continuationChannelId || null,
  };
}

function normalizedRichDeliverySnapshot(value = {}) {
  const deliveredMessageIds = boundedRichMessageIds(value.deliveredMessageIds);
  return {
    deliveredPartCount: boundedRichPartCount(value.deliveredPartCount),
    deliveredMessageCount: boundedRichPartCount(
      value.deliveredMessageCount ?? deliveredMessageIds.length,
    ),
    partialPartMessageCount: boundedRichPartCount(value.partialPartMessageCount),
    continuationChannelId: boundedRichDeliveryId(value.continuationChannelId),
  };
}

function compareRichDeliverySnapshots(left, right) {
  for (const key of [
    'deliveredPartCount',
    'partialPartMessageCount',
    'deliveredMessageCount',
  ]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}
