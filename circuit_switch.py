from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker


class CircuitSwitch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        template = io.MatchType.Template("circuit")
        return io.Schema(
            node_id="ElvaxCircuitSwitch",
            display_name="Circuit Switch",
            category="Elvax Nodes/Utilities",
            search_aliases=["elvax", "circuit", "pass", "block"],
            description="Click the circuit contact to open or close the path. Closed passes the input; open blocks it.",
            inputs=[
                io.MatchType.Input("value", template=template),
                io.Boolean.Input("closed", default=True, socketless=True),
            ],
            outputs=[io.MatchType.Output(template=template)],
        )

    @classmethod
    def execute(cls, value, closed):
        return io.NodeOutput(value if closed else ExecutionBlocker(None))
