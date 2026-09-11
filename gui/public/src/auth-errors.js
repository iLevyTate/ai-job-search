export function isExpiredAuthError(text) {
  return /oauth session expired|could not be refreshed|failed to authenticate|not logged in|please (run )?\/login/i
    .test(String(text || ""));
}
