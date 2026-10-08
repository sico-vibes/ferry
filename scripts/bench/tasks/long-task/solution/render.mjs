const escape = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export const render = (items) =>
  '<ul>' +
  items
    .map(
      (item) =>
        '<li><label><input type="checkbox" ' +
        (item.done ? 'checked' : '') +
        '>' +
        escape(item.title) +
        '</label></li>',
    )
    .join('') +
  '</ul>';
