const ADMIN_USER = {
  id: 1,
  username: 'admin',
  role: 'admin' as const,
};

export function getCurrentUser() {
  return ADMIN_USER;
}

export function requireAdmin() {
  return ADMIN_USER;
}
