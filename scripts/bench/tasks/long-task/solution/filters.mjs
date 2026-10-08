export const filter = (items, mode) =>
  items.filter((item) =>
    mode === 'archived'
      ? item.archived
      : !item.archived &&
        (mode === 'all' ||
          (mode === 'active' && !item.done) ||
          (mode === 'completed' && item.done)),
  );
