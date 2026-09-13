import { defineConfig } from 'vite';

export default defineConfig({
  // map.js imports MapLibre's worker as its own bundle (?worker&url). MapLibre
  // starts it as a module worker ({ type: 'module' }), so emit it as ES.
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        eventGuide: 'event-guide.html',
        calendar: 'calendar.html',
        submission: 'event-submission.html',
        map: 'map.html',
        exhibitions: 'exhibitions.html',
      },
    },
  },
});
