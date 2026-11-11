#!/usr/bin/env python3
"""Collect visible 500px landscape display images, then atomically update homepage covers."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "https://500px.com/search?q=%E8%87%AA%E7%84%B6%E9%A3%8E%E6%99%AF&type=Photo"


def importer():
    spec = importlib.util.spec_from_file_location("guangying_cover_import", ROOT / "scripts" / "import-covers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def preserved_slides(covers: Path):
    """Retain existing non-500px covers without decoding/recompressing their files."""
    manifest = covers / "manifest.json"
    if not manifest.exists():
        manifest = covers / "fallback-manifest.json"
    if not manifest.exists():
        return []
    if manifest.stat().st_size > 1024 * 1024:
        raise ValueError("Existing cover manifest is too large.")
    data = json.loads(manifest.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("slides"), list):
        raise ValueError("Existing cover manifest is invalid; it has not been replaced.")
    result = []
    for slide in data["slides"]:
        if not isinstance(slide, dict) or not isinstance(slide.get("id"), str):
            raise ValueError("Existing cover entry is invalid.")
        if slide["id"].startswith("500px-"):
            continue
        url = slide.get("url", "")
        if not isinstance(url, str) or not url.startswith("/covers/"):
            raise ValueError("An existing cover points outside the cover pool.")
        relative = Path(url[len("/covers/"):])
        image = (covers / relative).resolve()
        if relative.is_absolute() or not image.is_relative_to(covers.resolve()) or not image.is_file():
            raise ValueError("An existing cover file is missing or outside the cover pool.")
        entry = {key: slide[key] for key in (
            "id", "url", "title", "subtitle", "author", "source", "credit", "displayOnly", "focalPoint", "width", "height"
        ) if key in slide}
        # Bundled generated artwork records provenance as prose, not an outbound source link.
        if not str(entry.get("source", "")).startswith(("http://", "https://")):
            entry["source"] = ""
        result.append(entry)
    return result


def publish_pool(config: Path, covers: Path, *, node="node"):
    retained = preserved_slides(covers)
    module = importer()
    covers.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cover-refresh-", dir=covers.parent) as directory:
        stage = Path(directory) / "covers"
        imported = module.build_pool(config, stage, node=node)
        new_manifest = json.loads((stage / "manifest.json").read_text(encoding="utf-8"))
        incoming = new_manifest["slides"]
        if not incoming or any(not slide["id"].startswith("500px-") for slide in incoming):
            raise ValueError("The collector returned no valid 500px images. Previous covers were retained.")
        if len(retained) + len(incoming) > module.MAX_SLIDES:
            raise ValueError("The cover pool would exceed 50 images. Existing covers were retained.")
        # Only optimized images and whitelisted public attribution enter the public directory.
        combined = stage / "combined-manifest.json"
        combined.write_text(json.dumps({
            "version": 1,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "slides": retained + incoming,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        covers.mkdir(parents=True, exist_ok=True)
        for slide in incoming:
            filename = Path(slide["url"]).name
            module.promote_public_file(stage / filename, covers / filename)
        module.promote_public_file(combined, covers / "manifest.json")
    return {"imported500px": imported["imported"], "retained": len(retained), "total": len(retained) + len(incoming), "manifest": str(covers / "manifest.json")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="500px search page.")
    parser.add_argument("--query", default="nature landscape", help="Text entered through the site's visible search field.")
    parser.add_argument("--count", type=int, default=6, help="1–6 landscape display photos (default: 6).")
    parser.add_argument("--browser", help="Installed Edge/Chromium executable; no existing browser profile is used.")
    parser.add_argument("--node", default="node")
    parser.add_argument("--sources", type=Path, help="Use a previously collected private JSON instead of opening the search page.")
    parser.add_argument("--collect-only", action="store_true", help="Collect source addresses without replacing homepage images.")
    args = parser.parse_args(argv)
    if not 1 <= args.count <= 6:
        parser.error("--count must be between 1 and 6")
    try:
        cache = ROOT / ".tools" / "cover-cache"
        cache.mkdir(parents=True, exist_ok=True)
        source = args.sources.resolve() if args.sources else cache / "500px-sources.json"
        if not args.sources:
            command = [args.node, str(ROOT / "scripts" / "collect-500px.mjs"), "--url", args.url,
                       "--query", args.query, "--limit", str(args.count), "--output", str(source),
                       "--download-dir", str(cache / "downloads")]
            if args.browser:
                command += ["--browser", args.browser]
            process = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240)
            if process.returncode:
                raise ValueError(process.stderr.strip() or "500px source collection failed; previous covers were retained.")
        if args.collect_only:
            result = {"collectedSources": str(source), "homepageChanged": False}
        else:
            result = publish_pool(source, ROOT / "public" / "covers", node=args.node)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as error:
        print(f"500px cover update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
