"""Opt-in check against an installed, real Hermes dashboard; no model request."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    with tempfile.TemporaryDirectory(prefix="flownium-live-", dir="/tmp") as directory:
        command = [sys.executable, str(ROOT / "flownium_cli.py"), "--state-dir", directory]
        port, metrics = free_port(), free_port()
        try:
            started = subprocess.run(command + ["local", "--port", str(port), "--metrics-port", str(metrics),
                                                "--workspace", str(ROOT), "--timeout", "120"],
                                     capture_output=True, text=True, timeout=260)
            if started.returncode:
                print(started.stdout + started.stderr, file=sys.stderr)
                # Only the last nonempty log line is printed. Never dump the
                # user's environment, configuration, keys, or conversation data.
                log = Path(directory) / "hermes.log"
                if log.exists():
                    lines = [line for line in log.read_text(errors="replace").splitlines() if line.strip()]
                    if lines:
                        print("Hermes startup: " + lines[-1][:300], file=sys.stderr)
                return 1
            status = json.loads(subprocess.check_output(command + ["status", "--json"], text=True))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f"http://127.0.0.1:{port}/chat", timeout=10) as response:
                html = response.read(2_000_000).decode(errors="replace")
                if "<html" not in html.lower():
                    raise AssertionError("The real Hermes chat page did not return HTML")
            print(json.dumps({"real_hermes": True, "hermes_version": status["hermes_version"],
                              "dashboard_responded": True, "chat_page_served": True,
                              "model_inference_tested": False, "cloudflare_tested": False}))
        finally:
            subprocess.run(command + ["off"], check=False, timeout=30, capture_output=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
