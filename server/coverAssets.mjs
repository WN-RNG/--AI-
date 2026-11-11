import express from 'express';

/** Serve the current homepage pool independently of the bundled UI, so imports need no rebuild. */
export function mountCoverAssets(app, directory) {
  app.use(
    '/covers',
    express.static(directory, {
      index: false,
      dotfiles: 'deny',
      maxAge: '1h',
      setHeaders(response, file) {
        if (file.endsWith('.json')) response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
    (_request, response) => response.status(404).json({ error: 'Cover asset unavailable' }),
  );
}
