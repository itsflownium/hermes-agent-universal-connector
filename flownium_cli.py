"""Nectit's macOS/Linux/WSL2 host controller. No runtime Python dependencies.

The host connects to the installed Hermes dashboard, never an imitation of it.
Iroh sharing uses native Hermes password authentication; account mode uses OIDC.
The account service is an external dependency, not implemented by this module.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
try:
    import fcntl
except ImportError:
    fcntl = None  # The host runs inside WSL2 on Windows.
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

VERSION = "0.1.0"
HERE = Path(__file__).resolve()


class FlowniumError(Exception):
    pass


class AuthenticationError(FlowniumError):
    pass


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def save_json(path, data):
    private_dir(path.parent)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except (ValueError, OSError) as exc:
        raise FlowniumError(f"Cannot read {path.name}: {exc}") from exc


@contextlib.contextmanager
def lock(path, blocking=True):
    private_dir(path.parent)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(fd)


def daemon_running(state):
    try:
        with open(state / "service.lock", "rb") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return False
            except BlockingIOError:
                return True
    except FileNotFoundError:
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


TLS = ssl.create_default_context()
if not ssl.get_default_verify_paths().cafile and Path('/etc/ssl/cert.pem').is_file():
    TLS.load_verify_locations('/etc/ssl/cert.pem')
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=TLS))


def http_json(url, *, data=None, token=None, headers=None, timeout=3, method=None):
    request_headers = {"Accept": "application/json", **(headers or {})}
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with HTTP.open(request, timeout=timeout) as response:
            result = json.loads(response.read(2_000_000))
            if not isinstance(result, dict):
                raise FlowniumError("Expected a JSON object from the service.")
            return result
    except urllib.error.HTTPError as exc:
        # OAuth device-flow errors are defined protocol values; never echo bodies
        # or headers that might contain credentials.
        try:
            payload = json.loads(exc.read(8192))
        except (ValueError, OSError):
            payload = {}
        if isinstance(payload, dict) and payload.get("error") in {"authorization_pending", "slow_down"}:
            return {"error": payload["error"]}
        error = FlowniumError(f"Service returned HTTP {exc.code}.")
        error.status = exc.code
        raise error from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise FlowniumError(f"Cannot reach service ({type(exc).__name__}).") from None


def hostname(value):
    if not isinstance(value, str):
        raise FlowniumError("The account service returned an invalid workspace hostname.")
    value = value.lower().strip().rstrip(".")
    if len(value) > 253 or "." not in value or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
        for part in value.split(".")
    ):
        raise FlowniumError("The account service returned an invalid workspace hostname.")
    return value


def server_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {"", "/"} or not parsed.hostname):
        raise FlowniumError("Use the Nectit service's HTTPS origin, without a path.")
    development = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
    if parsed.scheme != "https" and not development:
        raise FlowniumError("The Nectit account service must use HTTPS.")
    return value.rstrip("/")


def executable(value, name):
    result = shutil.which(value)
    if not result:
        raise FlowniumError(f"{name} is missing. Install it or supply --{name}-bin.")
    return str(Path(result).absolute())


def load_config(state):
    config = read_json(state / "config.json")
    if not config:
        raise FlowniumError("First run './setup', 'nectit share', or 'nectit login'.")
    return config


def control(state, command, timeout=1):
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(timeout)
            client.connect(str(state / "control.sock"))
            client.sendall(json.dumps({"command": command}).encode() + b"\n")
            response = bytearray()
            while b"\n" not in response and len(response) < 65536:
                part = client.recv(4096)
                if not part:
                    break
                response.extend(part)
            return json.loads(response)
    except (OSError, ValueError):
        return None


def snapshot(state):
    live = control(state, "status", timeout=0.2)
    if live:
        return live
    last = read_json(state / "status.json", {})
    if daemon_running(state):
        return last or {"phase": "starting"}
    return {**last, "phase": "off" if last.get("phase") != "failed" else "failed"}


def print_status(data, as_json=False):
    if as_json:
        print(json.dumps(data, indent=2))
        return
    print(f"Nectit: {data.get('phase', 'off')}")
    if data.get("mode"):
        print(f"Mode: {data['mode']}")
    if data.get("url"):
        print(f"URL: {data['url']}")
    if data.get("hermes_version"):
        print(f"Hermes: {data['hermes_version']}")
    if data.get("auth_providers"):
        print("Login providers: " + ", ".join(data["auth_providers"]))
    if data.get("iroh_ticket"):
        print("Iroh ticket: " + data["iroh_ticket"])
        if data.get("desktop_renderer"):
            print("Open './nectit app' on the connecting computer, choose Another computer, and paste this ticket.")
        else:
            print("Use 'nectit access <ticket>' on the connecting computer.")
    if data.get("mode") == "remote" and data.get("phase") == "online":
        transport = "Iroh endpoint ready" if data.get("transport") == "iroh" else "Tunnel connected"
        print(transport + ". Public browser login has not been independently verified.")
    if data.get("error"):
        print(f"Reason: {data['error']}")


def free_port(port):
    with socket.socket() as listener:
        # Match dashboard servers' address reuse: recently closed connections
        # in TIME_WAIT must not prevent off -> on. An active listener still fails.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            raise FlowniumError(f"Port {port} is in use; choose another port. Existing services were left running.") from None


def dashboard_status(config):
    headers = {}
    if config["mode"] in {"remote", "peer"}:
        headers = {"Host": config["hostname"], "X-Forwarded-Proto": "https"}
    result = http_json(f"http://127.0.0.1:{config['port']}/api/status", headers=headers)
    if "version" not in result:
        raise FlowniumError("The local endpoint does not identify itself as a Hermes dashboard.")
    if config["mode"] == "peer":
        if result.get("auth_required") is not True or set(result.get("auth_providers", [])) != {"basic"}:
            raise AuthenticationError("Private Iroh sharing requires Hermes's basic login gate and no other interactive login providers in this profile.")
    elif config["mode"] == "remote":
        providers = result.get("auth_providers", [])
        if result.get("auth_required") is not True or not any(
            isinstance(item, str) and item not in {"basic", "drain"} for item in providers
        ):
            raise AuthenticationError("Hermes needs a configured OAuth/OIDC login provider before remote access can start. The tunnel was not enabled.")
        if config.get("oidc_issuer") and set(providers) - {"self-hosted", "drain"}:
            raise AuthenticationError("This Hermes profile has other dashboard login providers enabled. Use a profile with only Nectit's self-hosted OIDC provider so workspace ownership is enforced.")
    return result


def tunnel_connected(config):
    # /ready is cloudflared's local connection readiness endpoint, not a check
    # that DNS, the public website, or a user's login has been tested.
    try:
        with HTTP.open(f"http://127.0.0.1:{config['metrics_port']}/ready", timeout=1) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def irohticket(state):
    try:
        match = re.search(r"dumbpipe connect-tcp\s+(?:--addr\s+\S+\s+)?((?:node|endpoint)[a-z2-7]+)",
                          (state / "iroh.log").read_text(errors="replace"))
        return match.group(1) if match else None
    except FileNotFoundError:
        return None


def iroh_environment(state, client=False):
    path = state / ("iroh-client-key.json" if client else "iroh-key.json")
    key = read_json(path)
    if not key:
        key = {"secret": secrets.token_hex(32)}
        save_json(path, key)
    env = os.environ.copy()
    env["IROH_SECRET"] = key["secret"]
    return env


def spawn(command, logpath, *, env, cwd):
    fd = os.open(logpath, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "ab", buffering=0) as logfile:
        return subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=logfile, stderr=logfile, start_new_session=True)


def stop_child(process):
    if not process or process.poll() is not None:
        return
    # Only this supervisor's child process groups are signalled. Persisted PIDs
    # are never trusted, so PID reuse cannot kill an unrelated user's process.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def complete_renderer(directory):
    try:
        html = (directory / "index.html").read_text(encoding="utf-8-sig")
        references = re.findall(r'(?:src|href)=["\']\./(assets/[^"\']+)["\']', html)
        return bool(references) and all((directory / path).is_file() for path in references)
    except OSError:
        return False


def point_renderer(state, renderer):
    # A private stable path lets the native server read updated builds in place.
    alias = state / "desktop-renderer"
    if alias.exists() and not alias.is_symlink():
        raise FlowniumError("The private desktop-renderer path is not a symlink.")
    if alias.is_symlink() and alias.resolve() == renderer.resolve():
        return alias
    temporary = state / ("renderer-" + uuid.uuid4().hex)
    temporary.symlink_to(renderer, target_is_directory=True)
    os.replace(temporary, alias)
    return alias


def desktop_renderer(hermes_bin):
    """Read the installed renderer in place; no vendored or frozen UI bundle."""
    override = os.environ.get("HERMES_DESKTOP_DIST")
    if override:
        candidate = Path(override).expanduser().resolve()
        if not complete_renderer(candidate):
            raise FlowniumError("HERMES_DESKTOP_DIST must contain a built Hermes Desktop index.html.")
        return candidate
    roots = [Path(os.environ.get("HERMES_AGENT_ROOT", "~/.hermes/hermes-agent")).expanduser()]
    executable = Path(shutil.which(hermes_bin) or hermes_bin).resolve()
    roots += list(executable.parents)[:4]
    for tree in roots:
        desktop = tree / "apps/desktop"
        candidates = [desktop / "dist"]
        if (desktop / "release").is_dir():
            candidates += list((desktop / "release").glob("*/Hermes.app/Contents/Resources/app.asar.unpacked/dist"))
            candidates += list((desktop / "release").glob("*/resources/app.asar.unpacked/dist"))
        built = [value for value in candidates if complete_renderer(value)]
        if built:
            return max(built, key=lambda value: (value / "index.html").stat().st_mtime_ns)
    return None


def supervise(state, run_id):
    config = load_config(state)
    private_dir(state)
    status = {"phase": "starting", "run_id": run_id, "mode": config["mode"],
              "url": config.get("public_url") or f"https://{config['hostname']}" if config["mode"] == "remote"
              else f"http://127.0.0.1:{config['port']}", "public_url_verified": False,
              "desktop_renderer": bool(config.get("desktop_renderer"))}
    if config["mode"] == "peer":
        status["url"] = None
    use_iroh = config["mode"] == "peer" or config.get("transport") == "iroh"
    status["transport"] = "iroh" if use_iroh else ("cloudflare" if config["mode"] == "remote" else "local")
    stopped = False

    def request_stop(*_):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    hermes = tunnel = listener = None
    socketpath = state / "control.sock"
    service_fd = os.open(state / "service.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(service_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(service_fd)
        return 1
    try:
        save_json(state / "status.json", status)
        with contextlib.suppress(FileNotFoundError):
            socketpath.unlink()
        free_port(config["port"])
        if config["mode"] == "remote" and not use_iroh:
            free_port(config["metrics_port"])
        env = os.environ.copy()
        # A local test explicitly has a loopback public origin, even if the
        # shell contains an old remote override. No user's config is edited.
        env["HERMES_DASHBOARD_PUBLIC_URL"] = config.get("public_url") or status["url"] or "https://flownium.invalid"
        if config["mode"] == "peer":
            auth = read_json(state / "basic-auth.json")
            if not auth:
                raise FlowniumError("Configure Iroh sharing with 'nectit share --username NAME' first.")
            env["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"] = auth["username"]
            env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"] = auth["password_hash"]
            env["HERMES_DASHBOARD_BASIC_AUTH_SECRET"] = auth["secret"]
            env.pop("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", None)
        if config.get("oidc_issuer"):
            env["HERMES_DASHBOARD_OIDC_ISSUER"] = config["oidc_issuer"]
            env["HERMES_DASHBOARD_OIDC_CLIENT_ID"] = config["oidc_client_id"]
            env.pop("HERMES_DASHBOARD_OIDC_CLIENT_SECRET", None)
        renderer = desktop_renderer(config["hermes_bin"]) if config.get("desktop_renderer") else None
        if config.get("desktop_renderer") and not renderer:
            raise FlowniumError("Build Hermes Desktop first with hermes gui --build-only, or set HERMES_DESKTOP_DIST.")
        if renderer:
            # The alias marks this as a deliberate browser-adapted renderer,
            # rather than an accidentally inherited Electron web-dist path.
            env["HERMES_WEB_DIST"] = str(point_renderer(state, renderer))
        command = [config["hermes_bin"]]
        if config.get("profile"):
            command += ["-p", config["profile"]]
        command += ["dashboard", "--host", "127.0.0.1", "--port", str(config["port"]),
                    "--no-open", "--isolated"]
        hermes = spawn(command, state / "hermes.log", env=env, cwd=config["workspace"])
        deadline = time.monotonic() + config["startup_timeout"]
        details = None
        while not stopped and time.monotonic() < deadline:
            if hermes.poll() is not None:
                raise FlowniumError(f"Hermes exited with code {hermes.returncode}. See the private hermes.log for details.")
            try:
                details = dashboard_status(config)
                break
            except AuthenticationError:
                raise
            except FlowniumError:
                pass
            time.sleep(0.2)
        if stopped:
            return 0
        if not details:
            raise FlowniumError("Hermes did not become ready before the startup timeout. See hermes.log.")
        status.update(hermes_version=str(details["version"]),
                      auth_providers=details.get("auth_providers", []))
        if use_iroh:
            fd = os.open(state / "iroh.log", os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            os.close(fd)
            tunnel = spawn([config["dumbpipe_bin"], "listen-tcp", "--host", f"127.0.0.1:{config['port']}"],
                           state / "iroh.log", env=iroh_environment(state), cwd=config["workspace"])
        elif config["mode"] == "remote":
            # The tunnel token is scoped to one laptop and provisioned by
            # Flownium. It is never a command-line argument or printed.
            tunnel_env = env.copy()
            for variable in ("TUNNEL_TOKEN", "TUNNEL_TOKEN_FILE", "TUNNEL_METRICS", "TUNNEL_CONFIG", "TUNNEL_URL"):
                tunnel_env.pop(variable, None)
            tunnel = spawn([config["cloudflared_bin"], "tunnel", "--no-autoupdate",
                            "--metrics", f"127.0.0.1:{config['metrics_port']}", "run",
                            "--token-file", str(state / "tunnel-token")],
                           state / "cloudflared.log", env=tunnel_env, cwd=config["workspace"])
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(socketpath))
        socketpath.chmod(0o600)
        listener.listen(4)
        listener.settimeout(0.5)
        status["phase"] = "connecting" if tunnel else "online"
        save_json(state / "status.json", status)
        last_check = 0.0
        last_heartbeat = 0.0
        last_renderer_check = time.monotonic()
        session = read_json(state / "session.json", {})
        deadline = time.monotonic() + config["startup_timeout"]
        while not stopped:
            if config.get("desktop_renderer") and time.monotonic() - last_renderer_check > 15:
                # An updater may replace the source or packaged build directory.
                # Keep the last complete renderer through partial build swaps.
                try:
                    updated_renderer = desktop_renderer(config["hermes_bin"])
                    if updated_renderer:
                        point_renderer(state, updated_renderer)
                except (FlowniumError, OSError):
                    pass
                last_renderer_check = time.monotonic()
            if hermes.poll() is not None:
                raise FlowniumError("Hermes stopped; remote access has been disabled.")
            if tunnel and tunnel.poll() is not None:
                raise FlowniumError("The connector transport stopped; remote access has been disabled.")
            if time.monotonic() - last_check > 1:
                # Recheck login as well as liveness after startup. A removed
                # auth gate must not leave an accessible tunnel behind.
                dashboard_status(config)
                ticket = irohticket(state) if use_iroh else None
                connected = bool(ticket) if use_iroh else tunnel_connected(config) if tunnel else None
                if ticket:
                    status["iroh_ticket"] = ticket
                if config.get("server") and session.get("access_token") and (not use_iroh or ticket) and time.monotonic() - last_heartbeat > 15:
                    try:
                        http_json(config["server"] + "/v1/devices/" + config["device_id"] + "/heartbeat",
                                  token=session["access_token"], data={"hermes_version": status["hermes_version"], "iroh_ticket": ticket})
                        status["account_service_reachable"] = True
                    except FlowniumError as error:
                        status["account_service_reachable"] = False
                        if getattr(error, "status", None) in {401, 404}:
                            raise FlowniumError("The paired device was revoked or its account credential expired; remote access was stopped.")
                    last_heartbeat = time.monotonic()
                if tunnel:
                    status["tunnel_connected"] = connected
                    status["phase"] = "online" if connected else "reconnecting"
                    if not connected and time.monotonic() > deadline:
                        raise FlowniumError("The transport did not become ready before the timeout. See its private log.")
                    if connected:
                        deadline = time.monotonic() + config["startup_timeout"]
                save_json(state / "status.json", status)
                last_check = time.monotonic()
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            with client:
                client.settimeout(1)
                try:
                    payload = client.recv(2048)
                    request = json.loads(payload)
                    if request.get("command") == "stop":
                        status["phase"] = "stopping"
                        stopped = True
                    response = status if request.get("command") in {"status", "stop"} else {"error": "Unknown command"}
                    client.sendall(json.dumps(response).encode() + b"\n")
                except (ValueError, OSError):
                    continue
    except Exception as exc:
        status.update(phase="failed", error=str(exc) if isinstance(exc, FlowniumError)
                      else f"Host controller failed ({type(exc).__name__}).")
        return 1
    finally:
        # Close the public path first, then our dashboard. Local sessions owned
        # by other processes are never stopped.
        stop_child(tunnel)
        stop_child(hermes)
        if listener:
            listener.close()
            with contextlib.suppress(FileNotFoundError):
                socketpath.unlink()
        if status["phase"] != "failed":
            status["phase"] = "off"
        save_json(state / "status.json", status)
        os.close(service_fd)
    return 0


def start(state):
    config = load_config(state)
    if daemon_running(state):
        print_status(snapshot(state))
        return 0
    if len(os.fsencode(str(state / "control.sock"))) > 100:
        raise FlowniumError("State path is too long for a local control socket; use a shorter --state-dir.")
    config["hermes_bin"] = executable(config["hermes_bin"], "hermes")
    if config["mode"] == "peer" or config.get("transport") == "iroh":
        config["dumbpipe_bin"] = executable(config.get("dumbpipe_bin", "dumbpipe"), "dumbpipe")
    elif config["mode"] == "remote":
        config["cloudflared_bin"] = executable(config["cloudflared_bin"], "cloudflared")
        if not (state / "tunnel-token").is_file():
            raise FlowniumError("No tunnel credential is available. Run 'nectit login'.")
    if not Path(config["workspace"]).is_dir():
        raise FlowniumError("The selected workspace directory does not exist.")
    save_json(state / "config.json", config)
    run_id = uuid.uuid4().hex
    process = spawn([sys.executable, str(HERE), "--state-dir", str(state), "_serve", run_id],
                    state / "controller.log", env=os.environ.copy(), cwd=config["workspace"])
    deadline = time.monotonic() + config["startup_timeout"] * 2 + 12
    try:
        while time.monotonic() < deadline:
            result = read_json(state / "status.json", {})
            if result.get("run_id") == run_id:
                if result.get("phase") == "online":
                    print_status(result)
                    return 0
                if result.get("phase") == "failed":
                    process.wait(timeout=15)
                    raise FlowniumError(result.get("error", "Startup failed."))
            if process.poll() is not None:
                raise FlowniumError("The host controller could not start. See controller.log.")
            time.sleep(0.15)
        raise FlowniumError("Startup timed out; the host controller was stopped.")
    except BaseException:
        # We hold the actual Popen handle, not a stale PID read from a file.
        process.terminate()
        process.wait(timeout=15)
        raise


def stop(state):
    if not daemon_running(state):
        print("Nectit: off")
        return
    if not control(state, "stop"):
        raise FlowniumError("The running controller is not responding; no unrelated process was signalled.")
    deadline = time.monotonic() + 15
    while daemon_running(state) and time.monotonic() < deadline:
        time.sleep(0.1)
    if daemon_running(state):
        raise FlowniumError("Shutdown is still in progress. Check 'nectit status'.")
    print("Nectit: off")


def base_config(args, mode):
    return {"mode": mode, "port": args.port, "metrics_port": args.metrics_port,
            "hermes_bin": args.hermes_bin, "cloudflared_bin": args.cloudflared_bin,
            "dumbpipe_bin": args.dumbpipe_bin, "transport": getattr(args, "transport", "iroh" if mode == "peer" else "local"),
            "workspace": str(Path(args.workspace).expanduser().resolve()),
            "profile": args.profile, "startup_timeout": args.timeout,
            "desktop_renderer": getattr(args, "desktop", False)}


def share(state, args):
    if daemon_running(state):
        raise FlowniumError("Turn Nectit off before changing sharing configuration.")
    previous = read_json(state / "config.json", {})
    if previous.get("mode") == "remote":
        raise FlowniumError("Use a separate --state-dir for private Iroh sharing to preserve your paired workspace.")
    if not re.fullmatch(r"[A-Za-z0-9_.+@-]{1,254}", args.username):
        raise FlowniumError("Use a sharing email or simple account name of at most 254 characters.")
    password = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else getpass.getpass("Sharing password (at least 12 characters): ")
    if len(password) < 12:
        raise FlowniumError("Use a sharing password of at least 12 characters.")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    encoded = "scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()
    save_json(state / "basic-auth.json", {"username": args.username, "password_hash": encoded,
                                         "secret": base64.b64encode(secrets.token_bytes(32)).decode()})
    config = base_config(args, "peer")
    config["hostname"] = "flownium.invalid"  # Auth origin marker; never advertised as a public URL.
    save_json(state / "config.json", config)
    return start(state)


def access(state, args):
    if not re.fullmatch(r"(?:node|endpoint)[a-z2-7]{40,4096}", args.ticket):
        raise FlowniumError("Use a valid Iroh endpoint ticket from 'nectit share'.")
    if not 1024 <= args.port <= 65535:
        raise FlowniumError("Use a local port between 1024 and 65535.")
    free_port(args.port)
    private_dir(state)
    process = spawn([executable(args.dumbpipe_bin, "dumbpipe"), "connect-tcp", "--addr", f"127.0.0.1:{args.port}", args.ticket],
                    state / "iroh-client.log", env=iroh_environment(state, client=True), cwd=str(Path.cwd()))
    def terminate_access(*_):
        raise KeyboardInterrupt
    previous_handler = signal.signal(signal.SIGTERM, terminate_access)
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise FlowniumError("The Iroh client stopped. See iroh-client.log.")
            try:
                with socket.create_connection(("127.0.0.1", args.port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.15)
        else:
            raise FlowniumError("The Iroh client did not become ready.")
        url = f"http://127.0.0.1:{args.port}"
        print(f"Local access URL: {url}\nSign in with the host's sharing credentials. Press Ctrl+C to disconnect.", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        process.wait()
    finally:
        stop_child(process)
        signal.signal(signal.SIGTERM, previous_handler)


def login(state, args):
    if daemon_running(state):
        raise FlowniumError("Turn remote access off before changing accounts.")
    previous = read_json(state / "config.json", {})
    from flownium_distribution import SERVICE_URL
    value = args.server or os.environ.get("FLOWNIUM_SERVER") or previous.get("server") or SERVICE_URL
    if not value:
        raise FlowniumError("Nectit's public account service is not deployed/configured yet. The operator must supply its URL with --server or FLOWNIUM_SERVER; users do not configure a domain or tunnel. Use './setup --mode host' for private Iroh sharing now.")
    server = server_url(value)
    installation = read_json(state / "installation.json")
    if not installation:
        installation = {"id": str(uuid.uuid4())}
        save_json(state / "installation.json", installation)
    grant = http_json(server + "/v1/cli/device", data={"client_id": "flownium-cli", "device_name": socket.gethostname(), "installation_id": installation["id"]}, timeout=15)
    required = {"device_code", "user_code", "verification_uri", "expires_in"}
    if not required.issubset(grant):
        raise FlowniumError("The account service returned an incomplete device sign-in response.")
    verification = urllib.parse.urlsplit(grant["verification_uri"])
    if (verification.scheme, verification.netloc) != (urllib.parse.urlsplit(server).scheme, urllib.parse.urlsplit(server).netloc):
        raise FlowniumError("The sign-in page must belong to the configured Nectit account service.")
    print(f"Sign in: {grant['verification_uri']}")
    print(f"Pairing code: {grant['user_code']}")
    if not args.no_browser:
        webbrowser.open(grant["verification_uri"])
    interval = max(1, min(int(grant.get("interval", 5)), 30))
    deadline = time.monotonic() + min(int(grant["expires_in"]), 900)
    while time.monotonic() < deadline:
        time.sleep(interval)
        result = http_json(server + "/v1/cli/token", data={"client_id": "flownium-cli", "device_code": grant["device_code"], "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}, timeout=15)
        if result.get("error") == "authorization_pending":
            continue
        if result.get("error") == "slow_down":
            interval += 5
            continue
        token = result.get("access_token")
        if not isinstance(token, str) or not token:
            raise FlowniumError("Sign-in did not return an access token.")
        config = base_config(args, "remote")
        enrollment = http_json(server + "/v1/devices", token=token, data={"name": socket.gethostname(), "local_port": config["port"], "kind": "hermes-dashboard", "transport": args.transport}, timeout=60)
        config.update(server=server, hostname=hostname(enrollment.get("hostname", "")), device_id=enrollment.get("device_id"))
        config["transport"] = enrollment.get("transport", "cloudflare" if enrollment.get("tunnel_token") else args.transport)
        if config["transport"] not in {"iroh", "cloudflare"}:
            raise FlowniumError("The account service returned an unsupported transport.")
        if enrollment.get("public_url"):
            public = urllib.parse.urlsplit(enrollment["public_url"])
            if public.scheme not in {"https", "http"} or public.username or public.password or public.fragment or public.query or not public.hostname:
                raise FlowniumError("The account service returned an invalid workspace URL.")
            if public.scheme == "http" and public.hostname not in {"localhost", "127.0.0.1"}:
                raise FlowniumError("Remote workspace URLs must use HTTPS.")
            config["public_url"] = enrollment["public_url"].rstrip("/")
        tunnel_token = enrollment.get("tunnel_token")
        if not config["device_id"] or (config["transport"] == "cloudflare" and (not isinstance(tunnel_token, str) or not tunnel_token.strip())):
            raise FlowniumError("The account service did not provision a device and tunnel credential.")
        if enrollment.get("oidc_issuer"):
            if server_url(enrollment["oidc_issuer"]) != server or enrollment.get("oidc_client_id") != config["device_id"]:
                raise FlowniumError("The workspace's login provider must be its Nectit account service.")
            config.update(oidc_issuer=server, oidc_client_id=config["device_id"])
        private_dir(state)
        if config["transport"] == "cloudflare":
            fd = os.open(state / "tunnel-token", os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(tunnel_token.strip())
        save_json(state / "session.json", {"server": server, "access_token": token})
        save_json(state / "config.json", config)
        print("Laptop paired. Workspace: " + config.get("public_url", f"https://{config['hostname']}"))
        print("Run 'nectit on' to start remote access.")
        return
    raise FlowniumError("The pairing code expired. Run 'nectit login' again.")


def logout(state):
    stop(state)
    config = read_json(state / "config.json", {})
    session = read_json(state / "session.json", {})
    if config.get("device_id"):
        if not session.get("access_token"):
            raise FlowniumError("The account credential is unavailable. Revoke this laptop from the Nectit service before deleting its local credentials.")
        http_json(config["server"] + "/v1/devices/" + urllib.parse.quote(config["device_id"], safe=""),
                  token=session["access_token"], method="DELETE", timeout=60)
    for filename in ("session.json", "tunnel-token", "config.json", "basic-auth.json", "iroh-key.json"):
        with contextlib.suppress(FileNotFoundError):
            (state / filename).unlink()
    print("Laptop disconnected from Nectit.")


def doctor(state, as_json):
    config = read_json(state / "config.json", {})
    checks = {"platform": sys.platform, "python": sys.version.split()[0],
              "hermes_installed": bool(shutil.which(config.get("hermes_bin", "hermes"))),
              "cloudflared_installed": bool(shutil.which(config.get("cloudflared_bin", "cloudflared"))),
              "iroh_installed": bool(shutil.which(config.get("dumbpipe_bin", "dumbpipe"))),
              "configured": bool(config), "mode": config.get("mode"),
              "paired_with_flownium": bool(config.get("device_id")),
              "controller_running": daemon_running(state),
              "status": snapshot(state)}
    if as_json:
        print(json.dumps(checks, indent=2))
    else:
        for key, value in checks.items():
            if key != "status":
                print(f"{key.replace('_', ' ').capitalize()}: {value}")
        print_status(checks["status"])


def app(state, args):
    server = HERE.parent / "app" / "server.mjs"
    if not server.is_file():
        raise FlowniumError("The desktop website runs from the source checkout. Clone the repository and run './nectit app' there.")
    node = shutil.which("node")
    if not node:
        raise FlowniumError("The local website requires Node.js 22+. Install Node, then rerun './nectit app'.")
    version = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        raise FlowniumError("The local website requires Node.js 22+.")
    if not 1024 <= args.port <= 65535:
        raise FlowniumError("Use an app port between 1024 and 65535.")
    free_port(args.port)
    env = os.environ.copy()
    env.update(FLOWNIUM_APP_PORT=str(args.port), FLOWNIUM_PYTHON=sys.executable)
    env.setdefault("FLOWNIUM_APP_HOST_STATE", str(state))
    env_file = HERE.parent / "work/local-app.env"
    node_command = [node, *(["--env-file=" + str(env_file)] if env_file.is_file() else []), str(server)]
    process = subprocess.Popen(node_command, cwd=HERE.parent, env=env, start_new_session=True)
    url = f"http://127.0.0.1:{args.port}"
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise FlowniumError("The local website could not start.")
            try:
                http_json(url + "/local/bootstrap")
                break
            except FlowniumError:
                time.sleep(0.15)
        else:
            raise FlowniumError("The local website did not become ready.")
        print(f"Open {url}\nPress Ctrl+C to stop the local app.", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        return process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=25)
            except subprocess.TimeoutExpired:
                stop_child(process)


def terminal_access(state, args):
    pointer = read_json(state / "app-connection.json", {})
    data_dir = Path(args.app_data or os.environ.get("FLOWNIUM_APP_DATA") or
                    pointer.get("data_dir") or HERE.parent / "work/local-app").expanduser().resolve()
    path = data_dir / "cli-access.json"
    if not path.is_file():
        raise FlowniumError("Start './nectit app' and connect your computer first. Use --app-data PATH for a different app directory.")
    if path.stat().st_mode & 0o077:
        raise FlowniumError("The terminal credential file must be private (chmod 600 cli-access.json).")
    access = read_json(path)
    origin = access.get("origin", "")
    try:
        parts = urllib.parse.urlsplit(origin)
        local_port = parts.port
    except (ValueError, TypeError):
        raise FlowniumError("Invalid local terminal access file. Restart './nectit app'.") from None
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or parts.username or parts.password or
            not local_port or parts.path or parts.query or parts.fragment or
            not re.fullmatch(r"[a-f0-9]{64}", access.get("token", ""))):
        raise FlowniumError("Invalid local terminal access file. Restart './nectit app'.")
    try:
        status = http_json(origin + "/cli/status", token=access["token"])
    except FlowniumError:
        raise FlowniumError("The Nectit app is unavailable. Start './nectit app' and connect your computer first.") from None
    if not status.get("connected"):
        raise FlowniumError("Connect your Hermes computer in the Nectit website first.")
    return access


def cli_chat(state, args):
    access = terminal_access(state, args)
    if args.profile and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.profile):
        raise FlowniumError("Use an existing Hermes profile name.")
    if args.resume and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", args.resume):
        raise FlowniumError("Use the session ID shown by Hermes or Nectit's CLI chats picker.")
    config = read_json(state / "config.json", {})
    binary = args.hermes_bin or config.get("hermes_bin") or "hermes"
    resolved = shutil.which(binary)
    if not resolved:
        raise FlowniumError("Install the Hermes CLI on this computer, or pass --hermes-bin PATH.")
    query = {"token": access["token"]}
    if args.profile:
        query["profile"] = args.profile
    env = os.environ.copy()
    env["HERMES_TUI_GATEWAY_URL"] = access["origin"].replace("http://", "ws://", 1) + "/cli/api/ws?" + urllib.parse.urlencode(query)
    command = [resolved, "--tui"]
    if args.resume:
        command += ["--resume", args.resume]
    print("Connected to Nectit. Open CLI chats in the web workspace to continue this conversation.", flush=True)
    # The credential stays in the environment, never in process arguments/output.
    return subprocess.call(command, env=env)


def pair_device(state, args):
    access = terminal_access(state, args)
    base = access["origin"] + "/cli/pair/"
    if args.pair_command == "code":
        result = http_json(base + "code", data={}, token=access["token"], timeout=25)
        print(result["code"])
        print("\nPaste into Nectit → Computer → Pair a computer.")
        print("Works once. Expires in 5 minutes. Keep this code private.")
        print("Host fingerprint: " + result["fingerprint"])
    elif args.pair_command == "devices":
        for device in http_json(base + "devices", token=access["token"])["devices"]:
            print(f"{device['id']}  {device['name']}  {'revoked' if device['revoked'] else 'paired'}")
    else:
        http_json(base + "revoke", data={"id": args.device_id}, token=access["token"])
        print("Device revoked. Its active connections have been closed.")
    return 0


def parser():
    result = argparse.ArgumentParser(description="Connect real Hermes on your laptop to Nectit.")
    result.add_argument("--version", action="version", version=VERSION)
    result.add_argument("--state-dir", default=os.environ.get("FLOWNIUM_STATE_DIR", str(Path.home() / ".config" / "flownium")))
    sub = result.add_subparsers(dest="command", required=True)
    for name, helptext in [("login", "Sign in and let Nectit assign your workspace"),
                           ("share", "Share real Hermes over Iroh with an email and password"),
                           ("local", "Connect to real local Hermes without publishing a tunnel")]:
        command = sub.add_parser(name, help=helptext)
        command.add_argument("--hermes-bin", default="hermes")
        command.add_argument("--cloudflared-bin", default="cloudflared")
        command.add_argument("--dumbpipe-bin", default="dumbpipe")
        command.add_argument("--port", type=int, default=19119)
        command.add_argument("--metrics-port", type=int, default=19120)
        command.add_argument("--workspace", default=str(Path.cwd()))
        command.add_argument("--profile")
        command.add_argument("--timeout", type=int, default=90)
        if name == "login":
            command.add_argument("--transport", choices=["iroh", "cloudflare"], default="iroh")
            command.add_argument("--server", help="Operator-supplied Nectit service origin")
            command.add_argument("--no-browser", action="store_true")
        if name == "share":
            command.add_argument("--email", "--username", dest="username", required=True)
            command.add_argument("--desktop", action="store_true", help="Serve the installed Hermes Desktop renderer through the Nectit browser adapter")
            command.add_argument("--password-stdin", action="store_true", help="Read the password from stdin instead of an interactive prompt")
    command = sub.add_parser("access", help="Open a shared Iroh endpoint through a loopback browser URL")
    command.add_argument("ticket")
    command.add_argument("--dumbpipe-bin", default="dumbpipe")
    command.add_argument("--port", type=int, default=19121)
    command.add_argument("--no-browser", action="store_true")
    command = sub.add_parser("app", help="Open the local desktop-style Hermes Agent website")
    command.add_argument("--port", type=int, default=8788)
    command.add_argument("--no-browser", action="store_true")
    command = sub.add_parser("cli", help="Start or resume a Hermes terminal chat shared with the web workspace")
    command.add_argument("--resume", metavar="SESSION_ID")
    command.add_argument("--profile")
    command.add_argument("--hermes-bin")
    command.add_argument("--app-data", help="Private app directory, when not using the running controller's app")
    command = sub.add_parser("pair", help="Pair another Nectit device with a one-time Iroh code")
    command.add_argument("--app-data")
    pairing = command.add_subparsers(dest="pair_command", required=True)
    pairing.add_parser("code", help="Create a one-use code that expires in five minutes")
    pairing.add_parser("devices", help="List paired devices")
    revoke = pairing.add_parser("revoke", help="Revoke a paired device and close its connections")
    revoke.add_argument("device_id")
    command = sub.add_parser("on", help="Start Hermes and the configured Iroh or Cloudflare transport")
    command.add_argument("--desktop", action="store_true", help="Use the installed desktop renderer for the Nectit web workspace")
    command = sub.add_parser("off", help="Stop only the processes managed by Nectit")
    command.add_argument("--if-run-id", help=argparse.SUPPRESS)
    sub.add_parser("logout", help="Stop remote access and revoke this laptop's connection")
    sub.add_parser("open", help="Open the configured Hermes workspace")
    for name in ("status", "doctor"):
        command = sub.add_parser(name)
        command.add_argument("--json", action="store_true")
    command = sub.add_parser("_serve", help=argparse.SUPPRESS)
    command.add_argument("run_id")
    return result


def main(argv=None):
    if os.name != "posix":
        print("Run the Nectit host on macOS, Linux, or Windows through WSL2.", file=sys.stderr)
        return 1
    args = parser().parse_args(argv)
    state = Path(args.state_dir).expanduser().resolve()
    try:
        if args.command in {"local", "login", "share"}:
            if not (1024 <= args.port <= 65535 and 1024 <= args.metrics_port <= 65535) or args.port == args.metrics_port:
                raise FlowniumError("Use two different ports between 1024 and 65535.")
            if not 1 <= args.timeout <= 600:
                raise FlowniumError("Startup timeout must be between 1 and 600 seconds.")
        if args.command == "_serve":
            return supervise(state, args.run_id)
        if args.command == "status":
            print_status(snapshot(state), args.json)
            return 0
        if args.command == "doctor":
            doctor(state, args.json)
            return 0
        if args.command == "access":
            access(state, args)
            return 0
        if args.command == "app":
            return app(state, args)
        if args.command == "cli":
            return cli_chat(state, args)
        if args.command == "pair":
            return pair_device(state, args)
        if args.command == "open":
            config = load_config(state)
            if config.get("desktop_renderer"):
                try:
                    running = http_json("http://127.0.0.1:8788/local/bootstrap")
                except FlowniumError:
                    running = {}
                if running.get("product") == "nectit":
                    webbrowser.open("http://127.0.0.1:8788")
                    print("http://127.0.0.1:8788")
                    return 0
                return app(state, argparse.Namespace(port=8788, no_browser=False))
            url = (config.get("public_url") or f"https://{config['hostname']}") if config["mode"] == "remote" else f"http://127.0.0.1:{config['port']}"
            webbrowser.open(url)
            print(url)
            return 0
        with lock(state / "command.lock"):
            if args.command == "login":
                login(state, args)
            elif args.command == "share":
                return share(state, args)
            elif args.command == "local":
                if daemon_running(state):
                    raise FlowniumError("Run 'nectit off' before changing host configuration.")
                previous = read_json(state / "config.json", {})
                if previous.get("mode") == "remote":
                    raise FlowniumError("Use a separate --state-dir for a local test so your paired workspace is preserved.")
                save_json(state / "config.json", base_config(args, "local"))
                return start(state)
            elif args.command == "on":
                if args.desktop:
                    config = load_config(state)
                    if config["mode"] != "peer":
                        raise FlowniumError("Use a private Iroh host for the Nectit desktop workspace.")
                    if not config.get("desktop_renderer"):
                        if not desktop_renderer(config["hermes_bin"]):
                            raise FlowniumError("Build Hermes Desktop first with hermes gui --build-only, or set HERMES_DESKTOP_DIST.")
                        stop(state)
                        config["desktop_renderer"] = True
                        save_json(state / "config.json", config)
                return start(state)
            elif args.command == "off":
                if args.if_run_id and snapshot(state).get("run_id") != args.if_run_id:
                    return 0
                stop(state)
            elif args.command == "logout":
                logout(state)
        return 0
    except (FlowniumError, OSError) as exc:
        print(f"Nectit: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nNectit: interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
