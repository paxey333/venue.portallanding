const API_BASE_URL = 'https://venue-portal-api.paxey333.workers.dev';
const TOKEN_KEY = 'venuePortalToken';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (auth) {
    const token = getToken();
    if (!token) {
      throw new Error('Missing auth token');
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && (payload.error || payload.message)) ||
      (typeof payload === 'string' && payload) ||
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export {
  API_BASE_URL,
  TOKEN_KEY,
  getToken,
  setToken,
  clearToken,
  request
};

export const login = (email, password) =>
  request('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });

export const setPassword = (password) =>
  request('/api/auth/set-password', {
    method: 'POST',
    auth: true,
    body: { password }
  });

export const getVenues = () => request('/api/venues');

export const getVenue = (id) => request(`/api/venues/${id}`);

export const createVenue = (venue) =>
  request('/api/venues', {
    method: 'POST',
    auth: true,
    body: venue
  });

export const updateVenue = (id, venue) =>
  request(`/api/venues/${id}`, {
    method: 'PUT',
    auth: true,
    body: venue
  });

export const deleteVenue = (id) =>
  request(`/api/venues/${id}`, {
    method: 'DELETE',
    auth: true
  });

export const createBooking = (booking) =>
  request('/api/bookings', {
    method: 'POST',
    body: booking
  });

export const getBookings = () =>
  request('/api/bookings', {
    auth: true
  });

export const updateBookingStatus = (id, status) =>
  request(`/api/bookings/${id}/status`, {
    method: 'PATCH',
    auth: true,
    body: { status }
  });

export const deleteBooking = (id) =>
  request(`/api/bookings/${id}`, {
    method: 'DELETE',
    auth: true
  });
