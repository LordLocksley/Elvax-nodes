import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from json_prompt_splitter import JSONPromptSplitter


class JSONPromptSplitterTests(unittest.TestCase):
    def test_recovers_single_quote_after_complete_object(self):
        prompts = {"Prompt3": "Third", "Prompt1": 'First says "hello" }', "Prompt2": "Second"}
        text = json.dumps(prompts)
        for suffix in ['"', '\n  "\n']:
            with self.subTest(suffix=suffix):
                result = JSONPromptSplitter().split_prompt(text + suffix)
                self.assertEqual(result[:3], (prompts["Prompt1"], "Second", "Third"))
                self.assertEqual(result[3:], ("",) * 29)

    def test_rejects_other_trailing_content(self):
        text = json.dumps({"Prompt1": "First"})
        for suffix in [' more text', ' {"Prompt2": "Second"}', '" more text', '""', ',']:
            with self.subTest(suffix=suffix):
                with self.assertRaisesRegex(ValueError, "could not parse"):
                    JSONPromptSplitter().split_prompt(text + suffix)

    def test_valid_quoted_values_are_preserved(self):
        prompt = 'A quote: ", braces: {}, and a closing quote: "'
        result = JSONPromptSplitter().split_prompt(json.dumps({"Prompt1": prompt}))
        self.assertEqual(result[0], prompt)

    def test_existing_inner_quote_and_trailing_comma_repair(self):
        result = JSONPromptSplitter().split_prompt('{"Prompt1": "She said "hello" today",}')
        self.assertEqual(result[0], 'She said "hello" today')


if __name__ == "__main__":
    unittest.main()
