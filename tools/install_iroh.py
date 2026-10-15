#!/usr/bin/env python3
"""Install the pinned, checksum-verified official Iroh dumbpipe into a chosen directory."""
import argparse
import hashlib
import io
from pathlib import Path
import platform
import ssl
import tarfile
import urllib.request
import zipfile

VERSION = "0.39.0"
ASSETS = {
    ("Darwin", "arm64"): ("darwin-aarch64.tar.gz", "13f284b36f2df429487975878ac8890f50ddd7916d040d988f467a919b0fba3e"),
    ("Darwin", "x86_64"): ("darwin-x86_64.tar.gz", "4480d175d7888f8f705418cd81b1512aa3c29bb84bc0f8566424c32cdc636042"),
    ("Linux", "aarch64"): ("linux-aarch64.tar.gz", "8cd099afe80c69ac58bfbc975b28e29d41caea141f3dd396457345a739836a0e"),
    ("Linux", "x86_64"): ("linux-x86_64.tar.gz", "9ac5e71983eba4cf4f47e92e4694dad0f0133abba4f14dd2a2a8428cece88fef"),
    ("Windows", "AMD64"): ("windows-x86_64.zip", "a58f4e1f58281b6f5407baa6502c58cc824c41d8e0c418bbb6eea51bfd674856"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("work/bin"))
    args = parser.parse_args()
    asset = ASSETS.get((platform.system(), platform.machine()))
    if not asset:
        parser.error("No pinned binary for this platform; install dumbpipe from its official source.")
    suffix, digest = asset
    url = f"https://github.com/n0-computer/dumbpipe/releases/download/v{VERSION}/dumbpipe-v{VERSION}-{suffix}"
    context = ssl.create_default_context()
    if not ssl.get_default_verify_paths().cafile and Path('/etc/ssl/cert.pem').is_file():
        context.load_verify_locations('/etc/ssl/cert.pem')
    with urllib.request.urlopen(url, timeout=60, context=context) as response:
        archive = response.read(100_000_000)
    if hashlib.sha256(archive).hexdigest() != digest:
        raise SystemExit("Checksum mismatch; no executable was installed.")
    executable = "dumbpipe.exe" if platform.system() == "Windows" else "dumbpipe"
    # Read one known basename; never extract paths supplied by an archive.
    if suffix.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            candidates = [name for name in bundle.namelist() if Path(name).name == executable]
            if len(candidates) != 1:
                raise SystemExit("Unexpected archive layout.")
            content = bundle.read(candidates[0])
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            candidates = [member for member in bundle.getmembers() if member.isfile() and Path(member.name).name == executable]
            if len(candidates) != 1:
                raise SystemExit("Unexpected archive layout.")
            content = bundle.extractfile(candidates[0]).read()
    args.directory.mkdir(parents=True, exist_ok=True)
    target = args.directory / executable
    target.write_bytes(content)
    target.chmod(0o755)
    print(f"Installed official dumbpipe v{VERSION}: {target.resolve()}")


if __name__ == "__main__":
    main()
