"""
memgw Hermes plugin (phase 5).
Plugs the Hermes Agent running on the VPS into the same memgw store that Claude Code
and claude.ai use.

Hermes lifecycle mapped onto the memgw HTTP API:
  prefetch(query)             -> GET /bootstrap + GET /search/facts  (sync, returns context)
  sync_turn(user, assistant)  -> POST /capture                       (fire-and-forget)
  on_session_end()            -> POST /flush                         (force distillation now)

Lesson taken from the TDAM hermes-plugin: keep the adapter thin, do no data processing,
just be an HTTP client + circuit breaker (5 consecutive failures then a 60s pause)
+ back-pressure (cap the number of writer threads), so that a dead memory store does
NOT take Hermes down with it.

Configured through env:
  MEMGW_URL     (defaults to http://127.0.0.1:8930 - same VPS, so call localhost)
  MEMGW_KEY     (required)
  MEMGW_SOURCE  (defaults to "hermes")
"""
import json
import os
import time
import threading
import urllib.request
import urllib.error
import urllib.parse

MEMGW_URL = os.environ.get("MEMGW_URL", "http://127.0.0.1:8930").rstrip("/")
MEMGW_KEY = os.environ.get("MEMGW_KEY", "")
MEMGW_SOURCE = os.environ.get("MEMGW_SOURCE", "hermes")

_TIMEOUT = 5
_MAX_INFLIGHT = 4               # back-pressure: at most 4 concurrent writes
_BREAKER_THRESHOLD = 5          # 5 consecutive failures
_BREAKER_COOLDOWN = 60          # pause for 60s


class _Breaker:
    def __init__(self):
        self.fails = 0
        self.open_until = 0.0
        self.lock = threading.Lock()

    def allow(self) -> bool:
        with self.lock:
            return time.time() >= self.open_until

    def ok(self):
        with self.lock:
            self.fails = 0

    def fail(self):
        with self.lock:
            self.fails += 1
            if self.fails >= _BREAKER_THRESHOLD:
                self.open_until = time.time() + _BREAKER_COOLDOWN
                self.fails = 0


_breaker = _Breaker()
_inflight = threading.Semaphore(_MAX_INFLIGHT)


def _req(method: str, path: str, body=None, timeout=_TIMEOUT):
    url = f"{MEMGW_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {MEMGW_KEY}")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def prefetch(query: str, session_id: str = "hermes") -> str:
    """Return the context block to inject into the Hermes system prompt. Empty on failure."""
    if not _breaker.allow():
        return ""
    try:
        boot = _req("GET", "/bootstrap")
        facts = _req("GET", f"/search/facts?q={urllib.parse.quote(query or '')}&limit=6")
        _breaker.ok()
    except Exception:
        _breaker.fail()
        return ""

    parts = ["<memgw-context>"]
    if boot.get("profile"):
        parts.append("## Profile\n" + boot["profile"])
    results = facts.get("results", [])
    if results:
        parts.append("## Relevant facts")
        parts += [f"- [{r['type']}] {r['content']}" for r in results]
    topics = boot.get("topics", [])
    if topics:
        parts.append("## Topic notes (read them through the tool when needed)")
        parts += [f"- {t['path']} : {t['summary']}" for t in topics]
    parts.append(boot.get("tools_guide", ""))
    parts.append("</memgw-context>")
    return "\n".join(p for p in parts if p)


def sync_turn(user_text: str, assistant_text: str, session_id: str = "hermes"):
    """Write one turn into L0. Fire-and-forget, never blocks Hermes."""
    if not (user_text or assistant_text):
        return
    ts = int(time.time() * 1000)
    messages = []
    if user_text:
        messages.append({"role": "user", "content": user_text, "ts": ts})
    if assistant_text:
        messages.append({"role": "assistant", "content": assistant_text, "ts": ts + 1})
    payload = {"source": MEMGW_SOURCE, "session_id": session_id, "messages": messages}

    def _send():
        if not _breaker.allow():
            return
        acquired = _inflight.acquire(blocking=False)
        if not acquired:
            return  # overloaded, skip this turn (memory is best-effort)
        try:
            _req("POST", "/capture", payload)
            _breaker.ok()
        except Exception:
            _breaker.fail()
        finally:
            _inflight.release()

    threading.Thread(target=_send, daemon=True).start()


def on_session_end(session_id: str = "hermes"):
    """Force the worker to distill the session that just ended. Skipped when the breaker is open."""
    if not _breaker.allow():
        return
    try:
        _req("POST", "/flush", {"session_id": session_id}, timeout=30)
        _breaker.ok()
    except Exception:
        _breaker.fail()


if __name__ == "__main__":
    # Quick self-test: needs a running server and a valid MEMGW_KEY.
    print("prefetch:", prefetch("test")[:120] or "(empty - server down or wrong key)")
    sync_turn("Remember: the Hermes plugin is wired into memgw", "OK, saved.", session_id="hermes-selftest")
    time.sleep(1)
    on_session_end("hermes-selftest")
    print("done")
