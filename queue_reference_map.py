class QueueReferenceMap:
    SEARCH_ALIASES = ["elvax"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "refresh"
    OUTPUT_NODE = True
    CATEGORY = "Elvax Nodes/Utilities"
    DESCRIPTION = "View, cancel, pause, and resume queued prompts. Paused prompt snapshots persist across restarts."

    def refresh(self):
        return ()
