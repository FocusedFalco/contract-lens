// Vercel serverless entry: the whole Express app is one function; /api/* is rewritten here (see vercel.json).
import app from '../server/app.js';
export default app;
