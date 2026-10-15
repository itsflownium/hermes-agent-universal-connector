"""Opt-in real Hermes + two real Iroh endpoints, with real password authentication."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dumbpipe-bin", default="dumbpipe")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="flownium-iroh-", dir="/tmp") as directory:
        directory = Path(directory)
        host_state, client_state = directory / "host", directory / "client"
        cli = [sys.executable, str(ROOT / "flownium_cli.py")]
        host = cli + ["--state-dir", str(host_state)]
        password = secrets.token_urlsafe(24)
        client = None
        try:
            result = subprocess.run(host + ["share", "--username", "localtest", "--password-stdin", "--dumbpipe-bin", args.dumbpipe_bin,
                                           "--port", str(free_port()), "--metrics-port", str(free_port()), "--timeout", "120"],
                                    input=password + "\n", text=True, capture_output=True, timeout=270)
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or "Hermes/Iroh startup failed")
            state = json.loads(subprocess.check_output(host + ["status", "--json"], text=True))
            ticket = state["iroh_ticket"]
            port = free_port()
            client = subprocess.Popen(cli + ["--state-dir", str(client_state), "access", ticket, "--dumbpipe-bin", args.dumbpipe_bin,
                                            "--port", str(port), "--no-browser"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
            origin = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                try:
                    with opener.open(origin + "/api/status", timeout=5) as response:
                        remote = json.load(response)
                    break
                except (OSError, urllib.error.URLError):
                    if client.poll() is not None:
                        raise RuntimeError("Iroh client stopped before its remote connection became ready")
                    time.sleep(0.25)
            else:
                raise RuntimeError("No response from real Hermes over Iroh")
            assert remote["auth_required"] is True
            assert remote["auth_providers"] == ["basic"]
            def login(value):
                body = json.dumps({"provider": "basic", "username": "localtest", "password": value}).encode()
                return opener.open(urllib.request.Request(origin + "/auth/password-login", data=body,
                    headers={"Content-Type": "application/json", "Origin": origin}), timeout=15)
            try:
                login("wrong-password")
                raise AssertionError("Wrong password was accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            with login(password) as response:
                assert response.status == 200
            with opener.open(origin + "/api/auth/me", timeout=15) as response:
                identity = json.load(response)
            assert identity["provider"] == "basic"
            with opener.open(origin + "/chat", timeout=15) as response:
                assert b"<html" in response.read(2_000_000).lower()
            assert password not in (host_state / "basic-auth.json").read_text()
            print(json.dumps({"real_hermes": True, "hermes_version": remote["version"], "real_iroh_endpoints": 2,
                              "wrong_password_rejected": True, "authenticated_chat_page_served": True,
                              "registered_domain_used": False, "cloudflare_used": False,
                              "model_inference_tested": False, "cross_region_tested": False}))
        finally:
            if client and client.poll() is None:
                client.send_signal(signal.SIGINT)
                client.wait(timeout=15)
            subprocess.run(host + ["off"], timeout=30, capture_output=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
