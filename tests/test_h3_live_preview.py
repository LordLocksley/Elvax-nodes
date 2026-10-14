import ast
from concurrent.futures import Future, ThreadPoolExecutor
import logging
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


source = Path(__file__).resolve().parents[1] / "h3_reference_samplers.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
wrapper = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "_H3LivePreview")


class InlineEncoder:
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def submit(self, fn, *args):
        fn(*args)
        result = Future()
        result.set_result(None)
        return result


class H3LivePreviewTests(unittest.TestCase):
    def setUp(self):
        class Previewer:
            def decode_latent_to_preview_image(self, *args):
                return "original"

        self.previewer = Previewer
        self.original_method = Previewer.decode_latent_to_preview_image
        self.server = SimpleNamespace(client_id="client", send_sync=Mock())
        self.preview = SimpleNamespace(
            load_tiny_vae_decoder=Mock(return_value=SimpleNamespace(latent_channels=32)),
            PromptServer=SimpleNamespace(instance=self.server),
            _normalize_packed_x0=Mock(side_effect=lambda x0, *args: x0),
            _tiny_vae_decode_frames=Mock(return_value=(["frame"], None)),
            _materialize_frames=Mock(side_effect=lambda frames, size: frames),
            _MP4_AVAILABLE=True,
            _encode_mp4=Mock(return_value=("encoded", 16, 16)),
            _encode_animated_webp=Mock(return_value=("webp", 16, 16)),
            _decode_video_frames_l2rgb=Mock(return_value=["rgb"]),
            _suppressed_preview_image=lambda *args: None,
        )
        self.empty_cache = Mock()
        namespace = {
            "logging": logging, "ThreadPoolExecutor": InlineEncoder,
            "latent_preview": SimpleNamespace(LatentPreviewer=Previewer),
            "comfy": SimpleNamespace(model_management=SimpleNamespace(soft_empty_cache=self.empty_cache)),
        }
        exec(compile(ast.Module(body=[wrapper], type_ignores=[]), str(source), "exec"), namespace)
        self.namespace = namespace
        self.live = namespace["_H3LivePreview"](self.preview, "tiny.pth", "12")
        self.model = SimpleNamespace(model=SimpleNamespace(latent_format=SimpleNamespace(compile_preview=False)))
        self.callback = Mock()
        self.latent = object()

    def run_sampler(self, body):
        def executor(*args, **kwargs):
            return body(args[5])

        executor.class_obj = SimpleNamespace(model_patcher=self.model)
        return self.live(executor, object(), self.latent, object(), object(), None,
                         self.callback, False, 42, [(1, 32, 3, 1, 1)])

    def test_five_steps_keep_callbacks_and_return_unchanged_without_statistics(self):
        def sample(callback):
            self.assertIsNone(self.previewer().decode_latent_to_preview_image())
            for step in range(5):
                callback(step, self.latent, self.latent, 5)
            return self.latent

        self.assertIs(self.run_sampler(sample), self.latent)
        self.assertEqual(self.callback.call_count, 5)
        self.assertEqual(self.preview._tiny_vae_decode_frames.call_count, 5)
        self.assertEqual(self.server.send_sync.call_count, 5)
        payload = self.server.send_sync.call_args.args[1]
        self.assertEqual(set(payload), {"node_id", "image", "mime", "w", "h", "fps"})
        self.assertIs(self.previewer.decode_latent_to_preview_image, self.original_method)

    def test_busy_steps_skip_decode_but_final_step_is_sent_and_drained(self):
        self.namespace["ThreadPoolExecutor"] = ThreadPoolExecutor
        entered = threading.Event()
        release = threading.Event()

        def encode(*args):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test encoder was not released")
            return "encoded", 16, 16

        self.preview._encode_mp4.side_effect = encode

        def sample(callback):
            try:
                callback(0, self.latent, self.latent, 5)
                self.assertTrue(entered.wait(5))
                for step in range(1, 4):
                    callback(step, self.latent, self.latent, 5)
                self.assertEqual(self.preview._tiny_vae_decode_frames.call_count, 1)
            finally:
                release.set()
            callback(4, self.latent, self.latent, 5)

        self.run_sampler(sample)
        self.assertEqual(self.preview._tiny_vae_decode_frames.call_count, 2)
        self.assertEqual(self.server.send_sync.call_count, 2)
        self.assertEqual(self.callback.call_count, 5)

    def test_default_preview_restored_after_sampling_failure(self):
        def sample(callback):
            raise RuntimeError("sampling failed")

        with self.assertRaisesRegex(RuntimeError, "sampling failed"):
            self.run_sampler(sample)
        self.assertIs(self.previewer.decode_latent_to_preview_image, self.original_method)

    def test_default_preview_restored_with_multiple_inheritance(self):
        class Left(self.previewer):
            pass

        class Right(self.previewer):
            pass

        class Both(Left, Right):
            def decode_latent_to_preview_image(self, *args):
                return "combined"

        original = Both.decode_latent_to_preview_image
        self.run_sampler(lambda callback: self.assertIsNone(Both().decode_latent_to_preview_image()))
        self.assertIs(Both.decode_latent_to_preview_image, original)

    def test_webp_fallback_keeps_live_preview(self):
        self.preview._MP4_AVAILABLE = False
        self.run_sampler(lambda callback: callback(0, self.latent, self.latent, 1))
        self.preview._encode_mp4.assert_not_called()
        self.assertEqual(self.server.send_sync.call_args.args[1]["mime"], "image/webp")

    def test_failed_tiny_decoder_falls_back_once_without_mutating_latents(self):
        self.preview._tiny_vae_decode_frames.side_effect = RuntimeError("decode failed")
        with self.assertLogs(level="ERROR"):
            self.run_sampler(lambda callback: [callback(step, self.latent, self.latent, 2) for step in range(2)])
        self.preview._tiny_vae_decode_frames.assert_called_once()
        self.assertEqual(self.preview._decode_video_frames_l2rgb.call_count, 2)
        self.assertEqual(self.callback.call_count, 2)


if __name__ == "__main__":
    unittest.main()
