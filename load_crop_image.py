import nodes
import torch
from comfy.utils import lanczos
from comfy_extras.nodes_post_processing import ImageScaleToTotalPixels


class LoadCropImage(nodes.LoadImage):
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        inputs["required"].update({
            "crop_x": ("INT", {"default": 0, "min": 0}),
            "crop_y": ("INT", {"default": 0, "min": 0}),
            "crop_width": ("INT", {"default": 0, "min": 0}),
            "crop_height": ("INT", {"default": 0, "min": 0}),
        })
        inputs.setdefault("optional", {}).update({
            "rotation": ("INT", {"default": 0, "min": 0, "max": 270, "step": 90}),
            "scale_image": ("BOOLEAN", {"default": False, "socketless": True}),
            "megapixels": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01, "socketless": True}),
        })
        return inputs

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_crop_image"
    CATEGORY = "Elvax/image"
    DESCRIPTION = ("Load, crop, and rotate an image quickly in one node. Optionally scale the "
                   "result to a target megapixel count using Lanczos, with its matching mask.")
    SEARCH_ALIASES = ["elvax", "load crop image", "crop image loader", "upload and crop image"]

    def load_crop_image(self, image, crop_x=0, crop_y=0, crop_width=0, crop_height=0, rotation=0, scale_image=False, megapixels=1.0):
        images, mask = super().load_image(image)
        height, width = images.shape[1:3]
        mask_matches_image = mask.shape[-2:] == (height, width)
        turns = (int(rotation) // 90) % 4
        if turns:
            images = torch.rot90(images, -turns, dims=(1, 2)).contiguous()
            if mask_matches_image:
                mask = torch.rot90(mask, -turns, dims=(-2, -1)).contiguous()
            height, width = images.shape[1:3]
        if crop_width > 0 and crop_height > 0:
            left = max(0, min(int(crop_x), width - 1))
            top = max(0, min(int(crop_y), height - 1))
            right = min(width, left + max(1, int(crop_width)))
            bottom = min(height, top + max(1, int(crop_height)))
            images = images[:, top:bottom, left:right, :].clone(memory_format=torch.contiguous_format)
            if mask_matches_image:
                mask = mask[..., top:bottom, left:right].clone(memory_format=torch.contiguous_format)
            height, width = images.shape[1:3]
        if not mask_matches_image:
            mask = mask.new_zeros((images.shape[0], height, width))

        if scale_image:
            images = ImageScaleToTotalPixels.execute(images, "lanczos", megapixels, 1).result[0]
            mask = lanczos(mask, images.shape[2], images.shape[1])

        return images, mask

    @classmethod
    def IS_CHANGED(cls, image, crop_x=0, crop_y=0, crop_width=0, crop_height=0, rotation=0, scale_image=False, megapixels=1.0):
        return (
            super().IS_CHANGED(image),
            int(crop_x),
            int(crop_y),
            int(crop_width),
            int(crop_height),
            int(rotation),
            bool(scale_image),
            float(megapixels) if scale_image else None,
        )
