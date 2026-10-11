import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.DEMO_HOST_TEMPLATE)("published GitHub-native Azure host", () => {
  it("emits singleton scale, private ingress, protected storage, and secret references", async () => {
    const template: unknown = JSON.parse(await readFile(process.env.DEMO_HOST_TEMPLATE!, "utf8"));
    assert(template && typeof template === "object" && "resources" in template && Array.isArray(template.resources));
    const resources: unknown[] = template.resources;
    const resource = (type: string) => resources.find((item: unknown) =>
      item && typeof item === "object" && "type" in item && item.type === type);
    expect(template.resources).toHaveLength(5);
    expect(template).not.toHaveProperty("parameters.aca_outputs_volumes_agent_host_0");
    expect(resource("Microsoft.App/containerApps")).toMatchObject({
      type: "Microsoft.App/containerApps",
      name: "agent-host",
      properties: {
        configuration: { activeRevisionsMode: "Single", ingress: { external: false } },
        template: {
          scale: { minReplicas: 1, maxReplicas: 1 },
          containers: [{
            env: expect.arrayContaining([
              { name: "DEMO_HOST_TRANSPORT", value: "github" },
              { name: "DEMO_HOST_GITHUB_TOKEN", secretRef: "demo-host-github-token" },
            ]),
            volumeMounts: [{ volumeName: "host-data", mountPath: "/data" }],
          }],
          volumes: [{
            name: "host-data", storageType: "AzureFile", storageName: "demo-host-data",
            mountOptions: "uid=10001,gid=10001,dir_mode=0700,file_mode=0600,cache=strict",
          }],
        },
      },
    });
    expect(resource("Microsoft.Storage/storageAccounts")).toMatchObject({
      kind: "StorageV2", sku: { name: "Standard_LRS" },
      properties: { minimumTlsVersion: "TLS1_2", supportsHttpsTrafficOnly: true, allowBlobPublicAccess: false },
    });
    expect(resource("Microsoft.Storage/storageAccounts/fileServices/shares")).toMatchObject({
      properties: { enabledProtocols: "SMB", shareQuota: 10 },
    });
    expect(resource("Microsoft.App/managedEnvironments/storages")).toMatchObject({
      properties: { azureFile: { accessMode: "ReadWrite", shareName: "host-state" } },
      dependsOn: expect.arrayContaining([expect.stringContaining("host-state")]),
    });
    expect(resource("Microsoft.App/containerApps")).toMatchObject({
      dependsOn: expect.arrayContaining([expect.stringContaining("demo-host-data")]),
    });
  });
});
