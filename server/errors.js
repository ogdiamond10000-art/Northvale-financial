'use strict';

class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || 'error';
    this.details = details || undefined;
  }
}

function badRequest(message, code, details) {
  return new AppError(400, message, code || 'invalid_request', details);
}

function unauthorized(message = 'You need to sign in to continue.', code = 'unauthorized') {
  return new AppError(401, message, code);
}

function forbidden(message = 'You do not have permission to do that.', code = 'forbidden') {
  return new AppError(403, message, code);
}

function notFound(message = 'Not found.', code = 'not_found') {
  return new AppError(404, message, code);
}

function conflict(message, code = 'conflict') {
  return new AppError(409, message, code);
}

/**
 * Express 4 does not forward rejected promises from async handlers to the error
 * middleware, so an awaited failure would escape as an unhandled rejection and
 * terminate the process. Wrapping forwards it to `next` instead.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, asyncHandler };
