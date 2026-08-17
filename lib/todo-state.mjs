import fs from 'node:fs/promises';
import { todoStateFiles } from './config.mjs';

export async function readChannelTodoState(config, channelId) {
  const files = todoStateFiles(config, channelId);
  const [items, completed, alerts, alertsCompleted] = await Promise.all([
    readJsonl(files.items),
    readJsonl(files.completed),
    readJsonl(files.alerts),
    readJsonl(files.alertsCompleted),
  ]);

  return {
    channelId: String(channelId),
    items,
    completed,
    alerts,
    alertsCompleted,
  };
}

export function formatTodoStateForPrompt(todoState, { maxCompleted = 20, maxAlerts = 30 } = {}) {
  if (!todoState || (
    todoState.items.length === 0
    && todoState.completed.length === 0
    && todoState.alerts.length === 0
    && todoState.alertsCompleted.length === 0
  )) {
    return 'No channel TODO state.';
  }

  return [
    'Channel TODO state:',
    '',
    `Active TODO (${todoState.items.length}):`,
    ...formatTodoList(todoState.items),
    '',
    `Completed TODO (${todoState.completed.length}, showing latest ${Math.min(todoState.completed.length, maxCompleted)}):`,
    ...formatTodoList(todoState.completed.slice(-maxCompleted)),
    '',
    `Active alerts (${todoState.alerts.length}, showing first ${Math.min(todoState.alerts.length, maxAlerts)}):`,
    ...formatAlertList(todoState.alerts.slice(0, maxAlerts)),
    '',
    `Completed alerts (${todoState.alertsCompleted.length}):`,
    ...formatAlertList(todoState.alertsCompleted.slice(-maxAlerts)),
  ].join('\n');
}

export function formatTodoDigest(todoState) {
  return [
    '현재 TODO 목록',
    '',
    `활성 TODO: ${todoState.items.length}`,
    ...formatTodoList(todoState.items),
    '',
    `완료 TODO: ${todoState.completed.length}`,
    ...formatTodoList(todoState.completed),
    '',
    `활성 알림/요약 설정: ${todoState.alerts.length}`,
    ...formatAlertList(todoState.alerts),
    '',
    `완료 알림: ${todoState.alertsCompleted.length}`,
    ...formatAlertList(todoState.alertsCompleted),
  ].join('\n');
}

export function formatActiveTodoList(todoState) {
  const items = todoState?.items || [];
  // Numbered so fast commands like `/할일완료 2` can target by displayed
  // position (see parseTodoCommand in bridge-commands.mjs).
  const lines = items.length === 0 ? ['- 없음'] : items.map((todo, index) => {
    const details = [
      ...(todo.items || []),
      ...(todo.completed_items || []).map((item) => `완료: ${item}`),
    ];
    const schedule = [
      todo.due_at ? `기한 ${todo.due_at}` : null,
      todo.scheduled_for ? `예정 ${todo.scheduled_for}` : null,
    ].filter(Boolean).join(', ');
    const line = `${index + 1}. ${todo.title || '(untitled)'}${schedule ? ` (${schedule})` : ''}`;
    if (details.length === 0) return line;
    return `${line}\n  ${details.map((item) => `- ${item}`).join('\n  ')}`;
  });
  return [
    '현재 TODO 목록',
    '',
    `활성 TODO: ${items.length}`,
    ...lines,
  ].join('\n');
}

function formatTodoList(todos) {
  if (!todos.length) return ['- 없음'];
  return todos.map((todo) => {
    const details = [
      ...(todo.items || []),
      ...(todo.completed_items || []).map((item) => `완료: ${item}`),
    ];
    const schedule = [
      todo.due_at ? `기한 ${todo.due_at}` : null,
      todo.scheduled_for ? `예정 ${todo.scheduled_for}` : null,
      todo.completed_at ? `완료 ${todo.completed_at}` : null,
    ].filter(Boolean).join(', ');
    const line = `- [${todo.id || 'todo'}] ${todo.title || '(untitled)'}${schedule ? ` (${schedule})` : ''}`;
    if (details.length === 0) return line;
    return `${line}\n  ${details.map((item) => `- ${item}`).join('\n  ')}`;
  });
}

function formatAlertList(alerts) {
  if (!alerts.length) return ['- 없음'];
  return alerts.map((alert) => {
    const time = alert.notify_label || alert.notify_at || alert.recurrence || 'no time';
    const sent = alert.sent_at || alert.last_sent_at ? `, sent ${alert.sent_at || alert.last_sent_at}` : '';
    return `- [${alert.id || 'alert'}] ${alert.title || '(untitled)'} (${time}${sent})`;
  });
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
