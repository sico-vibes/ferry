export function parseCommand(line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  const value = rest.join(' ');
  if (
    !['add', 'done', 'delete', 'list'].includes(command) ||
    (command !== 'list' && !value) ||
    (command === 'list' && value)
  )
    throw Error('Invalid command');
  return { command, value };
}
