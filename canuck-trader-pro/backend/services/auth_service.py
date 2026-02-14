"""
JWT Authentication & Security Service
Secures the dashboard when running on a public VPS.

Features:
- JWT token generation/verification (HS256, pure Python — no external JWT lib)
- User management with PBKDF2 password hashing (stored in SQLite settings table)
- FastAPI middleware for protected endpoints
- API key support for programmatic access (Telegram bot, monitoring)
- Failed-login rate limiting (5 attempts / 15 min per IP)
- Security headers (nosniff, DENY framing, HSTS)
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("auth_service")

# ============================================
# CONSTANTS
# ============================================

ACCESS_TOKEN_TTL = 24 * 3600          # 24 hours
REFRESH_TOKEN_TTL = 7 * 24 * 3600     # 7 days
PBKDF2_ITERATIONS = 100_000
SALT_LENGTH = 32                       # bytes
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_WINDOW = 15 * 60         # 15 minutes (seconds)

# Endpoints that never require authentication
PUBLIC_PATHS: set[str] = {
    "/api/health",
    "/api/status",
    "/api/auth/login",
    "/api/auth/refresh",
    "/metrics",
    "/docs",
    "/openapi.json",
    "/redoc",
}

PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/ws/",          # WebSocket endpoints
    "/assets/",      # Static frontend assets
)


# ============================================
# JWT — Pure-Python HS256
# ============================================

def _b64url_encode(data: bytes) -> str:
    """Base64url encode without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    """Base64url decode with re-added padding."""
    padding = 4 - len(s) % 4
    if padding != 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


def _jwt_sign(payload: dict, secret: str) -> str:
    """Create a JWT (HS256) from *payload* using *secret*."""
    header = {"alg": "HS256", "typ": "JWT"}
    segments = [
        _b64url_encode(json.dumps(header, separators=(",", ":")).encode()),
        _b64url_encode(json.dumps(payload, separators=(",", ":")).encode()),
    ]
    signing_input = f"{segments[0]}.{segments[1]}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    segments.append(_b64url_encode(signature))
    return ".".join(segments)


def _jwt_decode(token: str, secret: str) -> Optional[dict]:
    """Verify and decode a JWT.  Returns the payload dict or None."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None

        signing_input = f"{parts[0]}.{parts[1]}".encode()
        expected_sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
        actual_sig = _b64url_decode(parts[2])

        if not hmac.compare_digest(expected_sig, actual_sig):
            logger.warning("JWT signature mismatch")
            return None

        payload = json.loads(_b64url_decode(parts[1]))

        # Check expiration
        if payload.get("exp", 0) < time.time():
            logger.debug("JWT expired")
            return None

        return payload
    except Exception as e:
        logger.warning(f"JWT decode error: {e}")
        return None


# ============================================
# PASSWORD HASHING (PBKDF2-HMAC-SHA256)
# ============================================

def _hash_password(password: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    """Hash *password* with PBKDF2-HMAC-SHA256.  Returns (hash_hex, salt_hex)."""
    if salt is None:
        salt = os.urandom(SALT_LENGTH)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return dk.hex(), salt.hex()


def _verify_password(password: str, stored_hash: str, stored_salt: str) -> bool:
    """Return True when *password* matches the stored hash+salt."""
    salt = bytes.fromhex(stored_salt)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return hmac.compare_digest(dk.hex(), stored_hash)


# ============================================
# AUTH SERVICE SINGLETON
# ============================================

class AuthService:
    """Central authentication / authorisation service.

    Users are persisted as JSON blobs in the SQLite ``settings`` table under
    keys prefixed with ``auth_user:``.  A separate ``auth_secret`` key stores
    the JWT signing secret so it survives restarts.
    """

    def __init__(self):
        # JWT signing secret — prefer env var, fall back to DB, then generate.
        self._secret: str = ""
        # Failed-login tracker: ip -> list of timestamps
        self._login_attempts: dict[str, list[float]] = defaultdict(list)
        # API key from env (optional)
        self._api_key: str = os.environ.get("API_KEY", "")
        self._initialized = False

    # ------------------------------------------------------------------
    # Initialisation (must be called after DB is ready)
    # ------------------------------------------------------------------

    def initialize(self):
        """Load or generate the JWT secret and ensure the default admin user exists."""
        if self._initialized:
            return

        # 1. Resolve signing secret
        env_secret = os.environ.get("DASHBOARD_SECRET", "")
        if env_secret:
            self._secret = env_secret
        else:
            # Try to load from DB
            try:
                from services.database_service import get_setting, set_setting
                stored = get_setting("auth_secret")
                if stored:
                    self._secret = stored
                else:
                    self._secret = secrets.token_hex(32)  # 64 hex chars
                    set_setting("auth_secret", self._secret)
                    logger.info("Generated new JWT signing secret (persisted to DB)")
            except Exception:
                # DB not available yet — generate ephemeral secret
                self._secret = secrets.token_hex(32)
                logger.warning("DB unavailable; using ephemeral JWT secret")

        # 2. Create default admin if no users exist
        try:
            users = self.list_users()
            if not users:
                self.create_user("admin", "admin", role="admin", force_password_change=True)
                logger.info("Default admin user created (admin/admin) — change password on first login")
        except Exception as e:
            logger.error(f"Default admin creation failed: {e}")

        # 3. Refresh API key from env (may have changed)
        self._api_key = os.environ.get("API_KEY", "")

        self._initialized = True
        logger.info("AuthService initialized")

    # ------------------------------------------------------------------
    # User CRUD (stored in settings table as JSON)
    # ------------------------------------------------------------------

    def _user_key(self, username: str) -> str:
        return f"auth_user:{username}"

    def _get_user_record(self, username: str) -> Optional[dict]:
        try:
            from services.database_service import get_setting
            raw = get_setting(self._user_key(username))
            if raw:
                return json.loads(raw)
        except Exception as e:
            logger.error(f"Error reading user {username}: {e}")
        return None

    def _save_user_record(self, username: str, record: dict):
        from services.database_service import set_setting
        set_setting(self._user_key(username), json.dumps(record))

    def create_user(
        self,
        username: str,
        password: str,
        role: str = "viewer",
        force_password_change: bool = False,
    ) -> dict:
        """Create a new dashboard user.  Raises ValueError if username taken."""
        if self._get_user_record(username):
            raise ValueError(f"User '{username}' already exists")

        pw_hash, pw_salt = _hash_password(password)
        record = {
            "user_id": secrets.token_hex(16),
            "username": username,
            "role": role,
            "password_hash": pw_hash,
            "password_salt": pw_salt,
            "force_password_change": force_password_change,
            "created_at": int(time.time()),
            "last_login": None,
        }
        self._save_user_record(username, record)
        logger.info(f"User created: {username} (role={role})")
        return self._sanitize_user(record)

    def verify_password(self, username: str, password: str) -> Optional[dict]:
        """Return sanitised user dict if credentials are correct, else None."""
        record = self._get_user_record(username)
        if not record:
            return None
        if _verify_password(password, record["password_hash"], record["password_salt"]):
            return record
        return None

    def change_password(self, username: str, old_password: str, new_password: str) -> bool:
        """Change a user's password.  Returns True on success."""
        record = self._get_user_record(username)
        if not record:
            raise ValueError("User not found")
        if not _verify_password(old_password, record["password_hash"], record["password_salt"]):
            raise ValueError("Current password is incorrect")
        if len(new_password) < 8:
            raise ValueError("New password must be at least 8 characters")

        pw_hash, pw_salt = _hash_password(new_password)
        record["password_hash"] = pw_hash
        record["password_salt"] = pw_salt
        record["force_password_change"] = False
        self._save_user_record(username, record)
        logger.info(f"Password changed for user: {username}")
        return True

    def list_users(self) -> list[dict]:
        """Return all dashboard users (without password fields)."""
        try:
            from services.database_service import get_all_settings
            all_settings = get_all_settings()
            users = []
            for row in all_settings:
                if row["key"].startswith("auth_user:"):
                    try:
                        record = json.loads(row["value"])
                        users.append(self._sanitize_user(record))
                    except Exception:
                        pass
            return users
        except Exception as e:
            logger.error(f"Error listing users: {e}")
            return []

    @staticmethod
    def _sanitize_user(record: dict) -> dict:
        """Strip sensitive fields before returning user data."""
        return {
            "user_id": record.get("user_id"),
            "username": record.get("username"),
            "role": record.get("role"),
            "force_password_change": record.get("force_password_change", False),
            "created_at": record.get("created_at"),
            "last_login": record.get("last_login"),
        }

    # ------------------------------------------------------------------
    # Token creation / verification
    # ------------------------------------------------------------------

    def create_token(self, user_id: str, role: str) -> dict:
        """Return ``{access_token, refresh_token, expires_in}``."""
        now = time.time()

        access_payload = {
            "user_id": user_id,
            "role": role,
            "type": "access",
            "iat": int(now),
            "exp": int(now + ACCESS_TOKEN_TTL),
        }
        refresh_payload = {
            "user_id": user_id,
            "role": role,
            "type": "refresh",
            "iat": int(now),
            "exp": int(now + REFRESH_TOKEN_TTL),
        }

        return {
            "access_token": _jwt_sign(access_payload, self._secret),
            "refresh_token": _jwt_sign(refresh_payload, self._secret),
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_TTL,
        }

    def verify_token(self, token: str) -> Optional[dict]:
        """Decode and verify a JWT.  Returns the payload or None."""
        return _jwt_decode(token, self._secret)

    # ------------------------------------------------------------------
    # Full authentication flow
    # ------------------------------------------------------------------

    def authenticate(self, username: str, password: str) -> Optional[dict]:
        """Verify credentials and return ``{access_token, refresh_token, user}`` or None."""
        record = self.verify_password(username, password)
        if not record:
            return None

        # Update last_login
        record["last_login"] = int(time.time())
        self._save_user_record(username, record)

        tokens = self.create_token(record["user_id"], record["role"])
        return {
            **tokens,
            "user": self._sanitize_user(record),
        }

    # ------------------------------------------------------------------
    # API key validation
    # ------------------------------------------------------------------

    def verify_api_key(self, key: str) -> bool:
        """Check whether *key* matches the configured API_KEY env var."""
        if not self._api_key:
            return False
        return hmac.compare_digest(key, self._api_key)

    # ------------------------------------------------------------------
    # Rate limiting for failed logins
    # ------------------------------------------------------------------

    def _clean_attempts(self, ip: str):
        now = time.time()
        self._login_attempts[ip] = [
            t for t in self._login_attempts[ip]
            if t > now - LOGIN_LOCKOUT_WINDOW
        ]

    def record_failed_login(self, ip: str):
        self._login_attempts[ip].append(time.time())

    def is_login_locked(self, ip: str) -> bool:
        self._clean_attempts(ip)
        return len(self._login_attempts[ip]) >= LOGIN_MAX_ATTEMPTS

    def clear_login_attempts(self, ip: str):
        self._login_attempts.pop(ip, None)

    def get_lockout_remaining(self, ip: str) -> int:
        """Seconds remaining on the lockout (0 if not locked)."""
        self._clean_attempts(ip)
        attempts = self._login_attempts[ip]
        if len(attempts) < LOGIN_MAX_ATTEMPTS:
            return 0
        oldest_relevant = attempts[-LOGIN_MAX_ATTEMPTS]
        remaining = LOGIN_LOCKOUT_WINDOW - (time.time() - oldest_relevant)
        return max(0, int(remaining))


# ============================================
# SINGLETON
# ============================================

_auth_service: Optional[AuthService] = None


def get_auth_service() -> AuthService:
    """Return (and lazily create) the global AuthService singleton."""
    global _auth_service
    if _auth_service is None:
        _auth_service = AuthService()
    return _auth_service


# ============================================
# FASTAPI MIDDLEWARE
# ============================================

def _is_public_path(path: str) -> bool:
    """Return True if *path* should bypass JWT / API-key checks."""
    if path in PUBLIC_PATHS:
        return True
    for prefix in PUBLIC_PATH_PREFIXES:
        if path.startswith(prefix):
            return True
    # Static file extensions served from dist/ (SPA)
    if not path.startswith("/api/"):
        return True
    return False


async def auth_middleware(request: Request, call_next):
    """FastAPI HTTP middleware that enforces authentication on protected routes.

    Checks (in order):
    1. Public path   -> pass through
    2. X-API-Key     -> validate static API key
    3. Authorization: Bearer <jwt> -> validate JWT

    On success, ``request.state.user`` is populated with the token payload.
    """
    svc = get_auth_service()

    # Ensure service is initialised (safe to call repeatedly)
    if not svc._initialized:
        try:
            svc.initialize()
        except Exception:
            pass  # will initialise on next startup event

    path = request.url.path

    # 1. Public paths — no auth required
    if _is_public_path(path):
        response = await call_next(request)
        _add_security_headers(response)
        return response

    # 2. API key (X-API-Key header)
    api_key = request.headers.get("X-API-Key", "")
    if api_key and svc.verify_api_key(api_key):
        request.state.user = {"user_id": "api_key_user", "role": "admin", "type": "api_key"}
        response = await call_next(request)
        _add_security_headers(response)
        return response

    # 3. Bearer token
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        payload = svc.verify_token(token)
        if payload and payload.get("type") == "access":
            request.state.user = payload
            response = await call_next(request)
            _add_security_headers(response)
            return response

    # Authentication failed
    return JSONResponse(
        status_code=401,
        content={
            "error": "authentication_required",
            "message": "Valid authentication is required. "
                       "Provide a Bearer token in the Authorization header "
                       "or a valid X-API-Key header.",
        },
        headers=_security_headers_dict(),
    )


def _add_security_headers(response):
    """Append hardening headers to an existing response object."""
    for key, value in _security_headers_dict().items():
        response.headers[key] = value


def _security_headers_dict() -> dict[str, str]:
    """Return the security headers to apply to every response."""
    return {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "X-XSS-Protection": "1; mode=block",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    }


def get_auth_middleware():
    """Return the middleware callable for ``app.middleware('http')(...)``."""
    return auth_middleware


# ============================================
# FASTAPI AUTH ROUTES (/api/auth/*)
# ============================================

class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class RefreshRequest(BaseModel):
    refresh_token: str


def get_auth_router() -> APIRouter:
    """Build and return the ``/api/auth`` router."""
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    @router.post("/login")
    async def login(req: LoginRequest, request: Request):
        svc = get_auth_service()
        ip = request.client.host if request.client else "unknown"

        # Rate-limit check
        if svc.is_login_locked(ip):
            remaining = svc.get_lockout_remaining(ip)
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed login attempts. Try again in {remaining} seconds.",
            )

        result = svc.authenticate(req.username, req.password)
        if not result:
            svc.record_failed_login(ip)
            attempts_left = LOGIN_MAX_ATTEMPTS - len(
                [t for t in svc._login_attempts[ip] if t > time.time() - LOGIN_LOCKOUT_WINDOW]
            )
            raise HTTPException(
                status_code=401,
                detail=f"Invalid username or password. {max(0, attempts_left)} attempts remaining.",
            )

        # Success — clear lockout counter
        svc.clear_login_attempts(ip)
        return result

    @router.post("/refresh")
    async def refresh(req: RefreshRequest):
        svc = get_auth_service()
        payload = svc.verify_token(req.refresh_token)

        if not payload or payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token.")

        # Issue a fresh access token (same user/role)
        tokens = svc.create_token(payload["user_id"], payload["role"])
        return {"access_token": tokens["access_token"], "token_type": "Bearer", "expires_in": tokens["expires_in"]}

    @router.post("/change-password")
    async def change_password(req: ChangePasswordRequest, request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Authentication required.")

        # Resolve username from user_id
        svc = get_auth_service()
        users = svc.list_users()
        target_user = next((u for u in users if u["user_id"] == user["user_id"]), None)
        if not target_user:
            raise HTTPException(status_code=404, detail="User not found.")

        try:
            svc.change_password(target_user["username"], req.old_password, req.new_password)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        return {"success": True, "message": "Password changed successfully."}

    @router.get("/me")
    async def me(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Authentication required.")

        svc = get_auth_service()
        users = svc.list_users()
        target_user = next((u for u in users if u["user_id"] == user["user_id"]), None)
        if not target_user:
            # API key user
            if user.get("type") == "api_key":
                return {"user_id": "api_key_user", "username": "api_key", "role": "admin"}
            raise HTTPException(status_code=404, detail="User not found.")

        return target_user

    return router
