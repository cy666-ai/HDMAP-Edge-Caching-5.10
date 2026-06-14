"""
HLR-Cache Edge Caching System — ReAct Agent FastAPI Server
Replaces the original Streamlit UI (app.py). Provides SSE streaming chat endpoint
for the Node.js backend to proxy to the Vue frontend.

Usage:
    python agent_server.py              # defaults to 0.0.0.0:8000
    AGENT_PORT=9000 python agent_server.py
"""

from __future__ import annotations

# ── Force IPv4 BEFORE any HTTP library import ──────────────────────────
# IPv6 to dashscope.aliyuncs.com takes 21s to timeout on this Windows host;
# this monkey-patch makes every Python HTTP client (httpx / requests / urllib)
# prefer IPv4 so LLM calls return in <2s instead of 42s.
import socket as _socket
_orig_getaddrinfo = _socket.getaddrinfo


def _getaddrinfo_v4(host, port, family=0, type=0, proto=0, flags=0):
    """Like socket.getaddrinfo but defaults to AF_INET (IPv4) when family==0."""
    if family == 0:
        family = _socket.AF_INET
    return _orig_getaddrinfo(host, port, family, type, proto, flags)


_socket.getaddrinfo = _getaddrinfo_v4
# ────────────────────────────────────────────────────────────────────────

import json
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os

from agent.react_agent import ReactAgent

app = FastAPI(title="HLR-Cache ReAct Agent", version="1.0.0")

# CORS — allow Node.js backend and direct dev access
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Single agent instance — created once at startup
agent = ReactAgent()


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []   # [{role: "user"|"assistant", content: "..."}]


@app.post("/chat")
async def chat(req: ChatRequest):
    """
    SSE streaming chat endpoint.
    Yields data: {"content": "...", "done": false} chunks, then a final {"done": true}.
    The Node.js backend reads this line-by-line and forwards via Socket.IO.
    """

    async def generate():
        try:
            async for chunk in agent.execute_stream_async(req.message):
                payload = json.dumps({"content": chunk, "done": False}, ensure_ascii=False)
                yield f"data: {payload}\n\n"
                await asyncio.sleep(0)
        except Exception as e:
            payload = json.dumps(
                {"content": f"[Agent Error] {str(e)}", "done": True, "error": True},
                ensure_ascii=False,
            )
            yield f"data: {payload}\n\n"
            return

        # Final done signal
        yield f"data: {json.dumps({'content': '', 'done': True})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",       # disable nginx buffering if proxied
        },
    )


@app.get("/health")
async def health():
    """Health check — called by Node.js chatService to verify agent is online."""
    return {"status": "ok", "service": "HLR-Cache ReAct Agent"}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("AGENT_HOST", "0.0.0.0")
    port = int(os.environ.get("AGENT_PORT", "8000"))

    print(f"[Agent Server] Starting HLR-Cache ReAct Agent on {host}:{port}")
    uvicorn.run(app, host=host, port=port)
