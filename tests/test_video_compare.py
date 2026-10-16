import asyncio
from fractions import Fraction
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK_ROOT.parents[1]))
sys.path.insert(0, str(PACK_ROOT))

import av
from aiohttp import web
import torch
import server
from comfy_api.latest import InputImpl, Types

with patch.object(server.PromptServer, "instance", SimpleNamespace(routes=web.RouteTableDef()), create=True):
    from video_compare import VideoCompare, capture_video, source_video_path, capture_existing_video


class VideoCompareTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="elvax-video-compare-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.root_patch = patch("video_compare.folder_paths.get_input_directory", return_value=str(self.root))
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def video(self, frames=24, fps=24, audio=False):
        images = torch.zeros(frames, 32, 48, 3)
        images[:, :, :, 0] = torch.linspace(0, 1, frames).view(-1, 1, 1)
        sound = {"waveform": torch.zeros(1, 2, round(frames / fps * 48000)), "sample_rate": 48000} if audio else None
        return InputImpl.VideoFromComponents(Types.VideoComponents(images=images, frame_rate=Fraction(fps), audio=sound))

    def capture_path(self, entry):
        return self.root / entry["subfolder"] / entry["filename"]

    def test_schema_has_two_optional_video_inputs_and_no_outputs(self):
        schema = VideoCompare.define_schema()
        self.assertEqual([value.id for value in schema.inputs], ["before_video", "after_video"])
        self.assertTrue(all(value.optional for value in schema.inputs))
        self.assertEqual(schema.outputs, [])
        self.assertTrue(schema.is_output_node)
        self.assertIn("elvax", schema.search_aliases)

    def test_components_capture_keeps_frames_rate_dimensions_and_audio(self):
        entry = capture_video(self.video(audio=True))
        with av.open(str(self.capture_path(entry))) as container:
            stream = container.streams.video[0]
            self.assertEqual((stream.width, stream.height), (48, 32))
            self.assertEqual(stream.average_rate, 24)
            self.assertEqual(len(container.streams.audio), 1)
            self.assertEqual(len(list(container.decode(video=0))), 24)

    def test_file_capture_streams_without_materializing_images(self):
        original = self.capture_path(capture_video(self.video()))
        video = InputImpl.VideoFromFile(str(original))
        with patch.object(video, "get_components", side_effect=AssertionError("Full frames loaded")), patch.object(video, "get_stream_source", side_effect=AssertionError("Full bytes loaded")):
            captured = self.capture_path(capture_video(video))
        original.unlink()
        self.assertEqual(InputImpl.VideoFromFile(str(captured)).get_frame_count(), 24)

    def test_list_capture_streams_and_does_not_depend_on_original_files(self):
        originals = [self.capture_path(capture_video(self.video(12))) for _ in range(2)]
        video = InputImpl.VideoFromList([InputImpl.VideoFromFile(str(path)) for path in originals])
        with patch.object(video, "get_components", side_effect=AssertionError("Full frames loaded")), patch.object(video, "get_stream_source", side_effect=AssertionError("Full bytes loaded")):
            captured = self.capture_path(capture_video(video))
        for path in originals:
            path.unlink()
        self.assertEqual(InputImpl.VideoFromFile(str(captured)).get_frame_count(), 24)

    def test_trim_is_honored(self):
        original = self.capture_path(capture_video(self.video(48)))
        trimmed = InputImpl.VideoFromFile(str(original), start_time=.5, duration=.5)
        captured = self.capture_path(capture_video(trimmed))
        self.assertAlmostEqual(InputImpl.VideoFromFile(str(captured)).get_duration(), .5, delta=.05)

    def test_captures_are_independent(self):
        before = capture_video(self.video(12))
        after = capture_video(self.video(24))
        self.assertNotEqual(before["filename"], after["filename"])
        self.assertEqual(InputImpl.VideoFromFile(str(self.capture_path(before))).get_frame_count(), 12)

    def test_invalid_source_paths_are_rejected(self):
        for entry in [
            {"filename": "../outside.mp4"}, {"filename": str(self.root.parent / "outside.mp4")},
            {"filename": "test.txt"}, {"filename": "clip.mp4", "type": "invalid"},
            {"filename": "clip.mp4", "subfolder": "../"},
        ]:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                source_video_path(entry)

    def test_missing_source_is_actionable(self):
        with self.assertRaisesRegex(FileNotFoundError, "Run the connected video node"):
            source_video_path({"filename": "missing.mp4"})

    def test_failed_capture_does_not_leave_partial_file(self):
        class BrokenVideo:
            def save_to(self, path):
                Path(path).touch()
                raise RuntimeError("Synthetic failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic failure"):
            capture_video(BrokenVideo())
        self.assertEqual(list((self.root / "Elvax/video_compare").iterdir()), [])

    def test_capture_route_uses_contained_file(self):
        entry = capture_video(self.video())
        class Request:
            async def json(self):
                return entry
        response = asyncio.run(capture_existing_video(Request()))
        self.assertEqual(response.status, 200)

    def test_execute_without_input_is_valid(self):
        VideoCompare.execute()

    def test_execution_uses_temporary_storage_until_capture_is_requested(self):
        with patch("video_compare.folder_paths.get_temp_directory", return_value=str(self.root / "temp")):
            result = VideoCompare.execute(self.video())
        entry = result.ui["elvax_compare_before_video"][0]
        self.assertEqual(entry["type"], "temp")
        self.assertTrue((self.root / "temp" / entry["subfolder"] / entry["filename"]).is_file())
        self.assertFalse((self.root / "Elvax/video_compare").exists())

    def test_execute_captures_each_connected_input_separately(self):
        with patch("video_compare.folder_paths.get_temp_directory", return_value=str(self.root / "temp")):
            result = VideoCompare.execute(self.video(12), self.video(24))
        before = result.ui["elvax_compare_before_video"][0]
        after = result.ui["elvax_compare_after_video"][0]
        self.assertNotEqual(before["filename"], after["filename"])
        self.assertEqual(InputImpl.VideoFromFile(str(self.root / "temp" / before["subfolder"] / before["filename"])).get_frame_count(), 12)
        self.assertEqual(InputImpl.VideoFromFile(str(self.root / "temp" / after["subfolder"] / after["filename"])).get_frame_count(), 24)

    def test_capture_route_rejects_invalid_and_missing_files(self):
        for entry, status in [({"filename": "../outside.mp4"}, 400), ({"filename": "missing.mp4"}, 404)]:
            class Request:
                async def json(self):
                    return entry
            self.assertEqual(asyncio.run(capture_existing_video(Request())).status, status)

    def test_bad_video_reports_an_actionable_route_error(self):
        (self.root / "broken.mp4").touch()
        class Request:
            async def json(self):
                return {"filename": "broken.mp4"}
        response = asyncio.run(capture_existing_video(Request()))
        self.assertEqual(response.status, 400)
        self.assertIn("Could not load video", response.text)


if __name__ == "__main__":
    unittest.main()
