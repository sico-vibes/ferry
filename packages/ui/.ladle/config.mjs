export default {
  stories: 'src/**/*.stories.tsx',
  storySort: (a, b) => a.name.localeCompare(b.name),
  viteConfig: 'vite.config.ts',
};
