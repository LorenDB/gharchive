import { AsyncLocalStorage } from 'async_hooks';

/** Reserved id for no-auth autologin admin data. */
export const AUTOLOGIN_USER_ID = 'autologin';

type Store = { userId: string };

const als = new AsyncLocalStorage<Store>();

/** Run `fn` with all db ops scoped to `userId` (async-safe). */
export function runAsUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

export async function runAsUserAsync<T>(
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  return als.run({ userId }, fn);
}

/**
 * Bind the current async continuation to `userId` (for handlers that
 * already `await`ed auth before calling into the db).
 */
export function enterUserContext(userId: string): void {
  als.enterWith({ userId });
}

export function tryGetUserId(): string | undefined {
  return als.getStore()?.userId;
}

/** Current actor; throws if no user context is active. */
export function getRequiredUserId(): string {
  const id = tryGetUserId();
  if (!id) {
    throw new Error(
      'No user context — call ensureApiAuth / runAsUser before accessing user data'
    );
  }
  return id;
}

/** Sanitize OIDC sub (or similar) for filesystem paths. */
export function safeUserPathSegment(userId: string): string {
  const s = userId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return (s || 'user').slice(0, 80);
}
