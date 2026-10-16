from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PACK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK_ROOT.parents[1]))
sys.path.insert(0, str(PACK_ROOT))

import torch
import nodes
from load_crop_image import LoadCropImage


class LoadCropImageTests(unittest.TestCase):
    def setUp(self):
        self.images = torch.arange(2 * 128 * 256 * 3, dtype=torch.float32).reshape(2, 128, 256, 3)
        self.alpha = torch.linspace(0, 1, 2 * 128 * 256).reshape(2, 128, 256)

    def crop(self, mask, **kwargs):
        with patch.object(nodes.LoadImage, "load_image", return_value=(self.images, mask)):
            return LoadCropImage().load_crop_image("test.png", **kwargs)

    def test_full_width_strip_owns_image_and_alpha_storage(self):
        image, mask = self.crop(self.alpha, crop_y=8, crop_width=256, crop_height=16)
        self.assertTrue(torch.equal(image, self.images[:, 8:24]))
        self.assertTrue(torch.equal(mask, self.alpha[:, 8:24]))
        for cropped, original in ((image, self.images), (mask, self.alpha)):
            self.assertNotEqual(cropped.untyped_storage().data_ptr(), original.untyped_storage().data_ptr())
            self.assertEqual(cropped.untyped_storage().nbytes(), cropped.numel() * cropped.element_size())
            self.assertTrue(cropped.is_contiguous())

    def test_opaque_crop_allocates_only_final_mask_size(self):
        allocations = []
        original = torch.Tensor.new_zeros

        def record(tensor, size, **kwargs):
            allocations.append(size)
            return original(tensor, size, **kwargs)

        with patch.object(torch.Tensor, "new_zeros", record):
            image, mask = self.crop(torch.zeros(2, 64, 64), crop_x=10, crop_y=8, crop_width=20, crop_height=16)
        self.assertEqual(allocations, [(2, 16, 20)])
        self.assertEqual(tuple(mask.shape), (2, 16, 20))
        self.assertEqual(mask.dtype, image.dtype)
        self.assertEqual(torch.count_nonzero(mask), 0)

    def test_restore_returns_original_pixels_and_alpha(self):
        self.crop(self.alpha, crop_x=30, crop_y=20, crop_width=10, crop_height=10)
        image, mask = self.crop(self.alpha)
        self.assertIs(image, self.images)
        self.assertIs(mask, self.alpha)

    def test_restore_opaque_image_has_matching_full_size_mask(self):
        image, mask = self.crop(torch.zeros(2, 64, 64))
        self.assertIs(image, self.images)
        self.assertEqual(tuple(mask.shape), tuple(image.shape[:3]))
        self.assertEqual(torch.count_nonzero(mask), 0)

    def test_out_of_bounds_crop_clamps_to_valid_pixels(self):
        image, mask = self.crop(self.alpha, crop_x=999, crop_y=999, crop_width=50, crop_height=50)
        self.assertTrue(torch.equal(image, self.images[:, -1:, -1:]))
        self.assertTrue(torch.equal(mask, self.alpha[:, -1:, -1:]))

    def test_partial_width_crop_preserves_pixels_and_transparency(self):
        image, mask = self.crop(self.alpha, crop_x=10, crop_y=20, crop_width=30, crop_height=40)
        self.assertTrue(torch.equal(image, self.images[:, 20:60, 10:40]))
        self.assertTrue(torch.equal(mask, self.alpha[:, 20:60, 10:40]))

    def test_quarter_turns_rotate_image_and_alpha_exactly(self):
        for turns in (1, 2, 3):
            with self.subTest(turns=turns):
                image, mask = self.crop(self.alpha, rotation=turns * 90)
                self.assertTrue(torch.equal(image, torch.rot90(self.images, -turns, dims=(1, 2))))
                self.assertTrue(torch.equal(mask, torch.rot90(self.alpha, -turns, dims=(-2, -1))))
                self.assertTrue(image.is_contiguous())
                self.assertTrue(mask.is_contiguous())

    def test_rotating_an_applied_crop_keeps_the_same_selected_pixels(self):
        image, mask = self.crop(self.alpha, rotation=90, crop_x=68, crop_y=10, crop_width=40, crop_height=30)
        self.assertTrue(torch.equal(image, torch.rot90(self.images[:, 20:60, 10:40], -1, dims=(1, 2))))
        self.assertTrue(torch.equal(mask, torch.rot90(self.alpha[:, 20:60, 10:40], -1, dims=(-2, -1))))

    def test_rotated_opaque_image_gets_a_matching_mask(self):
        image, mask = self.crop(torch.zeros(2, 64, 64), rotation=90)
        self.assertEqual(tuple(image.shape), (2, 256, 128, 3))
        self.assertEqual(tuple(mask.shape), (2, 256, 128))
        self.assertEqual(torch.count_nonzero(mask), 0)

    def test_four_turns_restore_original_pixels_without_changing_input(self):
        original = self.images.clone()
        image, mask = self.crop(self.alpha, rotation=360)
        self.assertIs(image, self.images)
        self.assertIs(mask, self.alpha)
        self.assertTrue(torch.equal(self.images, original))

    def test_rotation_changes_the_cache_fingerprint(self):
        with patch.object(nodes.LoadImage, "IS_CHANGED", return_value="same image"):
            self.assertNotEqual(LoadCropImage.IS_CHANGED("test.png"), LoadCropImage.IS_CHANGED("test.png", rotation=90))


if __name__ == "__main__":
    unittest.main()
