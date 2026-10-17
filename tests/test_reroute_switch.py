from pathlib import Path
import sys
import unittest

PACK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK_ROOT.parents[1]))
sys.path.insert(0, str(PACK_ROOT))

from comfy_execution.graph_utils import ExecutionBlocker
from reroute_switch import RerouteSwitch


class RerouteSwitchTests(unittest.TestCase):
    def test_schema_matches_both_outputs_to_the_input(self):
        schema = RerouteSwitch.define_schema()
        self.assertEqual(schema.inputs[1].default, "A")
        self.assertIn("elvax", schema.search_aliases)
        self.assertEqual(len(schema.outputs), 2)
        self.assertTrue(all(output.template is schema.inputs[0].template for output in schema.outputs))

    def test_only_selected_output_receives_the_original_value(self):
        value = object()
        for selection, active in [("A", 0), ("B", 1)]:
            with self.subTest(selection=selection):
                result = RerouteSwitch.execute(value, selection)
                self.assertIs(result.result[active], value)
                self.assertIsInstance(result.result[1 - active], ExecutionBlocker)
                self.assertIsNone(result.result[1 - active].message)


if __name__ == "__main__":
    unittest.main()
