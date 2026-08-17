import assert from 'node:assert/strict';
import test from 'node:test';
import { discordAuthorDisplayName } from '../lib/discord-author.mjs';

test('discordAuthorDisplayName prefers the server nickname', () => {
  assert.equal(discordAuthorDisplayName({
    member: { nick: '숩속이' },
    author: { global_name: 'global-name', username: 'username' },
  }), '숩속이');
});

test('discordAuthorDisplayName falls back through global and user names', () => {
  assert.equal(discordAuthorDisplayName({
    author: { global_name: '테스트 사용자', username: 'example-user' },
  }), '테스트 사용자');
  assert.equal(discordAuthorDisplayName({
    member: { user: { username: 'member-user' } },
    author: { username: 'author-user' },
  }), 'member-user');
});
