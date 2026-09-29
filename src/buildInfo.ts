/**
 * When this build was packaged (UTC). Shown in the footer so it's obvious
 * whether a device is running the latest deploy or a stale cached copy.
 *
 * Deliberately a plain constant in src/ rather than injected by the bundler
 * config: updates are delivered by replacing only src/ (and the README), so
 * anything that depended on a file outside src/ would silently be missing --
 * and a reference to a bundler-injected global that isn't defined crashes the
 * whole app on load. This file is rewritten at packaging time.
 */
export const BUILD_LABEL = '2026-09-28 16:06 UTC';
