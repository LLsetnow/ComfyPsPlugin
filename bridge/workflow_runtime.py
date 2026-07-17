"""Shared validation for runtime ComfyUI workflow input overrides."""

import json
import re


_SET_ARG_RE = re.compile(r"^([0-9]+):([A-Za-z_][A-Za-z0-9_ ]*)=(.*)$")


class WorkflowInputError(ValueError):
    """A runtime argument cannot safely be applied to the supplied workflow."""


def _parse_value(raw):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return raw
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return raw


def apply_set_args(workflow, set_args):
    """Apply validated ``node:field=value`` overrides to an API workflow."""
    for raw_arg in set_args or []:
        match = _SET_ARG_RE.match(str(raw_arg))
        if not match:
            raise WorkflowInputError("工作流参数格式无效")
        node_id, field, raw_value = match.groups()
        node = workflow.get(node_id)
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict) or field not in inputs:
            raise WorkflowInputError("工作流参数节点或字段不存在")
        inputs[field] = _parse_value(raw_value)
    return workflow
