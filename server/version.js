/**
 * Single source of truth for which build this is.
 *
 * The recurring problem this solves: a patch ships, the image is rebuilt, and
 * there is no reliable way to tell from a running server (or a client talking
 * to it) whether the code in front of you is actually the code you just built.
 * 0046 and 0047 shipped with a stale version badge for exactly this reason.
 *
 *   version  product semver, from package.json. Bumped for real releases.
 *   build    the patch number of the last applied patch. Bumped by every
 *            patch in its OWN diff, so this number can never lag the code it
 *            is running. This is the field that answers "is the deployed
 *            image the one I just built?".
 *   commit   short git SHA, injected at image-build time when available
 *            (see the PIGTV_COMMIT arg in the Dockerfile). Defaults to 'dev'
 *            for a local run, so nothing here depends on it being present.
 *   builtAt  ISO timestamp, injected the same way; null when not provided.
 *   display  a ready-to-render string, so every client shows the same thing
 *            without reimplementing the formatting.
 *
 * Unauthenticated consumers (the webapp badge, a client's "connecting to…"
 * screen) read this via GET /api/version before they have a token. Nothing
 * here is sensitive.
 */

const pkg = require('../package.json');

// Bumped by each patch to its own number. Four-digit string to match the
// patch filenames (0048, 0049, ...). Env override exists only so an image
// build can stamp it without editing source; the committed value is the
// normal path.
const BUILD = '0059';

const version = pkg.version;
const build = process.env.PIGTV_BUILD || BUILD;
const commit = process.env.PIGTV_COMMIT || 'dev';
const builtAt = process.env.PIGTV_BUILT_AT || null;

const commitSuffix = commit && commit !== 'dev' ? ` (${commit})` : '';
const display = `v${version} · build ${build}${commitSuffix}`;

module.exports = { version, build, commit, builtAt, display };
