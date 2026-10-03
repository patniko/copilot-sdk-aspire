# Configurator

The configurator is a local web app for this repository. It edits the real configuration files, checks them with the
same contracts the service uses, and drives the build, local run, test job, and Azure deployment, so the whole loop
happens in one place.

![Configurator overview](images/configurator-overview.png)

```powershell
pnpm install
pnpm configure
```

`pnpm configure` builds the UI, starts a companion server on `127.0.0.1:4280` (the next free port if taken), and opens
your browser with a one-time session URL. Keep the terminal open; press Ctrl+C to stop.

| Variable | Effect |
| --- | --- |
| `CONFIGURATOR_PORT` | Preferred port (default 4280). |
| `CONFIGURATOR_NO_OPEN=1` | Print the URL instead of opening a browser. |

## Workflow

1. **Overview** shows the pipeline, the tools on this machine (Node.js, pnpm, Aspire CLI, Docker, Azure CLI), and
   the policy every harness runs under.
2. **Harnesses**: create, edit, version, import and export harnesses (see [Editing harnesses](#editing-harnesses)).
   Every edit is validated as you type against the contracts, the execution profiles, and the policy; saving is
   blocked while there are errors. If committed content changes without a version bump, the editor offers a one-click
   bump.
3. **Policy**: approved agent profiles and models, limits, model-option ceilings (maximum reasoning effort, long
   context), required controls, and acknowledged security gaps.
4. **Local run**: set the Foundry endpoint and deployments (or discover them from your subscription), optional package
   proxies, then **Build & start** the stack. After saving harness edits, **Reload harnesses** (or **Save & reload
   local API** in the editor) restarts only the API. Unit and full test suites run from here too.
5. **Try it**: pick the local stack or the selected Azure target, a harness version, an agent, and input (prefilled
   from the example), then watch the activity timeline (turns, tools, sub-agent delegation, skills) and the structured
   result. It warns when your files differ from what the service is running.
6. **Deploy**: describe one or more targets (tenant, subscription, region, resource group, existing Foundry account
   and deployments, with discovery), pass the preflight (configuration valid, signed in to the target tenant, Docker
   running), optionally **Preview infrastructure** (writes Bicep to `artifacts/deployment`), then **Deploy**. The
   Azure status card shows each container app, the API URL, and buttons to open the job console or copy the key.

Command output streams into the task drawer at the bottom; long tasks can be cancelled. Commit `harnesses/` and
`policy/` when you are happy: the configurator never commits or pushes for you.

## Editing harnesses

The editor has one tab per part of the harness contract:

| Tab | What you set |
| --- | --- |
| Overview | Version, description, a summary, and what the platform does with the harness |
| Prompt | Prompt mode (replace, append, or customize the Copilot foundation prompt section by section) and the instructions |
| Model | Preferred and allowed models, reasoning effort, context tier (within the policy ceilings) |
| Tools | Tool bindings from the execution profiles; **Delegated only** hides a tool from the coordinator |
| Sub-agents | Specialists the coordinator delegates to: instructions, a subset of the tools, preloaded skills, model |
| Skills | Markdown procedures stored as `skills/<name>/SKILL.md` in the harness folder |
| Input, Output | JSON Schemas (2020-12) and an example input |
| Limits & retry | Duration, token budget, attempts, and whether uncertain attempts may be retried |
| Runtime | Which execution profiles may run the harness; profiles missing a needed tool binding or runner capability are flagged |

Other aids:

- **Help**: every setting has a **?** popover explaining what it does in this service, what each choice changes,
  and where the platform enforces limits regardless of the harness.
- **Decisions**: the Live plan (and the Overview tab on narrower screens) lists what the platform implements or
  enforces, what you should review (for example, appending the Copilot foundation prompt), and acknowledged gaps.
- **Undo and redo**: header buttons, or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z outside text fields. Ctrl/Cmd+S saves.
- **Drafts**: unsaved edits are kept in this browser per harness folder. Returning to a harness offers to restore the
  draft and warns if the files changed on disk since. Files change only when you save.
- **Templates**: **New harness** compares four starting points: structured answer, data analysis (Python tool),
  skill guided, and agent team (customized prompt, two sub-agents, a delegated-only tool, a skill). Each template
  validates against the current policy.
- **Import plan**: paste or open a plan JSON from the earlier Harness Builder. The report lists what was mapped
  (prompt mode and sections, instructions, model, reasoning, sub-agents), what needs work (custom tools and MCP
  servers need bindings, unapproved models), and what does not apply to hosted jobs (provider credentials, client
  mode, session storage, identity). Nothing is written until you create the harness.
- **Export JSON** downloads the resolved definition the API loads (instructions and skills inlined).
- **Changes since last commit** lists the saved fields, instructions and skills that differ from git HEAD.

`harnesses/insights-team` is a sample that uses every feature: a customized prompt, reasoning effort, a statistician
sub-agent that alone can call the Python statistics tool, and a reviewer sub-agent with a preloaded review skill.

![Sub-agents tab](images/configurator-subagents.png)

## Where settings live

| What | Where | Commit? |
| --- | --- | --- |
| Harnesses | `harnesses/<name>/` and `harnesses/<name>@<version>/` (`harness.json`, instructions, `skills/<name>/SKILL.md`) | Yes |
| Execution policy | `policy/execution-policy.json` | Yes |
| Unsaved harness drafts | Browser local storage for the configurator origin | No |
| Local run parameters (Foundry endpoint and deployments, package proxies) | The AppHost's Aspire user secrets | No (outside the repo) |
| Deployment targets, NuGet override for the Aspire CLI | `.configurator/settings.json` | No (git-ignored; IDs and names only) |
| Generated keys (dev API key, service keys, signing key) | Aspire user secrets and deployment state | Never shown, except on an explicit "Copy API key" |

Execution profiles and tool implementations are code; the configurator lists them but does not edit them. To add a
tool, implement it in the runners and add its binding to the profiles (see [RUNNER-PROTOCOL.md](RUNNER-PROTOCOL.md)).

## Security

The companion server can edit files and run commands, so it is locked down:

- Binds to `127.0.0.1` only and accepts only `127.0.0.1`/`localhost` Host headers (DNS-rebinding protection).
- Every API call needs the per-launch token from the session URL; cross-origin requests are refused.
- Runs only a fixed set of commands (`pnpm build`/`test`, `aspire start`/`stop`/`resource restart`/`publish`/`deploy`,
  `az login`). Values that reach a command line (names, IDs, URLs) are validated against strict patterns, and
  shell-routed commands refuse metacharacters.
- Writes only `harnesses/`, `policy/`, `.configurator/`, and the managed keys of the AppHost's user secrets; harness
  folder names are validated and confined to `harnesses/`.
- Status responses are allowlisted (Aspire `describe` output, which includes resource environments, is filtered).
  **Try it** attaches the API key on the server; the browser never needs it.

## Developing the configurator

```powershell
pnpm --filter @copilot-agent/configurator dev        # API server only, for UI development
pnpm --filter @copilot-agent/configurator exec vite  # UI with hot reload on 127.0.0.1:5173 (proxies /api)
pnpm test:unit                                       # includes configurator/test
```
