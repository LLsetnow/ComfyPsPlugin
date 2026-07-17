import unittest

from bridge.workflow_runtime import WorkflowInputError, apply_set_args


class WorkflowRuntimeTests(unittest.TestCase):
    def test_applies_numeric_and_text_values_to_declared_inputs(self):
        workflow = {
            "95": {"inputs": {"value": 2.0}},
            "2": {"inputs": {"text": "old"}},
        }

        apply_set_args(workflow, ["95:value=3.5", "2:text=new prompt"])

        self.assertEqual(workflow["95"]["inputs"]["value"], 3.5)
        self.assertEqual(workflow["2"]["inputs"]["text"], "new prompt")

    def test_rejects_unknown_node_field_and_malformed_argument(self):
        workflow = {"95": {"inputs": {"value": 2.0}}}

        for value in ["bad", "96:value=2", "95:missing=2"]:
            with self.subTest(value=value):
                with self.assertRaises(WorkflowInputError):
                    apply_set_args(workflow, [value])
