"""Process integration tests. External services are explicit test fixtures."""
import contextlib
import http.server
import json
import os
from pathlib import Path
from unittest.mock import patch
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import flownium_cli as cli

# Hosted macOS runners can take several seconds to cold-start Python fixtures.
# Keep startup bounded while allowing that delay; successful tests do not sleep.
FIXTURE_STARTUP = 15


def available_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.08)
    raise AssertionError("Condition was not reached before timeout")


class FixtureHTTPServer(http.server.HTTPServer):
    def server_bind(self):
        # HTTPServer otherwise reverse-resolves 127.0.0.1 before serving. Hosted
        # macOS DNS can stall that lookup; these loopback fixtures need no DNS.
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="flownium-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.port = available_port()
        self.metrics = available_port()
        self.hermes = self.root / "hermes"
        self.cloudflared = self.root / "cloudflared"
        self.dumbpipe = self.root / "dumbpipe"
        source = '''#!PYTHON
import http.server, json, os, signal, socketserver, sys
from pathlib import Path
root = Path(__file__).parent
kind = Path(__file__).name
(root / (kind + '.process.json')).write_text(json.dumps({'pid': os.getpid(), 'argv': sys.argv, 'public_url': os.environ.get('HERMES_DASHBOARD_PUBLIC_URL'), 'web_dist': os.environ.get('HERMES_WEB_DIST')}))
if kind == 'dumbpipe':
    import time
    assert os.environ.get('IROH_SECRET')
    print('dumbpipe connect-tcp endpoint' + 'a' * 80, file=sys.stderr, flush=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True: time.sleep(0.1)
if kind == 'hermes':
    port = int(sys.argv[sys.argv.index('--port') + 1])
    assert sys.argv[sys.argv.index('--host') + 1] == '127.0.0.1'
    assert '--isolated' in sys.argv
else:
    port = int(sys.argv[sys.argv.index('--metrics') + 1].rsplit(':', 1)[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if kind == 'hermes':
            auth = not (root / 'no-auth').exists()
            providers = ['basic'] if (root / 'basic-only').exists() or os.environ.get('HERMES_DASHBOARD_BASIC_AUTH_USERNAME') else ['nous']
            body = json.dumps({'version': 'fixture-1', 'auth_required': auth, 'auth_providers': providers}).encode()
            code = 200
        else:
            body = b'ok'
            code = 503 if (root / 'disconnected').exists() else 200
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
class Server(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'localhost', self.server_address[1]
Server(('127.0.0.1', port), Handler).serve_forever()
'''.replace("PYTHON", sys.executable, 1)
        for path in (self.hermes, self.cloudflared, self.dumbpipe):
            path.write_text(source)
            path.chmod(0o700)

    def tearDown(self):
        self.run_cli("off", check=False)
        # A failed assertion must still clean up this test's owned fixtures.
        for name in ("hermes", "cloudflared", "dumbpipe"):
            record = self.root / (name + ".process.json")
            if record.exists():
                pid = json.loads(record.read_text())["pid"]
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)
        self.temp.cleanup()

    def run_cli(self, *args, check=True, input=None):
        env = os.environ.copy()
        env.pop("FLOWNIUM_SERVER", None)
        result = subprocess.run([sys.executable, str(ROOT / "flownium_cli.py"),
                                 "--state-dir", str(self.state), *args],
                                env=env, capture_output=True, text=True, timeout=60, input=input)
        if result.returncode:
            # These executables are explicit fixtures, so their output contains
            # no real Hermes state or external account credentials.
            diagnostics = []
            for name in ("controller.log", "hermes.log", "cloudflared.log", "iroh.log"):
                path = self.state / name
                if path.exists():
                    diagnostics.append(f"{name}: {path.read_text()[-4000:]}")
            for path in self.root.glob("*.process.json"):
                diagnostics.append(f"{path.name}: {path.read_text()}")
            result.stderr += "\n" + "\n".join(diagnostics)
        if check and result.returncode:
            self.fail(result.stdout + result.stderr)
        return result

    def local(self):
        return self.run_cli("local", "--hermes-bin", str(self.hermes), "--port", str(self.port),
                            "--metrics-port", str(self.metrics), "--workspace", str(self.root), "--timeout", str(FIXTURE_STARTUP))

    def remote_config(self):
        cli.save_json(self.state / "config.json", {
            "mode": "remote", "port": self.port, "metrics_port": self.metrics,
            "hermes_bin": str(self.hermes), "cloudflared_bin": str(self.cloudflared),
            "workspace": str(self.root), "startup_timeout": FIXTURE_STARTUP,
            "hostname": "person.flownium.test", "device_id": "fixture-device",
        })
        (self.state / "tunnel-token").write_text("fixture-scoped-token")
        (self.state / "tunnel-token").chmod(0o600)

    def test_local_lifecycle_and_duplicate_on(self):
        self.assertIn("fixture-1", self.local().stdout)
        first = json.loads((self.root / "hermes.process.json").read_text())["pid"]
        self.run_cli("on")
        self.assertEqual(first, json.loads((self.root / "hermes.process.json").read_text())["pid"])
        status = json.loads(self.run_cli("status", "--json").stdout)
        self.assertEqual(status["phase"], "online")
        self.assertEqual(status["mode"], "local")
        # A closing browser launcher may only stop its own controller run.
        self.run_cli("off", "--if-run-id", "stale-controller-run")
        self.assertTrue(cli.daemon_running(self.state))
        self.run_cli("off", "--if-run-id", status["run_id"])
        self.run_cli("off")
        with self.assertRaises(ProcessLookupError):
            os.kill(first, 0)
        self.assertFalse(cli.daemon_running(self.state))

    def test_remote_requires_oauth_before_tunnel_starts(self):
        self.remote_config()
        (self.root / "no-auth").touch()
        result = self.run_cli("on", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OAuth/OIDC", result.stderr)
        self.assertFalse((self.root / "cloudflared.process.json").exists())
        self.assertFalse(cli.daemon_running(self.state))

    def test_basic_only_auth_is_rejected(self):
        self.remote_config()
        (self.root / "basic-only").touch()
        result = self.run_cli("on", check=False)
        self.assertIn("OAuth/OIDC", result.stderr)
        self.assertFalse((self.root / "cloudflared.process.json").exists())

    def test_remote_connects_real_processes_and_keeps_token_out_of_arguments(self):
        self.remote_config()
        self.run_cli("on")
        status = json.loads(self.run_cli("status", "--json").stdout)
        self.assertTrue(status["tunnel_connected"])
        self.assertFalse(status["public_url_verified"])
        command = json.loads((self.root / "cloudflared.process.json").read_text())["argv"]
        self.assertIn("--token-file", command)
        self.assertNotIn("fixture-scoped-token", " ".join(command))
        host = json.loads((self.root / "hermes.process.json").read_text())
        self.assertEqual(host["public_url"], "https://person.flownium.test")
        self.run_cli("off")
        for name in ("hermes", "cloudflared"):
            pid = json.loads((self.root / (name + ".process.json")).read_text())["pid"]
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_auth_removed_after_start_stops_remote_access(self):
        self.remote_config()
        self.run_cli("on")
        (self.root / "no-auth").touch()
        wait_for(lambda: not cli.daemon_running(self.state))
        status = json.loads(self.run_cli("status", "--json").stdout)
        self.assertEqual(status["phase"], "failed")
        self.assertIn("OAuth/OIDC", status["error"])

    def test_hermes_exit_stops_tunnel(self):
        self.remote_config()
        self.run_cli("on")
        host_pid = json.loads((self.root / "hermes.process.json").read_text())["pid"]
        tunnel_pid = json.loads((self.root / "cloudflared.process.json").read_text())["pid"]
        os.kill(host_pid, signal.SIGTERM)
        wait_for(lambda: not cli.daemon_running(self.state))
        with self.assertRaises(ProcessLookupError):
            os.kill(tunnel_pid, 0)

    def test_existing_listener_is_left_running(self):
        with socket.socket() as existing:
            existing.bind(("127.0.0.1", self.port))
            existing.listen()
            result = self.run_cli("local", "--hermes-bin", str(self.hermes), "--port", str(self.port),
                                  "--metrics-port", str(self.metrics), "--timeout", "2", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("in use", result.stderr)
            self.assertFalse((self.root / "hermes.process.json").exists())
            self.assertEqual(existing.getsockname()[1], self.port)

    def test_missing_public_service_is_explicit(self):
        result = self.run_cli("login", "--no-browser", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not deployed/configured", result.stderr)
        self.assertFalse((self.state / "session.json").exists())

    def test_iroh_share_uses_real_hermes_command_and_hashes_password(self):
        password = "correct-test-password"
        result = self.run_cli("share", "--username", "testuser", "--password-stdin", "--dumbpipe-bin", str(self.dumbpipe),
                              "--hermes-bin", str(self.hermes), "--port", str(self.port), "--metrics-port", str(self.metrics),
                              "--workspace", str(self.root), "--timeout", str(FIXTURE_STARTUP), input=password + "\n")
        self.assertNotIn(password, result.stdout + result.stderr)
        self.assertNotIn(password, (self.state / "basic-auth.json").read_text())
        status = json.loads(self.run_cli("status", "--json").stdout)
        self.assertEqual(status["transport"], "iroh")
        self.assertEqual(status["auth_providers"], ["basic"])
        self.assertTrue(status["iroh_ticket"].startswith("endpoint"))
        self.assertIsNone(status["url"])
        self.run_cli("off")

    def test_desktop_upgrade_preserves_sharing_credentials_and_follows_complete_builds(self):
        desktop = self.root / "desktop"
        (desktop / "assets").mkdir(parents=True)
        (desktop / "index.html").write_text('<script type="module" src="./assets/index-test.js"></script>')
        # Do not select a partially installed build.
        self.assertFalse(cli.complete_renderer(desktop))
        (desktop / "assets/index-test.js").write_text("// explicit renderer fixture")
        self.assertTrue(cli.complete_renderer(desktop))
        self.run_cli("share", "--email", "owner+device@example.com", "--password-stdin", "--dumbpipe-bin", str(self.dumbpipe),
                     "--hermes-bin", str(self.hermes), "--port", str(self.port), "--metrics-port", str(self.metrics),
                     "--workspace", str(self.root), "--timeout", str(FIXTURE_STARTUP), input="correct-test-password\n")
        original = (self.state / "basic-auth.json").read_bytes()
        with patch.dict(os.environ, {"HERMES_DESKTOP_DIST": str(desktop)}):
            self.run_cli("on", "--desktop")
        self.assertEqual(original, (self.state / "basic-auth.json").read_bytes())
        self.assertTrue(json.loads((self.state / "config.json").read_text())["desktop_renderer"])
        alias = self.state / "desktop-renderer"
        self.assertEqual(alias.resolve(), desktop.resolve())
        self.assertEqual(Path(json.loads((self.root / "hermes.process.json").read_text())["web_dist"]).resolve(), alias.resolve())
        newer = self.root / "newer-desktop"
        newer.mkdir()
        (newer / "index.html").write_text("updated renderer fixture")
        cli.point_renderer(self.state, newer)
        self.assertEqual(alias.resolve(), newer.resolve())

    def test_iroh_sharing_refuses_an_inactive_login_gate(self):
        (self.root / "no-auth").touch()
        result = self.run_cli("share", "--username", "testuser", "--password-stdin", "--dumbpipe-bin", str(self.dumbpipe),
                              "--hermes-bin", str(self.hermes), "--port", str(self.port), "--metrics-port", str(self.metrics),
                              "--workspace", str(self.root), "--timeout", str(FIXTURE_STARTUP), input="correct-test-password\n", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "dumbpipe.process.json").exists())

    def test_clone_setup_prepares_and_starts_a_managed_host(self):
        result = subprocess.run([sys.executable, str(ROOT / "tools/setup.py"), "--mode", "host",
                                 "--username", "setupuser", "--password-stdin", "--state-dir", str(self.state),
                                 "--hermes-bin", str(self.hermes), "--dumbpipe-bin", str(self.dumbpipe),
                                 "--port", str(self.port), "--metrics-port", str(self.metrics), "--workspace", str(self.root)],
                                input="setup-test-password\n", capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Connection ready", result.stdout)
        self.assertNotIn("setup-test-password", result.stdout + result.stderr)
        self.assertEqual(json.loads(self.run_cli("status", "--json").stdout)["phase"], "online")
        self.run_cli("off")
        self.run_cli("on")
        self.assertEqual(json.loads(self.run_cli("status", "--json").stdout)["transport"], "iroh")

    def test_client_setup_can_prepare_without_hermes_or_starting_a_process(self):
        result = subprocess.run([sys.executable, str(ROOT / "tools/setup.py"), "--mode", "client", "--prepare-only",
                                 "--hermes-bin", "not-installed-hermes-fixture", "--dumbpipe-bin", str(self.dumbpipe)],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Transport ready", result.stdout)
        self.assertFalse((self.root / "dumbpipe.process.json").exists())

    def test_paired_configuration_is_not_overwritten_by_local_test(self):
        self.remote_config()
        previous = (self.state / "config.json").read_text()
        result = self.run_cli("local", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(previous, (self.state / "config.json").read_text())

    def test_device_login_accepts_platform_assigned_subdomain(self):
        received = []

        class AccountFixture(http.server.BaseHTTPRequestHandler):
            def do_POST(handler):
                payload = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
                received.append((handler.path, payload, handler.headers.get("Authorization")))
                if handler.path == "/v1/cli/device":
                    response = {"device_code": "fixture-code", "user_code": "TEST-1234",
                                "verification_uri": f"http://127.0.0.1:{account.server_port}/activate",
                                "expires_in": 30, "interval": 1}
                elif handler.path == "/v1/cli/token":
                    response = {"access_token": "fixture-account-token"}
                else:
                    response = {"device_id": "assigned-device", "hostname": "demo.flownium.test",
                                "tunnel_token": "fixture-tunnel-token"}
                body = json.dumps(response).encode()
                handler.send_response(200)
                handler.send_header("Content-Length", str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)

            def log_message(self, *args):
                pass

        account = FixtureHTTPServer(("127.0.0.1", 0), AccountFixture)
        thread = threading.Thread(target=account.serve_forever, daemon=True)
        thread.start()
        try:
            result = self.run_cli("login", "--server", f"http://127.0.0.1:{account.server_port}",
                                  "--no-browser", "--port", str(self.port), "--metrics-port", str(self.metrics),
                                  "--hermes-bin", str(self.hermes), "--cloudflared-bin", str(self.cloudflared),
                                  "--workspace", str(self.root))
            self.assertIn("demo.flownium.test", result.stdout)
            self.assertNotIn("fixture-account-token", result.stdout + result.stderr)
            self.assertNotIn("fixture-tunnel-token", result.stdout + result.stderr)
            config = json.loads((self.state / "config.json").read_text())
            self.assertEqual(config["hostname"], "demo.flownium.test")
            self.assertEqual(received[-1][2], "Bearer fixture-account-token")
            self.assertEqual((self.state / "session.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((self.state / "tunnel-token").stat().st_mode & 0o777, 0o600)
        finally:
            account.shutdown()
            account.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
