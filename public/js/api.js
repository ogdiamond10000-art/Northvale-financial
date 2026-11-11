/**
 * Thin JSON client for the Northvale Financial API.
 * All requests are same-origin and rely on the httpOnly session cookie.
 */

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || 'error';
    this.details = details || null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('We could not reach Northvale. Check your connection and try again.', { status: 0, code: 'network_error' });
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new ApiError((data && data.message) || 'Something went wrong. Please try again.', {
      status: response.status,
      code: data && data.code,
      details: data && data.details,
    });
  }
  return data;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body: body || {} }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body: body || {} }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

/** Download a server-rendered receipt (text/plain attachment) without leaving the app. */
export async function downloadReceipt(transactionId, reference) {
  const response = await fetch(`/api/account/transactions/${encodeURIComponent(transactionId)}/receipt`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new ApiError('The receipt could not be generated.', { status: response.status });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `northvale-receipt-${reference || transactionId}.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
