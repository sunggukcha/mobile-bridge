export function isThreadDestination(channelId, destinationId) {
  return Boolean(destinationId) && String(destinationId) !== String(channelId);
}

export function assertThreadDestination(channelId, destinationId) {
  if (!isThreadDestination(channelId, destinationId)) {
    throw new Error(`refusing to post job response outside a thread: channel=${channelId}, destination=${destinationId || ''}`);
  }
}

export function isParentChannelDestination(channelId, destinationId) {
  return Boolean(destinationId) && String(destinationId) === String(channelId);
}

export function assertParentChannelDestination(channelId, destinationId) {
  if (!isParentChannelDestination(channelId, destinationId)) {
    throw new Error(`refusing to post job final outside its parent channel: channel=${channelId}, destination=${destinationId || ''}`);
  }
}
