// Vercel serverless entry: the whole Express app is one function; /api/* is rewritten here (see vercel.json).
// The app is imported lazily so that a startup failure is reported as readable JSON instead of a blank 500.
let app;
export default async function handler(req, res) {
  try {
    app ??= (await import('../server/app.js')).default;
    return app(req, res);
  } catch (e) {
    console.error('ContractLens failed to start:', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: `Server failed to start: ${e.message}` }));
  }
}
