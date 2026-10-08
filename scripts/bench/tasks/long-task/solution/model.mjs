export function createTodo(id, title, due = null) {
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    typeof title !== 'string' ||
    !title.trim() ||
    !(due === null || /^\d{4}-\d{2}-\d{2}$/.test(due))
  )
    throw Error('Invalid todo');
  return { id, title, done: false, archived: false, due };
}
