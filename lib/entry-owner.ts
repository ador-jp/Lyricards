const OWNER_COOKIE = 'lyricards_owner';
export const ENTRY_OWNER_HEADER = 'x-lyricards-entry-owner';

export function readEntryOwner(cookies: string | null): string | null {
  const prefix = `${OWNER_COOKIE}=`;
  const cookie = cookies?.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return cookie?.slice(prefix.length) || null;
}

export function entryOwnerCookie(owner: string) {
  return `${OWNER_COOKIE}=${owner}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}
