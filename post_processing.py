import gc
import os
import queue
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import av
from av.video.reformatter import VideoReformatter
import comfy.model_management
import comfy.utils
import torch
from comfy_api.latest import InputImpl, Types
from comfy_api.latest._input_impl.video_types import BT709_NCL, set_video_color_properties, video_encoder_options


class PostProcessing:
    SEARCH_ALIASES = ["elvax", "turbo", "turbo post processing", "upscale", "upscale video", "interpolate", "interpolate video", "grain", "film grain", "rife"]
    _UPSCALE_BATCH_SIZE = 64
    _GROUP_MODES = ("full sequence", "normal (64)", "low vram (16)", "custom")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "upscale": ("BOOLEAN", {"default": True}),
                "upscale_method": (["lanczos"], {"default": "lanczos"}),
                "upscale_by": ("FLOAT", {"default": 2.0, "min": 0.01, "max": 8.0, "step": 0.01}),
                "interpolate": ("BOOLEAN", {"default": True}),
                "original_fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1}),
                "interpolate_by": ("INT", {"default": 2, "min": 2, "max": 10, "step": 1}),
                "dual_pass_rife": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Runs RIFE in both directions and combines the results. May improve interpolation quality, but takes longer and uses more VRAM.",
                }),
                "grain": ("BOOLEAN", {"default": True}),
                "grain_intensity": ("FLOAT", {"default": 0.025, "min": 0.001, "max": 1.0, "step": 0.001}),
                "saturation_mix": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "batching_mode": (list(cls._GROUP_MODES), {
                    "default": "normal (64)",
                    "tooltip": "Frames processed at a time. Smaller batches use less memory but may be slower.",
                }),
                "custom_batch_size": ("INT", {
                    "default": 16, "min": 1, "max": 2147483647, "step": 1,
                    "tooltip": "Used only when batching_mode is custom.",
                }),
            },
            "optional": {
                "audio_pass": ("AUDIO", {"tooltip": "Optional audio input, passed through unchanged."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("VIDEO", "FLOAT", "STRING")
    RETURN_NAMES = ("VIDEO", "FPS", "stats")
    FUNCTION = "process"
    CATEGORY = "Elvax-nodes/Video"
    DESCRIPTION = "Upscale, interpolate, and add film grain, then provide a disk-backed video for Save Video."

    @classmethod
    def _open_rife(cls, images, low_vram):
        import nodes

        rife_class = nodes.NODE_CLASS_MAPPINGS.get("FL_RIFE")
        if rife_class is None:
            raise RuntimeError("Post Processing requires the FL RIFE node from Fill Nodes.")
        rife = rife_class()
        if low_vram and rife.device.type != "cpu":
            frame_bytes = images.shape[1] * images.shape[2] * images.shape[3] * images.element_size()
            comfy.model_management.free_memory(max(1024 ** 3, frame_bytes * 16), rife.device)
        return rife, rife.load_model("rife49")

    @staticmethod
    def _close_rife(rife):
        if rife is not None:
            rife.model = None
            del rife
            gc.collect()
            comfy.model_management.soft_empty_cache()

    @staticmethod
    def _interpolate_group(images, interpolate_by, rife, model, ensemble, frame_cache, pbar):
        output_frame_count = (images.shape[0] - 1) * interpolate_by + 1
        output = torch.empty((output_frame_count, *images.shape[1:]), dtype=images.dtype, device="cpu")
        output[::interpolate_by].copy_(images.detach().cpu())
        img0 = frame_cache[0]
        if img0 is None:
            img0 = images[:1].permute(0, 3, 1, 2).to(rife.device)
        for index in range(images.shape[0] - 1):
            img1 = images[index + 1:index + 2].permute(0, 3, 1, 2).to(rife.device)
            for step in range(1, interpolate_by):
                pred = rife.make_inference(model, img0, img1, step / interpolate_by, ensemble)
                output[index * interpolate_by + step].copy_(
                    pred[0].permute(1, 2, 0).detach().clamp(0, 1))
                pbar.update(1)
            img0 = img1
        frame_cache[0] = img0
        return output

    @staticmethod
    def _grain_chunk(batch, intensity, saturation_mix, device):
        batch = batch.to(device)
        grain = torch.randn_like(batch)
        grain[..., 0] *= 2.0
        grain[..., 2] *= 3.0
        gray = grain[..., 1:2]
        noise = grain.mul(saturation_mix)
        noise.add_(gray, alpha=1.0 - saturation_mix).mul_(intensity)
        return batch.add(noise).clamp_(0.0, 1.0).mul_(255).byte().cpu()

    def _process_group(self, images, upscale, upscale_method, upscale_by, interpolate,
                       interpolate_by, grain, grain_intensity, saturation_mix,
                       rife, model, ensemble, frame_cache, drop_first, pbar, timings):
        import nodes

        result = images.detach().cpu()
        if interpolate and result.shape[0] > 1:
            started = time.perf_counter()
            result = self._interpolate_group(
                result, interpolate_by, rife, model, ensemble, frame_cache, pbar)
            timings["RIFE"] += time.perf_counter() - started
        if drop_first:
            result = result[1:]
        if upscale:
            started = time.perf_counter()
            output = None
            for start in range(0, result.shape[0], self._UPSCALE_BATCH_SIZE):
                chunk = nodes.ImageScaleBy().upscale(
                    result[start:start + self._UPSCALE_BATCH_SIZE], upscale_method, upscale_by)[0]
                if output is None:
                    output = torch.empty((result.shape[0], *chunk.shape[1:]), dtype=chunk.dtype, device="cpu")
                output[start:start + chunk.shape[0]].copy_(chunk)
                pbar.update(1)
            result = output
            timings["Upscale"] += time.perf_counter() - started
        if grain:
            started = time.perf_counter()
            device = comfy.model_management.get_torch_device()
            output = torch.empty(result.shape, dtype=torch.uint8, device="cpu")
            for start in range(0, result.shape[0], 4):
                chunk = self._grain_chunk(
                    result[start:start + 4], grain_intensity, saturation_mix, device)
                output[start:start + chunk.shape[0]].copy_(chunk)
                pbar.update(1)
            result = output
            timings["Grain"] += time.perf_counter() - started
        return result

    @staticmethod
    def _encode_video(path, frame_rate, batches, cancelled, timings):
        rate = Fraction(round(frame_rate * 1000), 1000)
        stream = None
        reformatter = VideoReformatter()
        frame_index = 0
        with av.open(path, mode="w", format="mp4") as output:
            while not cancelled.is_set():
                try:
                    batch = batches.get(timeout=0.1)
                except queue.Empty:
                    continue
                if batch is None:
                    break
                started = time.perf_counter()
                if stream is None:
                    stream = output.add_stream("h264", rate=rate)
                    stream.width = batch.shape[2]
                    stream.height = batch.shape[1]
                    stream.pix_fmt = "yuv420p"
                    stream.options = video_encoder_options(Types.VideoCodec.H264, 0.0, "ultrafast")
                    set_video_color_properties(stream.codec_context, "sRGB")
                for image in batch:
                    if cancelled.is_set():
                        return
                    pixels = image.numpy() if image.dtype == torch.uint8 else image.mul(255).clamp_(0, 255).byte().numpy()
                    frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
                    frame = reformatter.reformat(frame, format="yuv420p", dst_colorspace=BT709_NCL)
                    set_video_color_properties(frame, "sRGB")
                    frame.pts = frame_index
                    frame.time_base = Fraction(rate.denominator, rate.numerator)
                    frame_index += 1
                    output.mux(stream.encode(frame))
                timings["Encoding"] += time.perf_counter() - started
                del batch, image, pixels, frame
            if stream is not None and not cancelled.is_set():
                started = time.perf_counter()
                output.mux(stream.encode(None))
                timings["Encoding"] += time.perf_counter() - started

    def process(self, images, upscale=True, upscale_method="lanczos", upscale_by=2.0,
                interpolate=True, original_fps=24.0, interpolate_by=2,
                grain=True, grain_intensity=0.025, saturation_mix=0.25,
                batching_mode="normal (64)", custom_batch_size=16, audio_pass=None, unique_id=None,
                dual_pass_rife=True):
        started = time.perf_counter()
        frame_count = int(images.shape[0])
        if frame_count == 0:
            raise ValueError("Turbo Post Processing needs at least one frame.")
        batching_mode = batching_mode.lower()
        do_interpolate = interpolate and frame_count > 1
        use_dual_pass_rife = dual_pass_rife
        multiplier = int(interpolate_by) if do_interpolate else 1
        fps = float(original_fps) * multiplier
        group_size = {
            "full sequence": frame_count,
            "normal (64)": 64,
            "low vram (16)": 16,
            "custom": int(custom_batch_size),
        }.get(batching_mode, 64)
        group_size = max(1, min(group_size, frame_count))
        progress_total = (frame_count - 1) * (multiplier - 1) + 1
        for start in range(0, frame_count, group_size):
            source_frames = min(start + group_size, frame_count) - max(0, start - 1)
            processed_frames = (source_frames - 1) * multiplier + 1 - int(start > 0)
            if upscale:
                progress_total += (processed_frames + self._UPSCALE_BATCH_SIZE - 1) // self._UPSCALE_BATCH_SIZE
            if grain:
                progress_total += (processed_frames + 3) // 4
        pbar = comfy.utils.ProgressBar(progress_total, node_id=unique_id)
        pbar.update_absolute(0)
        timings = {"RIFE": 0.0, "Upscale": 0.0, "Grain": 0.0, "Encoding": 0.0}
        temp_dir = tempfile.TemporaryDirectory(prefix="elvax_turbo_")
        path = os.path.join(temp_dir.name, "video.mp4")
        batches = queue.Queue(maxsize=1)
        cancelled = threading.Event()
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="elvax-video")
        encoder = executor.submit(self._encode_video, path, fps, batches, cancelled, timings)

        def submit_batch(batch):
            while True:
                comfy.model_management.throw_exception_if_processing_interrupted()
                if encoder.done():
                    encoder.result()
                    raise RuntimeError("Turbo's video encoder stopped before receiving all frames.")
                try:
                    batches.put(batch, timeout=0.1)
                    return
                except queue.Full:
                    continue

        rife = model = None
        frame_cache = [None]
        finished = False
        try:
            if do_interpolate:
                load_started = time.perf_counter()
                rife, model = self._open_rife(images, batching_mode == "low vram (16)")
                timings["RIFE"] += time.perf_counter() - load_started
            for chunk_index, start in enumerate(range(0, frame_count, group_size)):
                end = min(start + group_size, frame_count)
                result = self._process_group(
                    images[max(0, start - 1):end], upscale, upscale_method, upscale_by,
                    do_interpolate, int(interpolate_by), grain, grain_intensity, saturation_mix,
                    rife, model, use_dual_pass_rife, frame_cache,
                    chunk_index > 0, pbar, timings)
                submit_batch(result)
                del result
            submit_batch(None)
            encoder.result()
            pbar.update(1)
            finished = True
        finally:
            cancelled.set()
            executor.shutdown(wait=True)
            frame_cache[0] = None
            model = None
            self._close_rife(rife)
            if not finished:
                temp_dir.cleanup()

        video = InputImpl.VideoFromList(
            [InputImpl.VideoFromFile(path)], complete_audio=audio_pass, codec=Types.VideoCodec.H264)
        video._elvax_temp_dir = temp_dir
        stats = "Generation time: {:.2f}s | {}".format(
            time.perf_counter() - started,
            " | ".join("{}: {}".format(stage, "Off" if duration < 0.005 else "{:.2f}s".format(duration))
                       for stage, duration in timings.items()))
        return (video, fps, stats)
