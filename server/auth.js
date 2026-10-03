const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/**
 * Authentication and Authorization Module
 * Handles user authentication and role-based access control with JWT bearer
 * tokens, verified directly with jsonwebtoken (0136; passport, passport-jwt
 * and passport-local were removed - they wrapped exactly this).
 */

// JWT Secret - In production, use environment variable
const JWT_SECRET = require('./authSecret');
const JWT_EXPIRY = '24h';

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// How users are looked up. routes/auth.js sets these at load; until then the
// user store is asked directly, so a route mounted without routes/auth.js still
// authenticates.
let lookupByUsername = async (username) => require('./db').users.getByUsername(username);
let checkPassword = async (password, hash) => verifyPassword(password, hash);
let lookupById = async (id) => require('./db').users.getById(id);

/** Where username/password sign-in finds a user and checks the password. */
function configureLocalStrategy(getUserByUsername, verifyUserPassword) {
    lookupByUsername = getUserByUsername;
    checkPassword = verifyUserPassword;
}

/** Where a bearer token's user is looked up (its role comes from the store, not the token). */
function configureJwtStrategy(getUserById) {
    lookupById = getUserById;
}

/**
 * Username/password sign-in, as passport-local did it: the credentials come
 * from the JSON body; either missing is "Missing credentials", an unknown user
 * or a wrong password "Invalid credentials". Resolves { user } or
 * { user: false, message }; a lookup or bcrypt failure rejects (a 500).
 */
async function authenticateCredentials(body) {
    const username = body?.username;
    const password = body?.password;
    if (!username || !password) return { user: false, message: 'Missing credentials' };
    const user = await lookupByUsername(username);
    if (!user) return { user: false, message: 'Invalid credentials' };
    const isValid = await checkPassword(password, user.passwordHash);
    if (!isValid) return { user: false, message: 'Invalid credentials' };
    return { user };
}

/** The token from `Authorization: Bearer <token>` (scheme case-insensitive), else null. */
function bearerToken(req) {
    const header = req.headers?.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/(\S+)\s+(\S+)/);
    return match && match[1].toLowerCase() === 'bearer' ? match[2] : null;
}

/**
 * The user a token names, or null when it does not verify, the user no longer
 * exists, or the device has been revoked. What passport-jwt's strategy did,
 * step for step. The role comes from the user store, never from the token, so
 * a demoted or deleted user loses access at once rather than at expiry.
 */
async function userFromToken(token) {
    if (!token || typeof token !== 'string') return null;
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }

    const user = await lookupById(payload.id);
    if (!user) return null;

    // Device tokens are long-lived by design, so revocation has to be
    // checked on use rather than left to expiry.
    if (payload.deviceId) {
        const deviceAuth = require('./services/deviceAuth');
        if (!deviceAuth.isDeviceValid(payload.deviceId)) return null;
        deviceAuth.touchDevice(payload.deviceId);
    }

    return {
        id: user.id,
        username: user.username,
        role: user.role,
        deviceId: payload.deviceId || null
    };
}

/** The user a request's bearer header names, or null (see userFromToken). */
async function userFromBearer(req) {
    return userFromToken(bearerToken(req));
}

/**
 * Middleware: require a valid bearer token. 401 "Unauthorized" (plain, as
 * passport answered) without one; a failing user lookup goes to Express's
 * error handler.
 */
function requireAuth(req, res, next) {
    userFromBearer(req).then((user) => {
        if (!user) {
            res.statusCode = 401;
            return res.end('Unauthorized');
        }
        req.user = user;
        next();
    }, next);
}

/** Middleware: set req.user when a valid bearer token is present; never refuses. */
function optionalAuth(req, res, next) {
    userFromBearer(req).then((user) => {
        if (user) req.user = user;
        next();
    }, () => next());
}

/**
 * Authenticate a stream request. Always enforced (R01): the media endpoints
 * (/api/proxy, /api/transcode, the recordings' media routes) serve only PigTV's
 * own clients, so there is no unauthenticated mode and no setting to turn it off.
 *
 * A media player cannot send an Authorization header: a <video src> and
 * AVPlayer both just issue a plain GET. So stream endpoints accept the token
 * as a query parameter instead, which is the usual answer and the reason those
 * URLs should be treated as bearer tokens in their own right (they are kept
 * out of logs by redact(), and every response carries Referrer-Policy:
 * no-referrer).
 *
 * The token is validated exactly as userFromBearer does (userFromToken): JWT
 * verified, user looked up in the store (the role is the store's, not the
 * token's), device revocation checked. Any failure, including a user-store
 * error, is a 401 JSON: a stream request is never let through unchecked.
 */
function streamAuth(req, res, next) {
    const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
    const token = queryToken || bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    userFromToken(token).then((user) => {
        if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    }, () => res.status(401).json({ error: 'Invalid or expired token' }));
}

/**
 * Middleware: Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }
    next();
}

/**
 * Middleware: Check for specific role
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Forbidden - ${role} access required` });
        }
        next();
    };
}

module.exports = {
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    configureLocalStrategy,
    configureJwtStrategy,
    authenticateCredentials,
    requireAuth,
    optionalAuth,
    streamAuth,
    requireAdmin,
    requireRole
};
