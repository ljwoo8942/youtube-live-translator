from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


HEALTH_URL = "http://127.0.0.1:8765/health"
HEALTH_TIMEOUT_SECONDS = 60


def main() -> int:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=HEALTH_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
            print(body)
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                return 1
            return 0 if response.status == 200 and payload.get("ok") is True else 1
    except (OSError, urllib.error.URLError) as exc:
        print(
            "STT server is not reachable at http://127.0.0.1:8765. "
            "Keep `npm run stt:start` running in a separate terminal, then retry. "
            f"The first health check can take up to {HEALTH_TIMEOUT_SECONDS}s while the model loads. "
            f"Original error: {exc}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
