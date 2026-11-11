#!/usr/bin/env python3
"""Import explicitly selected, authorized cover images, without scraping search pages.

Python 3.10+ standard library + the project's existing Node/Sharp installation.
Downloads use explicit HTTPS host allowlists, pinned public IPs and bounded reads.
Only a complete successful import replaces the public manifest; originals stay private.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urljoin, urlsplit

MAX_BYTES = 30 * 1024 * 1024
MAX_SLIDES = 50
MAX_REDIRECTS = 3
TIMEOUT = 20
TOTAL_TIMEOUT = 60
RECIPE = b"cover-webp-2560x1800-v1\0"
REPO_ROOT = Path(__file__).resolve().parents[1]
MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


class ImportFailure(ValueError):
    """A recoverable source/configuration error; the existing pool stays unchanged."""


def text(value: object, name: str, default: str = "", limit: int = 240) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or len(value) > limit or any(ord(character) < 32 for character in value):
        raise ImportFailure(f"{name} must be text of at most {limit} characters.")
    return value.strip()


def canonical_host(value: str) -> str:
    try:
        return value.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ImportFailure("Invalid download host.") from error


def validate_remote_url(url: str, allowed_hosts: set[str]):
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise ImportFailure("Invalid image download URL.") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in (None, 443)
        or any(ord(character) < 32 for character in url)
    ):
        raise ImportFailure("Downloads require an HTTPS URL without credentials or custom ports.")
    host = canonical_host(parsed.hostname)
    if host not in allowed_hosts:
        raise ImportFailure(f"Download host {host} is not in allowedHosts.")
    if parsed.path.rstrip("/").lower() in ("/search", "/search/photos"):
        raise ImportFailure(
            "A search page is not an image download source. Supply an authorized image file "
            "or an explicitly permitted direct image URL; no login/captcha bypass is attempted."
        )
    return parsed, host


def public_addresses(host: str) -> list[str]:
    try:
        records = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise ImportFailure(f"Could not resolve download host {host}.") from error
    addresses = list(dict.fromkeys(record[4][0] for record in records))
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ImportFailure("Downloads to private, loopback or reserved addresses are blocked.")
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to the validated IP while retaining hostname certificate checks and SNI."""

    def __init__(self, host: str, address: str, timeout: float = TIMEOUT):
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        connection = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(connection, server_hostname=self.host)
        except BaseException:
            connection.close()
            raise


def download_image(url: str, allowed_hosts: set[str]) -> bytes:
    deadline = time.monotonic() + TOTAL_TIMEOUT
    for redirect in range(MAX_REDIRECTS + 1):
        parsed, host = validate_remote_url(url, allowed_hosts)
        address = public_addresses(host)[0]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ImportFailure("Image download exceeded its 60-second time limit.")
        connection = PinnedHTTPSConnection(host, address, min(TIMEOUT, remaining))
        try:
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            connection.request(
                "GET", target,
                headers={"User-Agent": "Guangying-CoverImporter/1.0", "Accept": ", ".join(sorted(MIME_TYPES))},
            )
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location or redirect == MAX_REDIRECTS:
                    raise ImportFailure("Image download exceeded the redirect limit.")
                url = urljoin(url, location)
                continue  # Every redirected host/address is checked again.
            if response.status != 200:
                raise ImportFailure(f"Image download returned HTTP {response.status}; no retry/bypass attempted.")
            mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if mime not in MIME_TYPES:
                raise ImportFailure("Download is not a JPG/PNG/WebP image (HTML/search/login pages are unsupported).")
            length = response.getheader("Content-Length")
            if length and (not length.isdigit() or int(length) > MAX_BYTES):
                raise ImportFailure("Remote cover exceeds the 30 MiB download limit.")
            body = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ImportFailure("Image download exceeded its 60-second time limit.")
                if connection.sock:
                    connection.sock.settimeout(min(TIMEOUT, remaining))
                chunk = response.read(min(64 * 1024, MAX_BYTES + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise ImportFailure("Remote cover exceeds the 30 MiB download limit.")
            if not body:
                raise ImportFailure("Downloaded image is empty.")
            return bytes(body)
        finally:
            connection.close()
    raise ImportFailure("Image download failed.")


def load_sources(config_path: Path):
    if config_path.stat().st_size > 1024 * 1024:
        raise ImportFailure("Source configuration is too large.")
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict):
        raise ImportFailure("Source configuration must be an object.")
    allowed = config.get("allowedHosts", [])
    if not isinstance(allowed, list) or len(allowed) > 20 or any(not isinstance(host, str) for host in allowed):
        raise ImportFailure("allowedHosts must contain at most 20 exact hostnames.")
    hosts = {canonical_host(host) for host in allowed}
    if any(not host or any(character in host for character in "/:@?#* ") for host in hosts):
        raise ImportFailure("allowedHosts accepts exact hostnames, without wildcards, credentials or ports.")
    slides = config.get("slides")
    if not isinstance(slides, list) or not 1 <= len(slides) <= MAX_SLIDES:
        raise ImportFailure(f"slides must contain 1–{MAX_SLIDES} explicitly selected images.")
    validated = []
    ids = set()
    for index, slide in enumerate(slides, 1):
        if not isinstance(slide, dict):
            raise ImportFailure(f"Slide {index} must be an object.")
        entry_id = text(slide.get("id"), "id", f"cover-{index}", 64)
        if not entry_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in entry_id):
            raise ImportFailure("Slide id accepts only letters, numbers, hyphens and underscores.")
        if entry_id in ids:
            raise ImportFailure(f"Duplicate slide id: {entry_id}")
        ids.add(entry_id)
        file = text(slide.get("file"), "file", limit=2048)
        url = text(slide.get("url"), "url", limit=4096)
        if bool(file) == bool(url):
            raise ImportFailure(f"Slide {entry_id}: supply exactly one file or url.")
        entry = {"id": entry_id, "displayOnly": True}
        for field in ("title", "subtitle", "author", "credit"):
            entry[field] = text(slide.get(field), field)
        entry["title"] = entry["title"] or "STILL MOMENTS"
        # Never publish a private/signed download URL automatically.
        source = text(slide.get("source"), "source", "", 4096)
        if source:
            reference = urlsplit(source)
            if reference.scheme not in ("https", "http") or not reference.hostname or reference.username or reference.password:
                raise ImportFailure("Public source attribution must be an HTTP(S) page URL without credentials.")
        entry["source"] = source
        point = slide.get("focalPoint", {"x": 50, "y": 50})
        if not isinstance(point, dict):
            raise ImportFailure("focalPoint must contain x and y percentages.")
        coordinates = {}
        for axis in ("x", "y"):
            value = point.get(axis, 50)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 100:
                raise ImportFailure("focalPoint x/y must be finite percentages from 0 to 100.")
            coordinates[axis] = value
        entry["focalPoint"] = coordinates
        if url:
            validate_remote_url(url, hosts)
            origin = ("url", url)
        else:
            local = (config_path.parent / file).resolve()
            if not local.is_file() or not 0 < local.stat().st_size <= MAX_BYTES:
                raise ImportFailure(f"Slide {entry_id}: local image is missing, empty or larger than 30 MiB.")
            origin = ("file", local)
        validated.append((entry, origin))
    return validated, hosts


def promote_public_file(source: Path, destination: Path):
    """Copy into a normal sibling before atomic publication, preserving public directory ACLs.

    Python's private temporary directories intentionally have restrictive Windows ACLs.
    Moving their files directly into public/covers would retain those private ACLs.
    A regular exclusive open in the public directory inherits its existing permissions;
    copying bytes (not metadata/ACLs) keeps the private staging area unchanged.
    """
    source, destination = Path(source), Path(destination)
    sibling = destination.parent / (".cover-publish-" + uuid.uuid4().hex + ".tmp")
    try:
        with source.open("rb") as original, sibling.open("xb") as public_file:
            shutil.copyfileobj(original, public_file, length=64 * 1024)
            public_file.flush()
            os.fsync(public_file.fileno())
        os.replace(sibling, destination)
    finally:
        sibling.unlink(missing_ok=True)


def build_pool(config_path: Path, output: Path, *, dry_run=False, node="node"):
    entries, hosts = load_sources(config_path)
    if dry_run:
        return {"dryRun": True, "validatedSources": len(entries), "networkRequests": 0}
    output.parent.mkdir(parents=True, exist_ok=True)
    published = []
    hashes = set()
    # Keep source processing private; publication creates normal public-directory siblings.
    with tempfile.TemporaryDirectory(prefix=".cover-import-", dir=output.parent) as temporary:
        stage = Path(temporary)
        prepared = []
        for entry, (kind, source) in entries:
            if kind == "file":
                with Path(source).open("rb") as image_file:
                    raw = image_file.read(MAX_BYTES + 1)
            else:
                raw = download_image(source, hosts)
            if not 0 < len(raw) <= MAX_BYTES:
                raise ImportFailure("Cover source is empty or exceeds 30 MiB.")
            digest = hashlib.sha256(RECIPE + raw).hexdigest()
            if digest in hashes:
                continue
            hashes.add(digest)
            filename = digest[:24] + ".webp"
            original = stage / (digest + ".input")
            optimized = stage / filename
            original.write_bytes(raw)
            process = subprocess.run(
                [node, str(REPO_ROOT / "scripts" / "prepare-cover.mjs"), str(original), str(optimized)],
                check=False, capture_output=True, text=True, encoding="utf-8", timeout=90,
            )
            if process.returncode != 0:
                raise ImportFailure(f"Slide {entry['id']}: {process.stderr.strip() or 'image optimization failed.'}")
            details = json.loads(process.stdout)
            entry.update({"url": "/covers/" + filename, "width": details["width"], "height": details["height"]})
            published.append(entry)
            prepared.append((optimized, output / filename))
        manifest = stage / "manifest.json"
        manifest.write_text(json.dumps({"version": 1, "slides": published}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output.mkdir(parents=True, exist_ok=True)
        for optimized, destination in prepared:
            # Existing readers keep their image URLs; obsolete files are not automatically deleted.
            promote_public_file(optimized, destination)
        promote_public_file(manifest, output / "manifest.json")
    return {"imported": len(published), "duplicatesSkipped": len(entries) - len(published), "manifest": str(output / "manifest.json")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="Private JSON listing selected authorized source files/URLs.")
    parser.add_argument("--dry-run", action="store_true", help="Validate configuration/local files without downloads or writes.")
    parser.add_argument("--node", default="node", help="Node executable (default: node).")
    args = parser.parse_args(argv)
    try:
        result = build_pool(args.config.resolve(), REPO_ROOT / "public" / "covers", dry_run=args.dry_run, node=args.node)
    except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as error:
        print(f"Cover import failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
