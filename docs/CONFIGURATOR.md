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
2. **Harnesses**: create a harness from a valid template, edit a version (instructions, model, tools, input and output
   JSON Schemas with an example input, limits, retry, and which agent profiles may run it), or create a new version.
   Every edit is validated as you type against the contracts, the execution profiles, and the policy; saving is
   blocked while there are errors. If committed content changes without a version bump, the editor offers a one-click
   bump.
3. **Policy**: approved agent profiles and models, limits, required controls, and acknowledged security gaps.
4. **Local run**: set the Foundry endpoint and deployments (or discover them from your subscription), optional package
   proxies, then **Build & start** the stack. After saving harness edits, **Reload harnesses** (or **Save & reload
   local API** in the editor) restarts only the API. Unit and full test suites run from here too.
5. **Try it**: pick the local stack or the selected Azure target, a harness version, an agent, and input (prefilled
   from the example), then watch events and the structured result. It warns when your files differ from what the
   service is running.
6. **Deploy**: describe one or more targets (tenant, subscription, region, resource group, existing Foundry account
   and deployments, with discovery), pass the preflight (configuration valid, signed in to the target tenant, Docker
   running), optionally **Preview infrastructure** (writes Bicep to `artifacts/deployment`), then **Deploy**. The
   Azure status card shows each container app, the API URL, and buttons to open the job console or copy the key.

Command output streams into the task drawer at the bottom; long tasks can be cancelled. Commit `harnesses/` and
`policy/` when you are happy: the configurator never commits or pushes for you.

## Where settings live

| What | Where | Commit? |
| --- | --- | --- |
| Harnesses | `harnesses/<name>/` and `harnesses/<name>@<version>/` | Yes |
| Execution policy | `policy/execution-policy.json` | Yes |
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
