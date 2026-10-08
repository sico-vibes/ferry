import { filter } from './filters.mjs';
export const stats = (items) => ({
  total: items.length,
  active: filter(items, 'active').length,
  completed: filter(items, 'completed').length,
  archived: filter(items, 'archived').length,
});
