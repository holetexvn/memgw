"""Hermes plugin self-test: call prefetch/sync_turn/on_session_end against the real test server."""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hermes-plugin"))
import memgw_hermes as m

ctx = m.prefetch("memgw")
assert "<memgw-context>" in ctx, f"prefetch returned no context: {ctx!r}"
assert "memgw" in ctx.lower(), "prefetch returned no relevant content"
print("  prefetch OK, len =", len(ctx))

m.sync_turn("Nhớ giùm: Hermes đã cắm memgw ngày hôm nay",
            "Đã ghi nhận.", session_id="hermes-selftest")
time.sleep(1.5)  # fire-and-forget, wait for the writer thread

# check the event landed, by searching for it
import urllib.request, json
req = urllib.request.Request(f"{m.MEMGW_URL}/search/events?q=Hermes%20cam%20memgw",
                             headers={"Authorization": f"Bearer {m.MEMGW_KEY}"})
data = json.loads(urllib.request.urlopen(req, timeout=5).read())
assert any("Hermes" in r["content"] for r in data["results"]), "sync_turn failed to write the event"
print("  sync_turn OK, events =", len(data["results"]))

m.on_session_end("hermes-selftest")
print("  on_session_end OK")

# circuit breaker: point at a dead port, prefetch must return empty instead of crashing
m.MEMGW_URL = "http://127.0.0.1:59999"
for _ in range(6):
    assert m.prefetch("x") == "", "breaker: prefetch should return empty when the server is dead"
print("  circuit breaker OK (no crash when the server is dead)")
print("PLUGIN SELFTEST: ALL OK")
