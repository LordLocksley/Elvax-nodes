from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker


class RerouteSwitch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        template = io.MatchType.Template("route")
        return io.Schema(
            node_id="ElvaxRerouteSwitch",
            display_name="Reroute Switch",
            category="Elvax Nodes/Utilities",
            search_aliases=["elvax", "route", "gate", "A B"],
            description="Send the input to output A or B. The other output blocks execution while its links stay connected.",
            inputs=[
                io.MatchType.Input("value", template=template),
                io.Combo.Input("active_output", options=["A", "B"], default="A", socketless=True),
            ],
            outputs=[
                io.MatchType.Output(template=template, display_name="A"),
                io.MatchType.Output(template=template, display_name="B"),
            ],
        )

    @classmethod
    def execute(cls, value, active_output):
        blocked = ExecutionBlocker(None)
        return io.NodeOutput(value, blocked) if active_output == "A" else io.NodeOutput(blocked, value)
