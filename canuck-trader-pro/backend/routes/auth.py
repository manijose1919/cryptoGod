"""
Auth Routes
/api/login - Crypto.com auth, balance fetch, session creation
/api/test-connection - Connection test
/api/ws-auth - WebSocket auth token generation
"""

import hashlib
import hmac
import os
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.session_manager import create_session, get_session

router = APIRouter()

API_BASE_URL = "https://api.crypto.com/exchange/v1/"


class LoginRequest(BaseModel):
    apiKey: str
    secretKey: str


class TestConnectionRequest(BaseModel):
    apiKey: str
    secretKey: str


def _params_to_str(obj: dict, level: int = 0) -> str:
    if level >= 3:
        return str(obj)
    result = ""
    for key in sorted(obj.keys()):
        result += key
        val = obj[key]
        if val is None:
            result += "null"
        elif isinstance(val, list):
            for item in val:
                if isinstance(item, dict):
                    result += _params_to_str(item, level + 1)
                else:
                    result += str(item)
        elif isinstance(val, dict):
            result += _params_to_str(val, level + 1)
        else:
            result += str(val)
    return result


def _generate_signature(method: str, req_id: int, api_key: str, secret_key: str, params: dict, nonce: int) -> str:
    param_str = _params_to_str(params) if params else ""
    sig_payload = method + str(req_id) + api_key + param_str + str(nonce)
    return hmac.new(secret_key.encode(), sig_payload.encode(), hashlib.sha256).hexdigest()


async def _make_signed_request(method: str, params: dict, api_key: str, secret_key: str) -> dict:
    req_id = int(time.time() * 1000)
    nonce = int(time.time() * 1000)
    sig = _generate_signature(method, req_id, api_key, secret_key, params, nonce)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{API_BASE_URL}{method}",
            json={
                "id": req_id,
                "method": method,
                "api_key": api_key,
                "params": params,
                "sig": sig,
                "nonce": nonce,
            },
        )
        data = resp.json()

    if data.get("code") != 0:
        raise RuntimeError(data.get("message", "API error"))
    return data.get("result", {})


@router.post("/api/login")
async def login(req: LoginRequest):
    try:
        # Verify credentials by fetching balance
        result = await _make_signed_request(
            "private/user-balance", {}, req.apiKey, req.secretKey
        )

        # Create session
        session_id = create_session(req.apiKey, req.secretKey)

        # Also store in env for the trading engine
        os.environ["SESSION_API_KEY"] = req.apiKey
        os.environ["SESSION_SECRET_KEY"] = req.secretKey

        # Parse balances
        balances = result.get("data", [])
        wallet = {}
        for item in balances:
            currency = item.get("currency", "")
            available = float(item.get("available", 0))
            if available > 0:
                wallet[currency] = available

        return {
            "success": True,
            "sessionId": session_id,
            "balance": wallet,
            "rawBalance": balances,
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@router.post("/api/test-connection")
async def test_connection(req: TestConnectionRequest):
    try:
        result = await _make_signed_request(
            "private/user-balance", {}, req.apiKey, req.secretKey
        )
        return {"success": True, "message": "Connection successful"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@router.get("/api/ws-auth")
async def ws_auth():
    # Generate a simple auth token for WebSocket
    token = os.urandom(16).hex()
    return {"token": token}
