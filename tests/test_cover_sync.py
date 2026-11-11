"""Run with the project Python: -X utf8 -B -m unittest discover -s tests -p test_cover_sync.py."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cover_sync", PROJECT / "scripts" / "sync-500px-covers.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class CoverSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cover-sync-test-", dir=Path(__file__).parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.covers = self.root / "public" / "covers"
        self.covers.mkdir(parents=True)
        fallback = json.loads((PROJECT / "public" / "covers" / "fallback-manifest.json").read_text(encoding="utf-8"))
        self.originals = fallback["slides"][:3]
        for entry in self.originals:
            filename = Path(entry["url"]).name
            (self.covers / filename).write_bytes((PROJECT / "public" / "covers" / filename).read_bytes())
        self.raw = (self.covers / Path(self.originals[0]["url"]).name).read_bytes()
        self.original_files = {
            file.name: (hashlib.sha256(file.read_bytes()).hexdigest(), file.stat().st_mtime_ns)
            for file in self.covers.iterdir()
        }
        (self.covers / "fallback-manifest.json").write_text(json.dumps(fallback), encoding="utf-8")

    def incoming(self, entry_id="500px-new", filename="new-500px.webp"):
        return {
            "id": entry_id, "url": "/covers/" + filename, "title": "A quiet landscape",
            "subtitle": "", "author": "Photographer", "credit": "Homepage display",
            "source": "https://500px.com/photo/123456/landscape", "displayOnly": True,
            "focalPoint": {"x": 50, "y": 50}, "width": 800, "height": 600,
        }

    def fake_importer(self, entries=None, error=None):
        incoming = [self.incoming()] if entries is None else entries

        def build_pool(_config, output, **_options):
            if error:
                raise error
            output.mkdir(parents=True)
            for entry in incoming:
                (output / Path(entry["url"]).name).write_bytes(self.raw)
            (output / "manifest.json").write_text(json.dumps({"version": 1, "slides": incoming}), encoding="utf-8")
            return {"imported": len(incoming)}

        return SimpleNamespace(MAX_SLIDES=50, build_pool=build_pool,
                               promote_public_file=sync.importer().promote_public_file)

    def seed_current(self):
        old = self.incoming("500px-old", "old-500px.webp")
        (self.covers / "old-500px.webp").write_bytes(self.raw)
        content = json.dumps({"version": 1, "slides": self.originals + [old]}, ensure_ascii=False).encode("utf-8")
        (self.covers / "manifest.json").write_bytes(content)
        return content

    def assert_originals_unchanged(self):
        for filename, (digest, modified) in self.original_files.items():
            file = self.covers / filename
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), digest)
            self.assertEqual(file.stat().st_mtime_ns, modified, "Original cover was rewritten")

    def test_real_download_pipeline_retains_three_originals_without_recompression(self):
        private_url = "https://images.photographer.example/display.webp?token=PRIVATE_TEST_MARKER"
        config = self.root / "private-sources.json"
        config.write_text(json.dumps({"allowedHosts": ["images.photographer.example"], "slides": [{
            "id": "500px-real", "url": private_url, "title": "A quiet landscape",
            "author": "Photographer", "source": "https://500px.com/photo/123456/landscape",
            "credit": "Homepage display",
        }]}), encoding="utf-8")
        module = sync.importer()
        with patch.object(sync, "importer", return_value=module), patch.object(module, "download_image", return_value=self.raw) as download:
            result = sync.publish_pool(config, self.covers)
        self.assertEqual((result["imported500px"], result["retained"], result["total"]), (1, 3, 4))
        download.assert_called_once_with(private_url, {"images.photographer.example"})
        text = (self.covers / "manifest.json").read_text(encoding="utf-8")
        manifest = json.loads(text)
        self.assertEqual([slide["id"] for slide in manifest["slides"][:3]], [slide["id"] for slide in self.originals])
        self.assertNotIn("PRIVATE_TEST_MARKER", text)
        self.assertNotIn(str(self.root), text)
        imported = manifest["slides"][-1]
        self.assertTrue((self.covers / Path(imported["url"]).name).is_file())
        self.assertLessEqual(imported["width"], 2560)
        self.assertLessEqual(imported["height"], 1800)
        self.assert_originals_unchanged()

    def test_refresh_replaces_only_500px_entries_and_keeps_old_asset_urls(self):
        self.seed_current()
        with patch.object(sync, "importer", return_value=self.fake_importer()):
            result = sync.publish_pool(self.root / "sources.json", self.covers)
        ids = [entry["id"] for entry in json.loads((self.covers / "manifest.json").read_text(encoding="utf-8"))["slides"]]
        self.assertNotIn("500px-old", ids)
        self.assertEqual(ids[-1], "500px-new")
        self.assertEqual(result["retained"], 3)
        self.assertTrue((self.covers / "old-500px.webp").is_file(), "Existing readers must retain their image URL")
        self.assert_originals_unchanged()

    def test_invalid_collector_ids_leave_existing_manifest_and_images_unchanged(self):
        before = self.seed_current()
        with patch.object(sync, "importer", return_value=self.fake_importer([self.incoming("unrelated-photo")])):
            with self.assertRaisesRegex(ValueError, "no valid 500px"):
                sync.publish_pool(self.root / "sources.json", self.covers)
        self.assertEqual((self.covers / "manifest.json").read_bytes(), before)
        self.assertFalse((self.covers / "new-500px.webp").exists())
        self.assert_originals_unchanged()

    def test_final_manifest_promotion_failure_preserves_previous_publication(self):
        before = self.seed_current()
        replace = os.replace

        def fail_public_manifest(source, destination):
            if Path(destination) == self.covers / "manifest.json":
                raise PermissionError("Simulated manifest lock")
            return replace(source, destination)

        with patch.object(sync, "importer", return_value=self.fake_importer()), patch.object(os, "replace", side_effect=fail_public_manifest):
            with self.assertRaisesRegex(PermissionError, "manifest lock"):
                sync.publish_pool(self.root / "sources.json", self.covers)
        self.assertEqual((self.covers / "manifest.json").read_bytes(), before)
        self.assertTrue((self.covers / "old-500px.webp").is_file())
        self.assert_originals_unchanged()

    def test_existing_manifest_cannot_reference_files_outside_cover_directory(self):
        outside = self.root / "public" / "outside.webp"
        outside.write_bytes(self.raw)
        neighbor = self.root / "public" / "covers-neighbor"
        neighbor.mkdir()
        (neighbor / "image.webp").write_bytes(self.raw)
        for relative in ("../outside.webp", "../covers-neighbor/image.webp", "..\\outside.webp"):
            entry = {**self.originals[0], "url": "/covers/" + relative}
            before = json.dumps({"version": 1, "slides": [entry]}).encode("utf-8")
            (self.covers / "manifest.json").write_bytes(before)
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, "outside"):
                sync.preserved_slides(self.covers)
            self.assertEqual((self.covers / "manifest.json").read_bytes(), before)
        self.assert_originals_unchanged()

    def test_http_failure_returns_concise_cli_error_and_keeps_previous_manifest(self):
        before = self.seed_current()
        output, errors = io.StringIO(), io.StringIO()
        broken = self.fake_importer(error=http.client.IncompleteRead(b"short body", 100))
        with patch.object(sync, "ROOT", self.root), patch.object(sync, "importer", return_value=broken), redirect_stdout(output), redirect_stderr(errors):
            status = sync.main(["--sources", str(self.root / "sources.json")])
        self.assertEqual(status, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("500px cover update failed:", errors.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())
        self.assertEqual((self.covers / "manifest.json").read_bytes(), before)
        self.assert_originals_unchanged()


if __name__ == "__main__":
    unittest.main()
