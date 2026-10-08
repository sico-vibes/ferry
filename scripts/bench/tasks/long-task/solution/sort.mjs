export const sortTodos = (items) =>
  [...items].sort(
    (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title),
  );
