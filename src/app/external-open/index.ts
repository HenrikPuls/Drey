/**
 * `src/app/external-open` -- files the OS hands to Drey (Explorer "Open
 * with" / a default-program association, ADR-0054): `ExternalOpenService`
 * routes each to a vault tab or a pinned external tab (saved in place).
 *
 * This barrel is the module's public surface -- code outside the module
 * imports from `../external-open`, never a file inside it (enforced by
 * `eslint.config.mjs`).
 */

export { ExternalOpenService } from './external-open.service';
