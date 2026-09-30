import { defineConfig } from 'vite';

export default defineConfig({
  // Both our mesh worker and MapLibre's worker are ES modules.
  worker: { format: 'es' },
});
