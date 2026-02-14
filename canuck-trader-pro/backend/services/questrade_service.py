"""
Questrade API Service
Port of services/questradeService.js.

Handles OAuth2 authentication, trading endpoints, and market data for Questrade.
"""

import json
import logging
import os
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone

import httpx

logger = logging.getLogger("questrade")

INTERVAL_MAP = {
    "1m": "OneMinute", "2m": "TwoMinutes", "3m": "ThreeMinutes",
    "5m": "FiveMinutes", "10m": "TenMinutes", "15m": "FifteenMinutes",
    "20m": "TwentyMinutes", "30m": "HalfHour", "1h": "OneHour",
    "2h": "TwoHours", "4h": "FourHours", "1d": "OneDay",
    "1w": "OneWeek", "1M": "OneMonth",
}


class QuestradeService:
    def __init__(self, is_practice: bool = False):
        self.refresh_token = os.environ.get("QUESTRADE_REFRESH_TOKEN", "")
        self.access_token: str | None = None
        self.api_url: str | None = None
        self.is_practice = is_practice
        self.token_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "questrade_tokens.json")
        self.token_expiry: float = 0

        self.symbol_id_cache: dict[str, int] = {}
        self.symbol_cache: dict[str, list] = {}
        self.symbol_cache_time: dict[str, float] = {}

        self._load_tokens()

    def _load_tokens(self):
        try:
            if os.path.exists(self.token_path):
                with open(self.token_path) as f:
                    data = json.load(f)
                self.refresh_token = data.get("refresh_token", self.refresh_token)
                self.access_token = data.get("access_token")
                self.api_url = data.get("api_url")
                self.token_expiry = data.get("token_expiry", 0)
        except Exception as e:
            logger.error(f"Failed to load tokens: {e}")

    def _save_tokens(self, data: dict):
        try:
            token_data = {
                "refresh_token": data["refresh_token"],
                "access_token": data["access_token"],
                "api_url": data["api_url"],
                "token_expiry": time.time() + data["expires_in"],
            }
            with open(self.token_path, "w") as f:
                json.dump(token_data, f, indent=2)
            self.refresh_token = token_data["refresh_token"]
            self.access_token = token_data["access_token"]
            self.api_url = token_data["api_url"]
            self.token_expiry = token_data["token_expiry"]
        except Exception as e:
            logger.error(f"Failed to save tokens: {e}")

    def is_authenticated(self) -> bool:
        return bool(
            self.access_token
            and self.token_expiry
            and time.time() < self.token_expiry - 60
            and self.api_url
        )

    async def authenticate(self, refresh_token_override: str | None = None):
        if refresh_token_override:
            self.refresh_token = refresh_token_override

        if self.is_authenticated():
            return

        if not self.refresh_token:
            raise ValueError("Questrade Refresh Token is missing.")

        base = "https://practicelogin.questrade.com" if self.is_practice else "https://login.questrade.com"
        url = f"{base}/oauth2/token?grant_type=refresh_token&refresh_token={self.refresh_token}"

        async with httpx.AsyncClient() as client:
            resp = await client.post(url)
            if resp.status_code != 200:
                raise RuntimeError(f"Questrade auth failed: {resp.text}")
            data = resp.json()

        self._save_tokens({
            "access_token": data["access_token"],
            "refresh_token": data["refresh_token"],
            "api_url": data["api_server"],
            "expires_in": data["expires_in"],
        })
        logger.info(f"Authenticated ({'Practice' if self.is_practice else 'Live'})")

    async def request(self, endpoint: str, method: str = "GET", body: dict | None = None) -> dict:
        await self.authenticate()
        url = f"{self.api_url}v1/{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient() as client:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                resp = await client.request(method, url, headers=headers, json=body)

        if resp.status_code != 200:
            raise RuntimeError(f"Questrade API Error [{endpoint}]: {resp.status_code} - {resp.text}")
        return resp.json()

    def map_interval(self, interval: str) -> str:
        return INTERVAL_MAP.get(interval, interval)

    def normalize_candles(self, raw_candles: list[dict]) -> list[dict]:
        if not raw_candles:
            return []
        result = []
        for c in raw_candles:
            ts = c.get("start") or c.get("end") or ""
            try:
                t = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                t = 0
            result.append({
                "t": t, "o": c.get("open", 0), "h": c.get("high", 0),
                "l": c.get("low", 0), "c": c.get("close", 0),
                "v": c.get("volume", 0), "vwap": c.get("VWAP") or c.get("vwap") or 0,
            })
        return result

    async def get_candles(self, symbol_id: int, interval: str = "OneMinute",
                          start_time: str | None = None, end_time: str | None = None) -> list[dict]:
        if not start_time:
            start_time = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        if not end_time:
            end_time = datetime.now(timezone.utc).isoformat()
        endpoint = f"markets/candles/{symbol_id}?startTime={start_time}&endTime={end_time}&interval={self.map_interval(interval)}"
        data = await self.request(endpoint)
        return data.get("candles", [])

    async def get_candles_by_ticker(self, ticker: str, interval: str = "1m",
                                     start_time: str | None = None, end_time: str | None = None) -> list[dict]:
        sid = await self.get_symbol_id(ticker)
        raw = await self.get_candles(sid, interval, start_time, end_time)
        return self.normalize_candles(raw)

    async def get_quote(self, symbol_id: int) -> dict | None:
        data = await self.request(f"markets/quotes/{symbol_id}")
        quotes = data.get("quotes", [])
        return quotes[0] if quotes else None

    async def get_quotes(self, symbol_ids: list[int]) -> list[dict]:
        ids = ",".join(str(s) for s in symbol_ids)
        data = await self.request(f"markets/quotes?ids={ids}")
        return data.get("quotes", [])

    async def search_symbol(self, prefix: str) -> list[dict]:
        data = await self.request(f"symbols/search?prefix={prefix}")
        return data.get("symbols", [])

    async def get_symbol_id(self, ticker: str) -> int:
        if ticker in self.symbol_id_cache:
            return self.symbol_id_cache[ticker]
        symbols = await self.search_symbol(ticker)
        match = next((s for s in symbols if s["symbol"] == ticker), None)
        if not match:
            raise ValueError(f"Symbol {ticker} not found on Questrade")
        self.symbol_id_cache[ticker] = match["symbolId"]
        return match["symbolId"]

    async def get_accounts(self) -> list[dict]:
        data = await self.request("accounts")
        return data.get("accounts", [])

    async def get_balance(self, account_id: str) -> dict:
        data = await self.request(f"accounts/{account_id}/balances")
        return data

    async def get_positions(self, account_id: str) -> list[dict]:
        data = await self.request(f"accounts/{account_id}/positions")
        return data.get("positions", [])

    async def place_order(self, account_id: str, order: dict) -> dict:
        return await self.request(f"accounts/{account_id}/orders", method="POST", body=order)

    def get_status(self) -> dict:
        return {
            "authenticated": self.is_authenticated(),
            "is_practice": self.is_practice,
            "api_url": self.api_url or "",
            "token_expiry": self.token_expiry,
            "cached_symbols": len(self.symbol_id_cache),
        }
