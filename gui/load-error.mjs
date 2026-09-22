/**
 * Electron rejects loadFile/loadURL with ERR_ABORTED (-3) when a later
 * navigation cancels an in-flight one. The splash page does that on every
 * normal start. That is not a failed launch.
 */
export function isNavigationAbort(err) {
  if (!err) return false;
  if (err.errno === -3 || err.code === "ERR_ABORTED") return true;
  const text = String(err.message || err);
  return /\(-3\)/.test(text) || /ERR_ABORTED/i.test(text);
}

export async function ignoreNavigationAbort(loader) {
  try {
    await loader();
  } catch (err) {
    if (!isNavigationAbort(err)) throw err;
  }
}
