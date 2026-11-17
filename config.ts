// Shared constants for the forge. Everything time-derived is fixed: two runs on the
// same instance must behave identically, so server-created commits and records carry a
// constant timestamp instead of the wall clock.

/** The token owner. The trial's scenario is deterministic (one fixed seed), so the
 *  viewer login is always this; the bearer token itself carries no login. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The bearer token the suite presents. In a trial it comes from MAKEFUN_SHOP_TOKEN;
 *  locally it falls back to a dev token so the server still enforces auth. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? 'dev-token';

/** Fixed epoch (seconds) for every commit and record this server creates. */
export const FIXED_EPOCH_SEC = 1700000000;

/** The same instant as an ISO string, for REST created_at / updated_at / merged_at. */
export const FIXED_ISO = '2023-11-14T22:13:20Z';

/** Identity line for server-created commits (`Name <email>`). */
export const GIT_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** The default branch every repository is created with. */
export const DEFAULT_BRANCH = 'main';

/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
