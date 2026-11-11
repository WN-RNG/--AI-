"""Run: python -m unittest discover -s tests -p test_cover_import.py"""
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "scripts" / "import-covers.py"
SPEC = importlib.util.spec_from_file_location("cover_import", MODULE)
cover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cover)


class CoverImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.image = self.root / "photo.jpg"
        self.image.write_bytes(b"photo-fixture")

    def config(self, slides, hosts=None):
        config = self.root / "sources.json"
        config.write_text(json.dumps({"allowedHosts": hosts or [], "slides": slides}), encoding="utf-8")
        return config

    def test_search_page_and_redirect_destinations_are_not_image_sources(self):
        with self.assertRaisesRegex(cover.ImportFailure, "search page"):
            cover.validate_remote_url("https://500px.com/search?q=nature&type=Photo", {"500px.com"})
        for url in ("http://images.example/image.jpg", "https://images.example:444/image.jpg",
                    "https://user:password@images.example/image.jpg", "https://other.example/image.jpg"):
            with self.subTest(url=url), self.assertRaises(cover.ImportFailure):
                cover.validate_remote_url(url, {"images.example"})

    def test_private_loopback_and_mixed_dns_are_rejected(self):
        for addresses in (["127.0.0.1"], ["::1"], ["192.168.1.1"], ["93.184.215.14", "10.0.0.1"]):
            records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]
            with self.subTest(addresses=addresses), patch.object(cover.socket, "getaddrinfo", return_value=records):
                with self.assertRaisesRegex(cover.ImportFailure, "private"):
                    cover.public_addresses("images.example")

    def test_ids_cannot_escape_output_and_duplicates_are_rejected(self):
        for entry_id in ("../outside", "nested/cover", "", "a.webp"):
            with self.subTest(entry_id=entry_id), self.assertRaises(cover.ImportFailure):
                cover.load_sources(self.config([{"id": entry_id, "file": "photo.jpg"}]))
        with self.assertRaisesRegex(cover.ImportFailure, "Duplicate"):
            cover.load_sources(self.config([{"id": "same", "file": "photo.jpg"}] * 2))

    def test_dry_run_does_not_write_or_download(self):
        config = self.config([{"file": "photo.jpg"}, {"url": "https://images.example/photo.jpg"}], ["images.example"])
        output = self.root / "public" / "covers"
        with patch.object(cover, "download_image", side_effect=AssertionError("Unexpected download")):
            result = cover.build_pool(config, output, dry_run=True)
        self.assertEqual(result["validatedSources"], 2)
        self.assertFalse(output.parent.exists())

    def test_failed_import_retains_existing_manifest(self):
        output = self.root / "public" / "covers"
        output.mkdir(parents=True)
        manifest = output / "manifest.json"
        manifest.write_text('{"previous":true}', encoding="utf-8")
        config = self.config([{"file": "photo.jpg"}])
        failed = type("Process", (), {"returncode": 1, "stderr": "invalid image"})()
        with patch.object(cover.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(cover.ImportFailure, "invalid image"):
                cover.build_pool(config, output)
        self.assertEqual(manifest.read_text(encoding="utf-8"), '{"previous":true}')
        self.assertEqual([item.name for item in output.iterdir()], ["manifest.json"])

    def test_duplicate_content_collapses_and_private_paths_stay_out_of_manifest(self):
        def fake_prepare(arguments, **_):
            Path(arguments[-1]).write_bytes(b"optimized")
            return type("Process", (), {"returncode": 0, "stdout": '{"width":800,"height":600}', "stderr": ""})()

        config = self.config([{"id": "first", "file": "photo.jpg"}, {"id": "second", "file": "photo.jpg"}])
        output = self.root / "public" / "covers"
        with patch.object(cover.subprocess, "run", side_effect=fake_prepare):
            result = cover.build_pool(config, output)
        self.assertEqual(result["imported"], 1)
        self.assertEqual(result["duplicatesSkipped"], 1)
        manifest_text = (output / "manifest.json").read_text(encoding="utf-8")
        self.assertNotIn(str(self.root), manifest_text)
        slide = json.loads(manifest_text)["slides"][0]
        self.assertEqual(slide["id"], "first")
        self.assertTrue(slide["displayOnly"])
        self.assertTrue((output / Path(slide["url"]).name).is_file())

    def test_public_promotion_failure_preserves_destination_and_cleans_sibling(self):
        output = self.root / "public"
        output.mkdir()
        target = output / "manifest.json"
        target.write_bytes(b"previous publication")
        source = self.root / "private-manifest.json"
        source.write_bytes(b"new publication")
        with patch.object(cover.os, "replace", side_effect=PermissionError("locked publication")):
            with self.assertRaisesRegex(PermissionError, "locked publication"):
                cover.promote_public_file(source, target)
        self.assertEqual(target.read_bytes(), b"previous publication")
        self.assertEqual(source.read_bytes(), b"new publication")
        self.assertEqual([item.name for item in output.iterdir()], ["manifest.json"])


if __name__ == "__main__":
    unittest.main()
