import asyncio
from pathlib import Path
import uuid

from aiohttp import web
import folder_paths
from comfy_api.latest import InputImpl, io
from server import PromptServer


CAPTURE_SUBFOLDER = "Elvax/video_compare"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}


def capture_video(video, temporary=False):
    root = folder_paths.get_temp_directory() if temporary else folder_paths.get_input_directory()
    directory = Path(root) / CAPTURE_SUBFOLDER
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.mp4"
    path = directory / filename
    try:
        # Native save_to streams file-backed videos and preserves their audio and trims.
        video.save_to(str(path))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"filename": filename, "subfolder": CAPTURE_SUBFOLDER, "type": "temp" if temporary else "input"}


def source_video_path(entry):
    roots = {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }
    root = roots.get(entry.get("type", "input"))
    if root is None:
        raise ValueError("The selected video could not be accessed.")
    directory = Path(root).resolve()
    filename = entry.get("filename", "")
    if not isinstance(filename, str) or not filename:
        raise ValueError("No video is available from the connected node yet.")
    path = (directory / entry.get("subfolder", "") / filename).resolve()
    if not path.is_relative_to(directory) or path.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError("The selected video could not be accessed.")
    if not path.is_file():
        raise FileNotFoundError("The source video file could not be found. Check that it still exists, then load it again.")
    return path


@PromptServer.instance.routes.post("/elvax/video-compare/capture")
async def capture_existing_video(request):
    try:
        entry = await request.json()
        path = source_video_path(entry)
    except (ValueError, TypeError, AttributeError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    # This route only accepts files in ComfyUI's media directories, never arbitrary paths.
    try:
        result = await asyncio.to_thread(capture_video, InputImpl.VideoFromFile(str(path)))
    except (OSError, ValueError) as error:
        return web.json_response({"error": f"Could not prepare the video: {error}"}, status=400)
    return web.json_response(result)


class VideoCompare(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxVideoCompare",
            display_name="Video Compare",
            category="Elvax Nodes/Utilities",
            search_aliases=["elvax", "before after", "comparison"],
            description="Load Before and After videos from separate sockets and compare them with a sliding divider.",
            inputs=[
                io.Video.Input("before_video", optional=True),
                io.Video.Input("after_video", optional=True),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, before_video=None, after_video=None):
        if before_video is None and after_video is None:
            return io.NodeOutput()
        ui = {}
        if before_video is not None:
            ui["elvax_compare_before_video"] = [capture_video(before_video, temporary=True)]
        if after_video is not None:
            ui["elvax_compare_after_video"] = [capture_video(after_video, temporary=True)]
        return io.NodeOutput(ui=ui)
