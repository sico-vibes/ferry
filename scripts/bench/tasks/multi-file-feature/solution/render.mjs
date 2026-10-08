const escape = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export const render = (items) =>
  '<ul>' +
  items.map((item) => '<li>' + escape(item.name) + ': ' + item.quantity + '</li>').join('') +
  '</ul>';
