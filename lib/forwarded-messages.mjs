// Discord gateway MESSAGE_CREATE payloads can omit message_snapshots for
// forwarded messages, so the bridge only sees the optional comment text (or an
// empty body) and the worker has nothing to act on. Forward events stored with
// forwardedMessages: [] otherwise dead-end in a pending ask.
// These helpers decide when a message needs a REST re-fetch to recover the
// snapshot and merge the fetched fields back into the gateway payload.

const FORWARD_REFERENCE_TYPE = 1;

function snapshotEntries(message) {
  return (message?.message_snapshots || [])
    .map((snapshot) => snapshot?.message || snapshot || null)
    .filter((snapshot) => snapshot && (
      snapshot.content
      || (snapshot.attachments || []).length > 0
      || (snapshot.embeds || []).length > 0
    ));
}

export function hasForwardedMessageContent(message) {
  return snapshotEntries(message).length > 0;
}

export function needsForwardedMessageHydration(message) {
  if (!message?.id || !message?.channel_id) return false;
  if (hasForwardedMessageContent(message)) return false;
  if (message.message_reference?.type === FORWARD_REFERENCE_TYPE) return true;
  return !message.content
    && (message.attachments || []).length === 0
    && (message.embeds || []).length === 0;
}

export function mergeForwardedMessageHydration(message, fetched) {
  if (!hasForwardedMessageContent(fetched)) return message;
  return {
    ...message,
    content: message.content || fetched.content || '',
    message_reference: message.message_reference || fetched.message_reference || null,
    message_snapshots: fetched.message_snapshots,
  };
}
