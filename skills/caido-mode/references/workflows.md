# Create and use workflows

Use a workflow when a check will be reused across requests, observes traffic passively, or belongs in Caido preprocessing. Script a simpler one-off. Choose the useful mechanism and execute; reconsider after a concrete failure or changed requirement.

Author JavaScript in a local file, then:

```console
npx tsx <skill-root>/caido-client.ts build-workflow --kind convert --name "Normalize data" --code @check.js --output definition.json
npx tsx <skill-root>/caido-client.ts test-workflow --input @definition.json --data hello
npx tsx <skill-root>/caido-client.ts create-workflow --input @definition.json
npx tsx <skill-root>/caido-client.ts run-workflow WORKFLOW_ID --data hello
```

The saved JSON is an editable Caido workflow graph. The builder selects supported start/JavaScript/end node versions from the connected instance. Inspect `workflow-nodes code-js` before writing code for an unfamiliar node version. Current convert JavaScript nodes follow the [JavaScript node guide](https://docs.caido.io/app/guides/workflows_javascript):

```javascript
export function run({data, extra}, sdk) {
  return {data: sdk.asString(data), extra};
}
```

For HTTP checks choose `--kind active` or `--kind passive`; code receives `{request, response, extra}`. Test using `test-workflow --input @definition.json --request-id REQUEST_ID`, or a synthetic `--request @raw --host HOST [--port PORT --tls --response @raw]`. `--response @raw` can also override the captured response when using `--request-id`. Active execution uses `run-workflow ID --request-id REQUEST_ID`. For passive graphs, `--event request|response` chooses the trigger. Scope the code to intended hosts and sources before enabling; test against a fixture first. A test executes the supplied code, including its network requests or finding creation.

Creation defaults to project-local and disabled; request `--global` and `--enable` explicitly. `workflows`, `get-workflow ID`, `update-workflow ID --input @definition.json`, `toggle-workflow ID --on|--off`, and `delete-workflow ID` manage exact workflow IDs. Update preserves enabled state.

For binary convert results, return `{data: new Uint8Array([...])}`; a bare array is not a node result. Convert test/run output defaults to UTF-8 text. Use `--raw` to include base64 bytes as `{output: {encoding: "base64", data: "…"}}`; tests also include their engine trace. Use `--output FILE` to save the complete result regardless of terminal output limits.

Useful recurring checks include selected missing response headers, controlled actor/auth comparisons, normalization before payloads, and token extraction for repeated sequences. Keep scope and actor controls in the code. Interpret the result before creating a finding.
