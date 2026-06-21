import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        eventGuide: 'event-guide.html',
        calendar: 'calendar.html',
        submission: 'event-submission.html',
      },
    },
  },
});
