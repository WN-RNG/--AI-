/** Remember only that this browser has authenticated; never store credentials or user details. */
const preferenceKey = 'light-frame.authenticated';
let authenticatedThisSession = false;

export function shouldStartWithRegistration(): boolean {
  if (authenticatedThisSession) return false;
  try {
    return localStorage.getItem(preferenceKey) !== '1';
  } catch {
    return true;
  }
}

export function rememberAuthentication(): void {
  authenticatedThisSession = true;
  try {
    localStorage.setItem(preferenceKey, '1');
  } catch {
    // Authentication still succeeds when the browser disables local storage.
  }
}
