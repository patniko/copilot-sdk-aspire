using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Azure.AppContainers;
using Azure.Provisioning;
using Azure.Provisioning.AppContainers;
using Azure.Provisioning.Storage;
using FileShare = Azure.Provisioning.Storage.FileShare;

namespace CopilotAgent.Hosting;

/// <summary>Azure deployment constraints for the single-writer demo host.</summary>
public static class HostDeploymentExtensions
{
    /// <summary>Limits the host to one replica per revision. Drain the old revision before replacement.</summary>
    /// <param name="builder">The host container resource.</param>
    /// <param name="environment">The Azure environment that owns the host storage.</param>
    /// <returns>The configured host resource.</returns>
    [AspireExport]
    public static IResourceBuilder<ContainerResource> PublishAsSingletonHost(
        this IResourceBuilder<ContainerResource> builder,
        IResourceBuilder<AzureContainerAppEnvironmentResource> environment)
    {
        if (!builder.ApplicationBuilder.ExecutionContext.IsPublishMode)
        {
            return builder.WithVolume("demo-host-data", "/data");
        }
        return builder.PublishAsAzureContainerApp((infra, app) =>
        {
            app.Template.Scale.MinReplicas = 1;
            app.Template.Scale.MaxReplicas = 1;
            app.Configuration.ActiveRevisionsMode = ContainerAppActiveRevisionsMode.Single;
            var account = new StorageAccount("hostStorage")
            {
                Kind = StorageKind.StorageV2,
                Sku = new StorageSku { Name = StorageSkuName.StandardLrs },
                MinimumTlsVersion = StorageMinimumTlsVersion.Tls1_2,
                EnableHttpsTrafficOnly = true,
                AllowBlobPublicAccess = false,
            };
            var service = new FileService("hostFileService") { Parent = account };
            var share = new FileShare("hostShare")
            {
                Parent = service, Name = "host-state", ShareQuota = 10,
                EnabledProtocol = FileShareEnabledProtocol.Smb,
            };
            var existingEnvironment = ContainerAppManagedEnvironment.FromExisting("hostEnvironment");
            existingEnvironment.Name = environment.Resource.NameOutputReference.AsProvisioningParameter(infra);
            var storage = new ContainerAppManagedEnvironmentStorage("hostMount")
            {
                Parent = existingEnvironment, Name = "demo-host-data",
                ManagedEnvironmentStorageAzureFile = new ContainerAppAzureFileProperties
                {
                    AccountName = account.Name, AccountKey = account.GetKeys()[0].Unwrap().Value,
                    ShareName = share.Name, AccessMode = ContainerAppAccessMode.ReadWrite,
                },
            };
            storage.DependsOn.Add(share);
            infra.Add(account);
            infra.Add(service);
            infra.Add(share);
            infra.Add(existingEnvironment);
            infra.Add(storage);
            app.DependsOn.Add(storage);
            // SMB uses mount-level ownership/modes; keep byte-range locking enabled.
            app.Template.Volumes.Add(new ContainerAppVolume
            {
                Name = "host-data", StorageType = ContainerAppStorageType.AzureFile, StorageName = storage.Name,
                MountOptions = "uid=10001,gid=10001,dir_mode=0700,file_mode=0600,cache=strict",
            });
            var container = app.Template.Containers.Single().Value
                ?? throw new InvalidOperationException("The demo host requires exactly one container.");
            container.VolumeMounts.Add(new ContainerAppVolumeMount { VolumeName = "host-data", MountPath = "/data" });
        });
    }
}
