class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}

function notFound(code, message) {
  return new AppError(404, code, message);
}

module.exports = { AppError, badRequest, notFound };
