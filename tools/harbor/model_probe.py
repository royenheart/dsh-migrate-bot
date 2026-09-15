"""Record which model build served this experiment.

A model name is a request, not an identity. DeepSeek normalises the response
`model` (`deepseek-v4-flash` is answered as `deepseek-flash`), routes retired
aliases to current models, and gives no dated model id to pin — so the only
field that identifies the build actually serving requests is the response's
`system_fingerprint`. It changes when the backend configuration changes, and
without it two runs on the same model name are not comparable.

dsh does not surface that field: it reads the session log, not the HTTP
response, and no part of the harness carries the fingerprint. So the benchmark
asks the provider directly, once per invocation, with a one-token request, and
records what came back. That is a weaker claim than "the fingerprint of every
request in this run" and a much stronger one than "the model was called
deepseek-v4-flash".

    python3 tools/harbor/model_probe.py --model deepseek-v4-flash --out probe.json

The probe never raises: a provider that is unreachable, unauthenticated, or
answering with an unexpected shape produces a record with `error` set, because a
benchmark run must not fail for a missing optional field.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

#: The endpoint whose response carries the fingerprint.
DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions"

#: The model the benchmark runs. A retired alias on purpose: the response names
#: the model that actually served it.
DEFAULT_MODEL = "deepseek-v4-flash"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def probe(
    *,
    model: str = DEFAULT_MODEL,
    endpoint: str = DEFAULT_ENDPOINT,
    api_key: str | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Ask the provider once which build answers, and record what it said."""
    record: dict[str, Any] = {
        "requestedModel": model,
        "endpoint": endpoint,
        "probedAt": _now(),
        "servedModel": None,
        "systemFingerprint": None,
        "responseId": None,
        "created": None,
        "error": None,
    }
    key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
    if not key:
        record["error"] = "DEEPSEEK_API_KEY is not set, so the serving build was not identified"
        return record

    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": False,
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": "dsh-migrate-benchmark",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        record["error"] = f"HTTP {error.code} from the provider"
        return record
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        record["error"] = f"provider unreachable: {error}"
        return record
    except json.JSONDecodeError as error:
        record["error"] = f"provider returned a non-JSON body: {error}"
        return record

    if not isinstance(payload, dict):
        record["error"] = "provider returned an unexpected body shape"
        return record
    record["servedModel"] = payload.get("model")
    record["systemFingerprint"] = payload.get("system_fingerprint")
    record["responseId"] = payload.get("id")
    record["created"] = payload.get("created")
    if record["servedModel"] is None:
        record["error"] = "the response carried no model field"
    return record


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    record = probe(model=args.model, endpoint=args.endpoint, timeout=args.timeout)
    text = json.dumps(record, indent=2)
    if args.out is not None:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    if record["error"] is not None:
        print(f"model-probe: {record['error']}", file=sys.stderr)
    # A probe that could not identify the build is recorded, never fatal.
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
