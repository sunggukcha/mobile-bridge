export function discordAuthorDisplayName(message = {}) {
  const member = message.member || {};
  const author = message.author || {};
  const memberUser = member.user || {};

  return firstText([
    member.nick,
    member.display_name,
    memberUser.global_name,
    author.global_name,
    memberUser.username,
    author.username,
  ]);
}

function firstText(values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
