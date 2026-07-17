# 图像高清与云扉兼容工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add the two-mode 图像高清 workflow to RunningHub, local ComfyUI, and AIGate native ComfyUI, while enabling AIGate execution for background cleanup and face refinement.

**Architecture:** Workflow metadata supplies a single run contract: workflow file, input/output nodes, and prompt target. The bridge safely resolves the repository workflow and selects the retained Boogu adapter or generic native execution. Local ComfyUI receives this same request contract.

**Tech Stack:** ES5 UXP JavaScript, Python 3, aiohttp, Node built-in test runner, Python unittest, JSON.

---

## File structure

- Create: workflows/image_clarity_api.json — supplied SeedVR2 clarity workflow.
- Create: workflows/image_upscale_api.json — supplied SeedVR2 upscale workflow.
- Create: bridge/workflow_runtime.py — validates node:field=value overrides.
- Modify: plugin/main.js and plugin/run.js — workflow metadata, variants, request fields.
- Modify: bridge/comfyui_exec.py — dynamic local ComfyUI execution.
- Modify: bridge/aigate_native.py — generic native execution preserving Boogu wrappers.
- Modify: bridge/bridge.py — validated dispatch.
- Modify: plugin/test_aigate_native.js, bridge/test_aigate_native.py, bridge/test_aigate_bridge.py, bridge/test_comfyui_connectivity.py — behavior tests.
- Modify: dev/dev_server.py — no-mask mock support.

### Task 1: Add and validate workflow assets

**Files:**
- Create: workflows/image_clarity_api.json
- Create: workflows/image_upscale_api.json

- [ ] **Step 1: Copy the supplied API workflow JSON files without changing nodes**

Copy /Users/apple/Documents/github/RH_CLI/workflows/ai/PS-图片清晰_api.json to workflows/image_clarity_api.json. Copy /Users/apple/Documents/github/RH_CLI/workflows/ai/PS-图片放大_api.json to workflows/image_upscale_api.json.

- [ ] **Step 2: Validate the contracts**

Run:

~~~
jq -e '."90".class_type == "LoadImage" and ."95".inputs.value == 2.0000000000000004 and ."100".class_type == "SaveImage"' workflows/image_clarity_api.json
jq -e '."90".class_type == "LoadImage" and ."95".inputs.value == 2.0000000000000004 and ."100".class_type == "SaveImage"' workflows/image_upscale_api.json
~~~

Expected: both commands print true and exit 0.

- [ ] **Step 3: Commit the assets**

~~~
git add workflows/image_clarity_api.json workflows/image_upscale_api.json
git commit -m "feat: add image enhance workflows"
~~~

### Task 2: Define the UXP workflow contract with tests first

**Files:**
- Modify: plugin/main.js:42-123
- Modify: plugin/run.js:82-143
- Modify: plugin/test_aigate_native.js:66-92

- [ ] **Step 1: Write failing tests for modes and AIGate availability**

Replace the test that expects cleanup and face to be disabled on AIGate with:

~~~js
test("image enhance selects each workflow variant", function () {
  var context = loadAigateContext();
  var workflow = context.findWorkflow("image-enhance");
  var clarity = context.getWorkflowRunConfig(workflow, {
    wfImageEnhanceMode: "clarity", wfImageEnhanceScale: "2.5"
  }, "runninghub");
  var upscale = context.getWorkflowRunConfig(workflow, {
    wfImageEnhanceMode: "upscale", wfImageEnhanceScale: "6"
  }, "aigate");

  assert.equal(clarity.workflowId, "2078092574119964674");
  assert.equal(clarity.workflowFile, "../workflows/image_clarity_api.json");
  assert.equal(clarity.imageNodeId, "90");
  assert.equal(clarity.outputNodeId, "100");
  assert.equal(upscale.workflowId, "2078099177921589250");
  assert.equal(upscale.workflowFile, "../workflows/image_upscale_api.json");
  assert.equal(context.getImageEnhanceScale("2.5"), 2.5);
  assert.equal(context.getImageEnhanceScale("8.1"), 2);
});

test("AIGate enables declared native workflows", function () {
  var context = loadAigateContext();
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("inpaint"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("cleanup"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("face"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("image-enhance"), "aigate"), true);
});
~~~

- [ ] **Step 2: Verify the tests fail**

Run:

~~~
node --test plugin/test_aigate_native.js
~~~

Expected: FAIL because image-enhance and getImageEnhanceScale are missing, and cleanup/face are unavailable.

- [ ] **Step 3: Implement only the metadata required by the tests**

Add to cleanup:

~~~js
aigateSupported: true,
outputNodeId: "220",
promptNodeId: "68",
promptField: "prompt",
~~~

Add to face:

~~~js
aigateSupported: true,
outputNodeId: "72",
promptNodeId: "2",
promptField: "text",
~~~

Add this workflow before gpt-image:

~~~js
{
  id: "image-enhance",
  name: "图像高清",
  icon: "✦",
  active: true,
  needsMask: false,
  aigateSupported: true,
  description: "图像清晰保持原始分辨率；图像放大会按比例提升分辨率。",
  inputs: [
    { id: "wfImageEnhanceMode", type: "select", label: "模式", default: "clarity", options: [
      { value: "clarity", label: "图像清晰（保持分辨率）" },
      { value: "upscale", label: "图像放大" }
    ] },
    { id: "wfImageEnhanceScale", type: "range", label: "放大比例", default: 2, min: 1, max: 8, step: 0.1 }
  ],
  variants: {
    clarity: { workflowId: "2078092574119964674", workflowFile: "../workflows/image_clarity_api.json", imageNodeId: "90", outputNodeId: "100" },
    upscale: { workflowId: "2078099177921589250", workflowFile: "../workflows/image_upscale_api.json", imageNodeId: "90", outputNodeId: "100" }
  },
  setArgs: function (inputs) {
    return ["95:value=" + getImageEnhanceScale(inputs.wfImageEnhanceScale)];
  }
},
~~~

Add this ES5 function to plugin/run.js:

~~~js
function getImageEnhanceScale(value) {
  var scale = parseFloat(value);
  if (!isFinite(scale) || scale < 1 || scale > 8) return 2;
  return Math.round(scale * 10) / 10;
}
~~~

Extend getWorkflowRunConfig to return outputNodeId, promptNodeId, and promptField. For image-enhance select workflow.variants[inputs.wfImageEnhanceMode] with clarity fallback. Add Boogu outputNodeId 224, promptNodeId 36, and promptField prompt. Change AIGate availability to:

~~~js
function isWorkflowAvailableForBackend(workflow, backend) {
  if (!workflow || workflow.active === false) return false;
  if (backend !== "aigate") return true;
  if (workflow.gptImage) return true;
  return workflow.id === "inpaint" || workflow.aigateSupported === true;
}
~~~

Always include outputNodeId, promptNodeId, promptField, and extraSetArgs in callBridge. Do not exclude extraSetArgs for the AIGate backend.

- [ ] **Step 4: Verify the tests pass**

Run:

~~~
node --test plugin/test_aigate_native.js
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~
git add plugin/main.js plugin/run.js plugin/test_aigate_native.js
git commit -m "feat: add image enhance workflow config"
~~~

### Task 3: Validate bridge argument overrides with tests first

**Files:**
- Create: bridge/workflow_runtime.py
- Create: bridge/test_workflow_runtime.py

- [ ] **Step 1: Write the failing test**

Create bridge/test_workflow_runtime.py:

~~~python
import unittest
from bridge.workflow_runtime import WorkflowInputError, apply_set_args

class WorkflowRuntimeTests(unittest.TestCase):
    def test_applies_numeric_and_text_values_to_declared_inputs(self):
        workflow = {"95": {"inputs": {"value": 2.0}}, "2": {"inputs": {"text": "old"}}}
        apply_set_args(workflow, ["95:value=3.5", "2:text=new prompt"])
        self.assertEqual(workflow["95"]["inputs"]["value"], 3.5)
        self.assertEqual(workflow["2"]["inputs"]["text"], "new prompt")

    def test_rejects_unknown_node_field_and_malformed_argument(self):
        workflow = {"95": {"inputs": {"value": 2.0}}}
        for value in ["bad", "96:value=2", "95:missing=2"]:
            with self.subTest(value=value):
                with self.assertRaises(WorkflowInputError):
                    apply_set_args(workflow, [value])
~~~

- [ ] **Step 2: Verify red**

Run:

~~~
python -m unittest bridge.test_workflow_runtime -v
~~~

Expected: FAIL because bridge.workflow_runtime does not exist.

- [ ] **Step 3: Implement the validator**

Create bridge/workflow_runtime.py:

~~~python
import json
import re

_SET_ARG_RE = re.compile(r"^([0-9]+):([A-Za-z_][A-Za-z0-9_ ]*)=(.*)$")

class WorkflowInputError(ValueError):
    pass

def _parse_value(raw):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return raw
    return value if isinstance(value, (str, int, float, bool)) or value is None else raw

def apply_set_args(workflow, set_args):
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
~~~

- [ ] **Step 4: Verify green**

Run:

~~~
python -m unittest bridge.test_workflow_runtime -v
~~~

Expected: OK with two passing tests.

- [ ] **Step 5: Commit**

~~~
git add bridge/workflow_runtime.py bridge/test_workflow_runtime.py
git commit -m "feat: validate workflow runtime arguments"
~~~

### Task 4: Make local ComfyUI execute the declared graph

**Files:**
- Modify: bridge/comfyui_exec.py:245-335
- Modify: bridge/test_comfyui_connectivity.py

- [ ] **Step 1: Write a failing local runner test**

Add LocalComfyuiWorkflowTests.test_uses_request_workflow_and_single_image_nodes. Mock urllib.request.urlopen and call:

~~~python
run_comfyui_blocking(
    image_path, None, output_dir, "", "http://127.0.0.1:8188",
    "../workflows/image_clarity_api.json", ["95:value=3.5"],
    "90", "", "100", "", "",
)
~~~

Assert submitted prompt injects the source at node 90, sets 95.inputs.value to 3.5, does not modify a mask, and reads PNG bytes from output node 100.

- [ ] **Step 2: Verify red**

Run:

~~~
python -m unittest bridge.test_comfyui_connectivity.LocalComfyuiWorkflowTests.test_uses_request_workflow_and_single_image_nodes -v
~~~

Expected: FAIL because the current local runner accepts only six arguments and reads config.json nodes.

- [ ] **Step 3: Implement dynamic local execution**

Change run_comfyui_blocking signature to:

~~~python
def run_comfyui_blocking(
    image_path, mask_path, out_dir, prompt="", comfyui_url="http://127.0.0.1:8188",
    workflow_file=None, extra_set_args=None, image_node_id=None, mask_node_id=None,
    output_node_id=None, prompt_node_id=None, prompt_field=None,
):
~~~

Resolve a supplied workflow_file relative to BRIDGE_DIR; otherwise preserve CONFIG workflow behavior. Inject a mask only when mask_path and mask_node_id are present. Set a prompt only when prompt, prompt_node_id, and prompt_field are non-empty. Apply apply_set_args. When output_node_id is supplied, read only outputs[str(output_node_id)]; otherwise retain current first-image output scanning.

- [ ] **Step 4: Verify green**

Run:

~~~
python -m unittest bridge.test_comfyui_connectivity -v
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~
git add bridge/comfyui_exec.py bridge/test_comfyui_connectivity.py
git commit -m "feat: configure local ComfyUI workflows per run"
~~~

### Task 5: Add generic AIGate native execution test-first

**Files:**
- Modify: bridge/aigate_native.py:428-522
- Modify: bridge/test_aigate_native.py:504-620

- [ ] **Step 1: Write the failing generic runner test**

Add AigateNativeHttpTests.test_runs_generic_single_image_workflow with:

~~~python
workflow = {
    "90": {"inputs": {"image": "old.png"}},
    "95": {"inputs": {"value": 2.0}},
    "100": {"inputs": {"filename_prefix": "ComfyUI"}},
}
result = await run_native_workflow_on_instance(
    self.api_base, image_path, None, "", "job-up", workflow,
    "90", "", "100", "", "", ["95:value=4.5"], progress.append,
    self.session, max_attempts=2, poll_interval=0,
)
~~~

Assert one image upload; no Authorization header on native ComfyUI requests; source name at node 90; 4.5 at node 95; prefix comfyps_aigate_job-up at node 100; and PNG result bytes.

- [ ] **Step 2: Verify red**

Run:

~~~
python -m unittest bridge.test_aigate_native.AigateNativeHttpTests.test_runs_generic_single_image_workflow -v
~~~

Expected: FAIL because run_native_workflow_on_instance does not exist.

- [ ] **Step 3: Implement generic execution preserving Boogu APIs**

Add run_native_workflow_on_instance and run_native_workflow. The generic runner uploads source, uploads a mask only when both mask_path and mask_node_id are supplied, deep-copies and validates each declared node, injects source/mask/prompt/arguments/output prefix, posts to uncredentialed ComfyUI, polls only outputs[output_node_id], and downloads its PNG.

Convert WorkflowInputError or missing node input to:

~~~python
AigateNativeError("COMFYUI_WORKFLOW_INVALID", "ComfyUI 工作流节点或参数无效", 400)
~~~

Do not change run_native_inpaint_on_instance, run_native_inpaint, or build_native_workflow; their Boogu behavior remains a compatibility path.

- [ ] **Step 4: Verify green and regressions**

Run:

~~~
python -m unittest bridge.test_aigate_native -v
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~
git add bridge/aigate_native.py bridge/test_aigate_native.py
git commit -m "feat: run generic workflows on AIGate"
~~~

### Task 6: Safely dispatch all backend contracts

**Files:**
- Modify: bridge/bridge.py:39-70,487-576
- Modify: bridge/test_aigate_bridge.py:523-570
- Modify: dev/dev_server.py:744-779

- [ ] **Step 1: Write failing endpoint tests**

Add a cleanup AIGate request test that posts:

~~~python
{
    "backend": "aigate", "aigateToken": "demo-token", "image": png_b64,
    "needsMask": False, "workflowFile": "../workflows/cleanup_api.json",
    "imageNodeId": "41", "outputNodeId": "220",
    "promptNodeId": "68", "promptField": "prompt", "prompt": "移除路人",
    "taskId": "cleanup42",
}
~~~

Patch bridge.run_native_workflow and assert it receives None mask, resolved cleanup_api.json, 41/220 input/output, 68.prompt, and [] extra arguments. Add an upscale test asserting image_upscale_api.json passes 90/100 and ["95:value=4"]. Add a third test posting ["95:value=8.1"] and asserting a 400 response with error COMFYUI_WORKFLOW_INVALID.

- [ ] **Step 2: Verify red**

Run:

~~~
python -m unittest bridge.test_aigate_bridge.AigateBridgeEndpointTests.test_runs_cleanup_without_mask_on_aigate bridge.test_aigate_bridge.AigateBridgeEndpointTests.test_forwards_image_upscale_factor_to_aigate -v
~~~

Expected: FAIL because the current endpoint rejects all AIGate no-mask requests.

- [ ] **Step 3: Implement explicit dispatch**

Import run_native_workflow. Read outputNodeId, promptNodeId, and promptField. Add resolve_repository_workflow_path(workflow_file): resolve relative to BRIDGE_DIR, require an existing .json below (BRIDGE_DIR / "../workflows").resolve(), otherwise raise:

~~~python
AigateNativeError("COMFYUI_WORKFLOW_INVALID", "工作流文件无效", 400)
~~~

For image_clarity_api.json and image_upscale_api.json, require exactly one extra argument matching 95:value=<finite number>; parse the number with float and reject values below 1, above 8, or non-finite with:

~~~python
AigateNativeError("COMFYUI_WORKFLOW_INVALID", "放大比例必须在 1 到 8 之间", 400)
~~~

Keep the fixed Boogu adapter only for AIGate requests where needsMask is true. For no-mask AIGate calls, require image/output IDs and call:

~~~python
result_bytes = await run_native_workflow(
    aigate_token, img_path, None, prompt, task_id, workflow_path,
    str(image_node_id), "", str(output_node_id), str(prompt_node_id or ""),
    str(prompt_field or ""), extra_set_args, aigate_progress, session,
)
~~~

Forward request metadata to local ComfyUI:

~~~python
lambda: run_comfyui_blocking(
    img_path, mask_path if needs_mask else None, out_dir, prompt, comfyui_url,
    workflow_file, extra_set_args, image_node_id, mask_node_id, output_node_id,
    prompt_node_id, prompt_field,
)
~~~

In dev/dev_server.py replace mandatory-mask validation with:

~~~python
if not image_b64 or (body.get("needsMask", True) and not mask_b64):
~~~

- [ ] **Step 4: Verify green**

Run:

~~~
python -m unittest bridge.test_aigate_bridge -v
~~~

Expected: PASS, including generic no-mask and Boogu adapter tests.

- [ ] **Step 5: Commit**

~~~
git add bridge/bridge.py bridge/test_aigate_bridge.py dev/dev_server.py
git commit -m "feat: dispatch image workflows across backends"
~~~

### Task 7: Run verification and prepare the required PR

**Files:**
- Verify: plugin/*.js, bridge/*.py, dev/dev_server.py, workflows/*.json

- [ ] **Step 1: Run focused suites**

Run:

~~~
node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js
python -m unittest bridge.test_workflow_runtime bridge.test_aigate_native bridge.test_aigate_bridge bridge.test_comfyui_connectivity dev.test_aigate_native dev.test_comfyui_connectivity -v
python -m py_compile bridge/bridge.py bridge/aigate_native.py bridge/comfyui_exec.py bridge/workflow_runtime.py dev/dev_server.py
find workflows -name '*_api.json' -print0 | xargs -0 -n1 jq empty
~~~

Expected: all tests pass, py_compile returns 0, and every workflow is valid JSON.

- [ ] **Step 2: Run the UXP ES5 gate**

Run:

~~~
rg -n --glob 'plugin/*.js' '(^|[^[:alnum:]_])(const|let|class)[[:space:]]|=>|\.find\(|Object\.assign\(|classList\.toggle\([^)]*,' plugin
~~~

Expected: no matches.

- [ ] **Step 3: Inspect and synchronize**

Run:

~~~
git diff origin/main...HEAD --check
git status --short --branch
git fetch origin
git rebase origin/main
~~~

Expected: no whitespace errors, clean worktree, and successful rebase. Resolve conflicts hunk by hunk; do not use whole-file ours or theirs.

- [ ] **Step 4: Push and create a merge-commit PR**

Run:

~~~
git push -u origin feat/image-enhance
~~~

Open a pull request to main summarizing both image-enhance modes, the shared local-ComfyUI path, and AIGate support for cleanup/face. Use merge commit, never squash.
