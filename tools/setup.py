#!/usr/bin/env python3
"""Prepare and connect a real Hermes Agent installation from this checkout."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--mode", choices=["host", "client", "account"])
    result.add_argument("--check", action="store_true", help="Check prerequisites without downloading or starting anything")
    result.add_argument("--prepare-only", action="store_true", help="Install the transport without starting a connection")
    result.add_argument("--hermes-bin", default="hermes")
    result.add_argument("--dumbpipe-bin", help="Use an existing Iroh dumbpipe executable")
    result.add_argument("--state-dir")
    result.add_argument("--username")
    result.add_argument("--password-stdin", action="store_true")
    result.add_argument("--ticket", help="Endpoint ticket from the hosting computer")
    result.add_argument("--server", help="Deployed account-service origin, for account mode")
    result.add_argument("--port", type=int)
    result.add_argument("--metrics-port", type=int)
    result.add_argument("--workspace", default=str(Path.cwd()))
    result.add_argument("--profile")
    result.add_argument("--no-browser", action="store_true")
    return result


def existing(value):
    found = shutil.which(value)
    return str(Path(found).resolve()) if found else None


def ask(prompt):
    if not sys.stdin.isatty():
        raise ValueError(prompt + " Supply the corresponding command option when stdin is not interactive.")
    return input(prompt + " ").strip()


def main(argv=None):
    options = parser()
    args = options.parse_args(argv)
    if os.name != "posix" or sys.version_info < (3, 10):
        options.error("Use Python 3.10+ on macOS, Linux, or Windows through WSL2.")
    try:
        hermes = existing(args.hermes_bin)
        binary = existing(args.dumbpipe_bin) if args.dumbpipe_bin else existing(str(ROOT / "work/bin/dumbpipe")) or existing("dumbpipe")
        if args.dumbpipe_bin and not binary:
            raise ValueError("The supplied dumbpipe executable does not exist or is not executable.")
        print("Flownium connector for Hermes Agent", flush=True)
        if args.check:
            print(f"Python: {sys.version.split()[0]}\nHermes: {hermes or 'not installed'}\nIroh: {binary or 'not prepared; run ./setup'}")
            return 0 if binary and (hermes or args.mode == "client") else 1
        mode = args.mode
        if not mode and not args.prepare_only:
            print("1. Share Hermes on this computer\n2. Connect to another computer\n3. Pair with a hosted Flownium account")
            mode = {"1": "host", "2": "client", "3": "account"}.get(ask("Choose 1, 2, or 3:"))
            if not mode:
                raise ValueError("Choose a setup mode: host, client, or account.")
        if mode in {"host", "account"} and not hermes:
            raise ValueError("Hermes Agent is not installed. Install and configure Hermes first: https://hermes-agent.nousresearch.com/docs/getting-started/installation — then rerun ./setup. You can also supply --hermes-bin PATH.")
        if not binary:
            print("Preparing the pinned official Iroh transport (checksum verified)…", flush=True)
            subprocess.run([sys.executable, str(ROOT / "tools/install_iroh.py"), "--directory", str(ROOT / "work/bin")], check=True)
            binary = str(ROOT / "work/bin/dumbpipe")
        if args.prepare_only:
            print("Transport ready. Run ./setup to connect, or ./setup --mode client to open another computer.")
            return 0
        command = [sys.executable, str(ROOT / "flownium_cli.py")]
        if args.state_dir:
            command += ["--state-dir", args.state_dir]
        if mode == "client":
            ticket = args.ticket or ask("Paste the host's Iroh endpoint ticket:")
            command += ["access", ticket, "--dumbpipe-bin", binary]
        else:
            if mode == "host":
                username = args.username or ask("Choose a sharing username:")
                command += ["share", "--username", username]
                if args.password_stdin:
                    command.append("--password-stdin")
            else:
                command += ["login", "--transport", "iroh"]
                if args.server:
                    command += ["--server", args.server]
            command += ["--hermes-bin", hermes, "--dumbpipe-bin", binary, "--workspace", args.workspace]
            if args.metrics_port is not None:
                command += ["--metrics-port", str(args.metrics_port)]
            if args.profile:
                command += ["--profile", args.profile]
        if args.port is not None:
            command += ["--port", str(args.port)]
        if args.no_browser and mode != "host":
            command.append("--no-browser")
        code = subprocess.call(command)  # Inherit stdin; passwords never enter argv or logs.
        if code:
            return code
        if mode == "account":
            code = subprocess.call([sys.executable, str(ROOT / "flownium_cli.py"),
                                    *(["--state-dir", args.state_dir] if args.state_dir else []), "on"])
            if code:
                return code
        if mode != "client":
            launcher = [str(ROOT / "flownium"), *(["--state-dir", args.state_dir] if args.state_dir else [])]
            print("\nConnection ready. Manage it with:", flush=True)
            for action in ("status", "off", "on", "doctor"):
                print("  " + shlex.join([*launcher, action]))
            print("Keep this computer awake and online. Existing independent Hermes sessions are preserved.")
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Setup: {error}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nSetup interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
