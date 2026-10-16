import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import queue
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

PACK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK_ROOT.parents[1]))
sys.path.insert(0, str(PACK_ROOT))

import av
import torch
import nodes
from comfy.utils import ProgressBar
from post_processing import PostProcessing, Types, video_encoder_options


class LinearRife:
    device = torch.device("cpu")

    def __init__(self):
        self.previous_frame = None
        self.ensemble_values = []

    def make_inference(self, model, img0, img1, timestep, ensemble):
        if self.previous_frame is not None and timestep == 1 / 3:
            assert img0 is self.previous_frame
        self.previous_frame = img1
        self.ensemble_values.append(ensemble)
        return img0.lerp(img1, timestep)


class PostProcessingTests(unittest.TestCase):
    def test_compression_settings_and_encoded_output(self):
        inputs = PostProcessing.INPUT_TYPES()["required"]
        names = list(inputs)
        self.assertEqual(names[names.index("saturation_mix") + 1:names.index("saturation_mix") + 3],
                         ["compress", "crf"])
        self.assertTrue(inputs["compress"][1]["default"])
        self.assertEqual(inputs["crf"][1]["default"], 18)
        images = torch.rand(12, 64, 64, 3)
        sizes = []
        for compress, crf, expected in [(False, 22, 0), (True, 18, 18), (True, 22, 22)]:
            with self.subTest(compress=compress, crf=crf), \
                    patch("post_processing.video_encoder_options", wraps=video_encoder_options) as options:
                video, fps, _ = PostProcessing().process(
                    images, upscale=False, interpolate=False, grain=False, compress=compress, crf=crf)
                self.addCleanup(video._elvax_temp_dir.cleanup)
                options.assert_called_once_with(Types.VideoCodec.H264, expected, "ultrafast")
                path = os.path.join(video._elvax_temp_dir.name, "video.mp4")
                sizes.append(os.path.getsize(path))
                with av.open(path) as container:
                    self.assertEqual(container.streams.video[0].pix_fmt, "yuv420p")
                    self.assertEqual(len(list(container.decode(video=0))), len(images))
                self.assertEqual(fps, 24)
        self.assertLess(sizes[1], sizes[0])
        self.assertLess(sizes[2], sizes[0])

    def test_interpolated_order_and_frame_reuse_across_modes(self):
        images = torch.linspace(0, 0.9, 70).view(70, 1, 1, 1).expand(70, 16, 16, 3)
        for mode, upscale in [(mode, upscale) for mode in PostProcessing._GROUP_MODES for upscale in (False, True)]:
            with self.subTest(mode=mode, upscale=upscale):
                rife = LinearRife()
                dual_pass_rife = mode != "full sequence"
                bars = []
                scaled_frames = []
                native_upscale = nodes.ImageScaleBy.upscale

                def counted_upscale(node, image, method, scale):
                    scaled_frames.append(len(image))
                    return native_upscale(node, image, method, scale)

                def progress_bar(*args, **kwargs):
                    bar = ProgressBar(*args, **kwargs)
                    bars.append(bar)
                    return bar

                with patch.object(PostProcessing, "_open_rife", return_value=(rife, None)), \
                        patch.object(PostProcessing, "_close_rife"), \
                        patch("comfy.utils.ProgressBar", side_effect=progress_bar), \
                        patch.object(nodes.ImageScaleBy, "upscale", counted_upscale):
                    video, fps, stats = PostProcessing().process(
                        images, upscale=upscale, interpolate_by=3, original_fps=23.976,
                        dual_pass_rife=dual_pass_rife, grain=False,
                        batching_mode=mode, custom_batch_size=1)
                self.assertEqual(sum(scaled_frames), len(images) if upscale else 0)
                self.assertEqual(video.get_dimensions(), (32, 32) if upscale else (16, 16))
                self.assertEqual(len(video.videos), 1)
                self.assertEqual(bars[0].current, bars[0].total)
                self.addCleanup(video._elvax_temp_dir.cleanup)
                self.assertEqual(video.get_bit_depth(), 8)
                self.assertEqual(video.get_frame_count(), 208)
                self.assertAlmostEqual(fps, 71.928)
                self.assertTrue(all(value == dual_pass_rife for value in rife.ensemble_values))
                with av.open(video.videos[0].get_stream_source()) as container:
                    frames = list(container.decode(video=0))
                self.assertEqual(len(frames), 208)
                values = torch.tensor([frame.to_ndarray(format="rgb24").mean() / 255 for frame in frames])
                torch.testing.assert_close(values, torch.linspace(0, 0.9, 208).double(), rtol=0, atol=3 / 255)
                self.assertTrue(all(first.pts < second.pts for first, second in zip(frames, frames[1:])))
                self.assertIn("Encoding:", stats)

    def test_parallel_upscale_matches_native_pixels_and_reuses_boundary(self):
        workers = min(PostProcessing._UPSCALE_WORKERS, os.cpu_count() or 1)
        images = torch.rand(workers * 2 + 1, 16, 22, 3)
        original = images.clone()
        expected = nodes.ImageScaleBy().upscale(images, "lanczos", 1.5)[0]
        native_upscale = nodes.ImageScaleBy.upscale
        barrier = threading.Barrier(workers, timeout=10)
        threads = set()

        def parallel_upscale(node, image, method, scale):
            threads.add(threading.current_thread().name)
            barrier.wait()
            return native_upscale(node, image, method, scale)

        cache = [None]
        bar = ProgressBar(len(images))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            with patch.object(nodes.ImageScaleBy, "upscale", parallel_upscale):
                first = PostProcessing._upscale_group(images[:workers], "lanczos", 1.5, executor, cache, False, bar)
            last = PostProcessing._upscale_group(images[workers - 1:], "lanczos", 1.5, executor, cache, True, bar)
        self.assertEqual(len(threads), workers)
        self.assertEqual(bar.current, bar.total)
        torch.testing.assert_close(torch.cat((first, last[1:])), expected, rtol=0, atol=0)
        torch.testing.assert_close(images, original, rtol=0, atol=0)
        self.assertEqual(cache[0].untyped_storage().nbytes(), cache[0].numel() * cache[0].element_size())

    def test_upscale_failure_stops_workers_and_encoder(self):
        with patch.object(nodes.ImageScaleBy, "upscale", side_effect=RuntimeError("upscale failed")):
            with self.assertRaisesRegex(RuntimeError, "upscale failed"):
                PostProcessing().process(torch.zeros(5, 16, 16, 3), interpolate=False)
        self.assertFalse(any(thread.name.startswith(("elvax-video", "elvax-upscale", "elvax-prepare"))
                             for thread in threading.enumerate()))

    def test_upscale_workers_refill_before_slowest_frame_finishes(self):
        workers = min(PostProcessing._UPSCALE_WORKERS, os.cpu_count() or 1)
        if workers == 1:
            self.skipTest("Requires concurrent workers")
        images = torch.arange(workers + 1).view(-1, 1, 1, 1).expand(-1, 16, 16, 3).float()
        refilled = threading.Event()
        native_upscale = nodes.ImageScaleBy.upscale

        def uneven_upscale(node, image, method, scale):
            index = int(image[0, 0, 0, 0])
            if index == 0:
                self.assertTrue(refilled.wait(5))
            elif index == workers:
                refilled.set()
            return native_upscale(node, image, method, scale)

        with ThreadPoolExecutor(max_workers=workers) as executor, \
                patch.object(nodes.ImageScaleBy, "upscale", uneven_upscale):
            result = PostProcessing._upscale_group(images, "lanczos", 2, executor, [None], False)
        self.assertEqual(len(result), len(images))

    def test_prefetched_upscale_failure_is_reported_and_stops_workers(self):
        images = torch.arange(20).view(-1, 1, 1, 1).expand(-1, 16, 16, 3).float() / 20
        native_upscale = nodes.ImageScaleBy.upscale

        def failed_second_group(node, image, method, scale):
            if image[0, 0, 0, 0] >= .8:
                raise RuntimeError("prefetch failed")
            return native_upscale(node, image, method, scale)

        with patch.object(PostProcessing, "_open_rife", return_value=(LinearRife(), None)), \
                patch.object(PostProcessing, "_close_rife"), \
                patch.object(nodes.ImageScaleBy, "upscale", failed_second_group):
            with self.assertRaisesRegex(RuntimeError, "prefetch failed"):
                PostProcessing().process(images, grain=False, batching_mode="low vram (16)")
        self.assertFalse(any(thread.name.startswith(("elvax-video", "elvax-upscale", "elvax-prepare"))
                             for thread in threading.enumerate()))

    def test_upscale_prefetch_stays_one_group_ahead(self):
        images = torch.arange(40).view(40, 1, 1, 1).expand(40, 16, 16, 3).float() / 40
        next_group_started = threading.Event()
        third_group_started = threading.Event()
        native_upscale = nodes.ImageScaleBy.upscale
        process_group = PostProcessing._finish_group
        calls = []

        def observed_upscale(node, image, method, scale):
            index = round(image[0, 0, 0, 0].item() * 40)
            if index >= 16:
                next_group_started.set()
            if index >= 32:
                third_group_started.set()
            return native_upscale(node, image, method, scale)

        def observed_process(node, *args):
            if not calls:
                self.assertTrue(next_group_started.wait(5))
                self.assertFalse(third_group_started.is_set())
            calls.append(True)
            return process_group(node, *args)

        with patch.object(PostProcessing, "_open_rife", return_value=(LinearRife(), None)), \
                patch.object(PostProcessing, "_close_rife"), \
                patch.object(nodes.ImageScaleBy, "upscale", observed_upscale), \
                patch.object(PostProcessing, "_finish_group", observed_process):
            video, _, _ = PostProcessing().process(images, grain=False, batching_mode="low vram (16)")
        self.addCleanup(video._elvax_temp_dir.cleanup)
        self.assertEqual(video.get_frame_count(), 79)
        self.assertEqual(len(calls), 20)
        self.assertFalse(any(thread.name.startswith("elvax-prepare") for thread in threading.enumerate()))

    def test_grain_matches_previous_formula_and_preserves_input(self):
        batch = torch.rand(3, 16, 16, 3)
        original = batch.clone()
        random_grain = torch.randn_like(batch)
        scaled = random_grain.clone()
        scaled[..., 0] *= 2
        scaled[..., 2] *= 3
        gray = scaled[..., 1:2].repeat(1, 1, 1, 3)
        expected = (batch + (0.25 * scaled + 0.75 * gray) * 0.025).clamp(0, 1).mul(255).byte()
        with patch("torch.randn_like", return_value=random_grain.clone()):
            actual = PostProcessing._grain_chunk(batch, 0.025, 0.25, torch.device("cpu"))
        self.assertEqual(actual.dtype, torch.uint8)
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        torch.testing.assert_close(batch, original, rtol=0, atol=0)

    def test_encoder_receives_small_owned_batches_before_interpolation_finishes(self):
        images = torch.linspace(0, .9, 20).view(-1, 1, 1, 1).expand(-1, 16, 16, 3)
        original = images.clone()
        rife = LinearRife()
        received = []
        inference_counts = []

        def collect(path, fps, batches, cancelled, timings, crf=0):
            while True:
                batch = batches.get(timeout=5)
                if batch is None:
                    break
                self.assertLessEqual(len(batch), 4)
                self.assertEqual(batch.dtype, torch.uint8)
                self.assertEqual(batch.device.type, "cpu")
                self.assertEqual(batch.untyped_storage().nbytes(), batch.numel())
                inference_counts.append(len(rife.ensemble_values))
                received.append(batch.clone())

        with patch.object(PostProcessing, "_open_rife", return_value=(rife, None)), \
                patch.object(PostProcessing, "_close_rife"), \
                patch.object(PostProcessing, "_encode_video", side_effect=collect):
            video, _, _ = PostProcessing().process(images, upscale=False, grain=False)
        self.addCleanup(video._elvax_temp_dir.cleanup)
        pixels = torch.cat(received)
        self.assertEqual(len(pixels), 39)
        self.assertLess(inference_counts[0], 19)
        torch.testing.assert_close(pixels[:, 0, 0, 0].float() / 255,
                                   torch.linspace(0, .9, 39), rtol=0, atol=1 / 255)
        torch.testing.assert_close(images, original, rtol=0, atol=0)

    def test_encoder_reuses_converter_and_preserves_float_and_byte_pixels(self):
        converter = av.video.reformatter.VideoReformatter()
        images = torch.rand(5, 16, 16, 3)

        def reformat(frame, **kwargs):
            expected = frame.reformat(**kwargs)
            actual = converter.reformat(frame, **kwargs)
            torch.testing.assert_close(torch.from_numpy(actual.to_ndarray()),
                                       torch.from_numpy(expected.to_ndarray()), rtol=0, atol=0)
            return actual

        with tempfile.TemporaryDirectory() as temp_dir:
            decoded = []
            for name, batch in [("float", images), ("byte", images.mul(255).byte())]:
                with self.subTest(dtype=name):
                    batches = queue.Queue()
                    batches.put(batch)
                    batches.put(None)
                    path = os.path.join(temp_dir, name + ".mp4")
                    with patch("post_processing.VideoReformatter") as factory:
                        factory.return_value.reformat.side_effect = reformat
                        PostProcessing._encode_video(path, 24.0, batches, threading.Event(), {"Encoding": 0.0})
                        factory.assert_called_once_with()
                        self.assertEqual(factory.return_value.reformat.call_count, len(images))
                    with av.open(path) as container:
                        frames = list(container.decode(video=0))
                    self.assertEqual(len(frames), len(images))
                    decoded.append(torch.stack([torch.from_numpy(frame.to_ndarray()) for frame in frames]))
            torch.testing.assert_close(decoded[0], decoded[1], rtol=0, atol=0)

    def test_cpu_upscale_audio_and_input_preservation(self):
        images = torch.rand(5, 16, 16, 3)
        original = images.clone()
        upscale = nodes.ImageScaleBy.upscale

        def cpu_upscale(node, image, method, scale):
            self.assertEqual(image.device.type, "cpu")
            return upscale(node, image, method, scale)

        audio = {"waveform": torch.zeros(1, 1, 8000), "sample_rate": 8000}
        with patch.object(nodes.ImageScaleBy, "upscale", cpu_upscale), \
                patch("comfy.model_management.get_torch_device", return_value=torch.device("cpu")):
            video, fps, _ = PostProcessing().process(
                images, interpolate=False, batching_mode="Custom", custom_batch_size=2, audio_pass=audio)
        torch.testing.assert_close(images, original, rtol=0, atol=0)
        self.addCleanup(video._elvax_temp_dir.cleanup)
        self.assertEqual(video.get_dimensions(), (32, 32))
        self.assertEqual(fps, 24.0)
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "saved.mp4")
            video.save_to(path)
            with av.open(path) as container:
                self.assertEqual(len(container.streams.audio), 1)
                self.assertEqual(len(list(container.decode(video=0))), 5)

    def test_grain_only_preserves_input(self):
        images = torch.rand(5, 16, 16, 3)
        original = images.clone()
        with patch("comfy.model_management.get_torch_device", return_value=torch.device("cpu")):
            video, _, _ = PostProcessing().process(
                images, upscale=False, interpolate=False, batching_mode="Custom", custom_batch_size=2)
        torch.testing.assert_close(images, original, rtol=0, atol=0)
        self.addCleanup(video._elvax_temp_dir.cleanup)
        self.assertEqual(video.get_frame_count(), 5)

    def test_encoder_failure_reaches_caller_and_stops_worker(self):
        with patch.object(PostProcessing, "_encode_video", side_effect=RuntimeError("encoder failed")):
            with self.assertRaisesRegex(RuntimeError, "encoder failed"):
                PostProcessing().process(
                    torch.zeros(5, 16, 16, 3), upscale=False, interpolate=False,
                    grain=False, batching_mode="Custom", custom_batch_size=1)
        self.assertFalse(any(thread.name.startswith("elvax-video") for thread in threading.enumerate()))

    def test_processing_failure_stops_waiting_encoder(self):
        with patch.object(PostProcessing, "_finish_group", side_effect=RuntimeError("processing failed")):
            with self.assertRaisesRegex(RuntimeError, "processing failed"):
                PostProcessing().process(torch.zeros(5, 16, 16, 3), interpolate=False)
        self.assertFalse(any(thread.name.startswith("elvax-video") for thread in threading.enumerate()))


if __name__ == "__main__":
    unittest.main()
