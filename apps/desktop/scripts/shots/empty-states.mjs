import { captureRoute } from './capture-route.mjs';
export const name = 'empty-states';
export const run = captureRoute({
  path: '/library',
  heading: 'Library',
  file: 'empty-states.png',
  action: async (page) =>
    page.evaluate(() => {
      const canvas = document.querySelector('.canvas-slot');
      if (canvas)
        canvas.innerHTML =
          '<section class="canvas ferry-page"><h1>Empty, loading and error states</h1><div class="grid grid-cols-3 gap-5"><div class="page-state empty-state"><p>No workspaces yet</p></div><div class="skeleton-stack"><span class="skeleton-row"></span><span class="skeleton-row"></span></div><div class="page-state error-state" role="alert"><p>Provider probe failed</p></div></div></section>';
    }),
});
