import json
import re


MAX_PROMPTS = 32


class JSONPromptSplitter:
    SEARCH_ALIASES = ["elvax", "json prompt", "prompt splitter"]
    CATEGORY = "Elvax/text"
    DESCRIPTION = "Split numbered prompt values into one output per video."
    FUNCTION = "split_prompt"
    RETURN_TYPES = ("STRING",) * MAX_PROMPTS
    RETURN_NAMES = tuple(f"prompt_{index}" for index in range(1, MAX_PROMPTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "json_string": ("STRING", {"forceInput": True}),
            }
        }

    def split_prompt(self, json_string):
        cleaned = self._clean_json(json_string)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            repaired = self._escape_unescaped_inner_quotes(cleaned)
            repaired = re.sub(r",(\s*[}\]])", r"\1", repaired)
            try:
                data = json.loads(repaired)
            except json.JSONDecodeError as error:
                raise ValueError(f"JSON Prompt Splitter could not parse the JSON input: {error}") from error

        if not isinstance(data, dict):
            raise ValueError("JSON Prompt Splitter expects a JSON object at the top level.")

        items = []
        videos = data.get("videos")
        if isinstance(videos, list):
            shared = {key: value for key, value in data.items() if key != "videos"}
            items = [
                (index, json.dumps({**shared, "videos": [video]}, ensure_ascii=False))
                for index, video in enumerate(videos, start=1)
            ]
        else:
            for key, value in data.items():
                number = "".join(filter(str.isdigit, str(key)))
                if number:
                    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                    items.append((int(number), text))
        items.sort(key=lambda item: item[0])

        outputs = [items[index][1] if index < len(items) else "" for index in range(MAX_PROMPTS)]
        return tuple(outputs)

    @staticmethod
    def _clean_json(text):
        cleaned = str(text or "").strip().replace("\ufeff", "").replace("\u200b", "")
        cleaned = cleaned.replace("“", '"').replace("”", '"')
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
        return cleaned.strip()

    @staticmethod
    def _escape_unescaped_inner_quotes(text):
        chars = []
        in_string = False
        escaped = False

        for index, char in enumerate(text):
            if not in_string:
                chars.append(char)
                if char == '"':
                    in_string = True
                continue

            if escaped:
                chars.append(char)
                escaped = False
            elif char == "\\":
                chars.append(char)
                escaped = True
            elif char == '"':
                lookahead = index + 1
                while lookahead < len(text) and text[lookahead].isspace():
                    lookahead += 1
                if lookahead < len(text) and text[lookahead] not in ",}]:":
                    chars.extend(("\\", char))
                else:
                    chars.append(char)
                    in_string = False
            else:
                chars.append(char)

        return "".join(chars)
