export function readProfileId() {
  return document.cookie.match(/(?:^|; )profileId=([^;]+)/)?.[1] ?? '';
}

export function clearProfileCookie() {
  document.cookie = 'profileId=; Path=/; Max-Age=0; SameSite=Lax';
}
