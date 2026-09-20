export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
