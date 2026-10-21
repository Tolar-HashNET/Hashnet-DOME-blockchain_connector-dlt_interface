# Replacement container image and registry options

Prepared release tag: `mainnet-v2-20261021`.
Local image: `dome-connector-dlt-interface:mainnet-v2-20261021`.
Platforms: `linux/amd64` and `linux/arm64`.

This packages the mainnet compatibility fixes and no longer depends on the retired AWS registry. The GHCR release was uploaded and made public on 2026-10-22. Public package creation is enabled for Tolar-HashNET and remains enabled at the owner's request. No other existing package visibility was changed.

## Selected: GitHub Container Registry

Uploaded image: `ghcr.io/tolar-hashnet/dome-connector-dlt-interface:mainnet-v2-20261021`.

Published index digest: `sha256:45767a62a079c07b0733c8dd46b8ab9e9eaec9c83586ccc2876f8be0d131b377`. Both Linux platforms were built from commit `7cab3747e7edd591d43ca51fc6a179a5c7805e99` in the [successful publishing run](https://github.com/Tolar-HashNET/Hashnet-DOME-blockchain_connector-dlt_interface/actions/runs/39688918764). The workflow passed 37 tests; the two real-validator tests require local Clang-22-built V2 binaries and also passed locally (39 tests total).

This keeps the image beside the existing GitHub organization and source repository. Public GHCR images support anonymous pulls, so a public package needs no Kubernetes registry credentials. Publishing requires permission in the organization; manual Docker authentication uses a personal access token (classic) with `write:packages`, and SSO authorization if required. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

On the machine with the prepared image, authenticate at Docker's password prompt, then tag and upload:

```sh
docker login ghcr.io --username YOUR_GITHUB_USERNAME
docker tag dome-connector-dlt-interface:mainnet-v2-20261021 ghcr.io/tolar-hashnet/dome-connector-dlt-interface:mainnet-v2-20261021
docker push ghcr.io/tolar-hashnet/dome-connector-dlt-interface:mainnet-v2-20261021
```

This release's package visibility is Public. For future new packages, explicitly set visibility after the first push and verify an unauthenticated pull. Enabling public package creation for the organization does not automatically make newly pushed packages public.

Update this exact subtree in the supplied wrapper's `values.yaml`:

```yaml
dlt-adapter-hashnet:
  image:
    repository: ghcr.io/tolar-hashnet/dome-connector-dlt-interface
    tag: mainnet-v2-20261021
    pullPolicy: Always
```

`deployment/mainnet-v2.values.yaml` contains this setting plus the ABI and Desmos corrections. The supplied local `values.yaml` was updated with the same public configuration, preserving all other values and secrets; its pre-change backup stays outside Git. Apply the overlay after the original private values if using that deployment method. Do not replace the full private values file with this small example.

## Alternative: Docker Hub

Create a repository under a namespace you control. Replace `YOUR_NAMESPACE` below before running these commands:

```sh
docker login
docker tag dome-connector-dlt-interface:mainnet-v2-20261021 docker.io/YOUR_NAMESPACE/dome-connector-dlt-interface:mainnet-v2-20261021
docker push docker.io/YOUR_NAMESPACE/dome-connector-dlt-interface:mainnet-v2-20261021
```

Use `docker.io/YOUR_NAMESPACE/dome-connector-dlt-interface` for `image.repository` and the same release tag. Public repositories are convenient, but Docker Hub applies pull limits depending on authentication and plan, which can matter for shared Kubernetes egress. See [Docker Hub usage and limits](https://docs.docker.com/docker-hub/usage/).

## Alternative: IONOS Private Container Registry

This fits an IONOS deployment when private distribution is preferred. It requires provisioning a registry under the relevant account/contract. Use the exact hostname returned by IONOS, authenticate with its registry credentials, then tag and push the same local image under `YOUR_REGISTRY_HOST/dome-connector-dlt-interface:mainnet-v2-20261021`.

IONOS repositories cannot be made public and always require authentication. See [IONOS registry overview](https://docs.ionos.com/cloud/containers/private-container-registry/overview) and [public-access limitations](https://docs.ionos.com/cloud/containers/private-container-registry/faqs).

```yaml
dlt-adapter-hashnet:
  image:
    repository: YOUR_REGISTRY_HOST/dome-connector-dlt-interface
    tag: mainnet-v2-20261021
    pullPolicy: Always
  imagePullSecrets:
    - name: dome-registry-pull
```

Create `dome-registry-pull` as a Kubernetes registry-credentials Secret in the same namespace as the adapter, using the existing secret-management process. This setting is supported by the actual `dlt-adapter` 8.0.0 chart. It is separate from `existingSecret`, which supplies the blockchain signing key. The same `imagePullSecrets` pattern applies if GHCR or Docker Hub is kept private.

## Portable image archive

The prepared image is exported to `artifacts/dome-connector-dlt-interface-mainnet-v2-20261021.tar.gz`, with a SHA256 sidecar. The archive is local and ignored by Git. Transfer it to the upload machine if needed, then load it:

```sh
(cd artifacts && shasum -a 256 -c dome-connector-dlt-interface-mainnet-v2-20261021.tar.gz.sha256)
docker load --input artifacts/dome-connector-dlt-interface-mainnet-v2-20261021.tar.gz
docker image ls --tree dome-connector-dlt-interface:mainnet-v2-20261021
```

Use Docker Desktop or Docker Engine 29+ with the containerd image store so both platform variants are retained. See [multi-platform support](https://docs.docker.com/build/building/multi-platform/) and [image export behavior](https://docs.docker.com/reference/cli/docker/image/save/). Do not pass a single-platform option when loading or pushing this multi-platform release.

To rebuild directly on a suitable build machine after the source is committed:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  --label org.opencontainers.image.source=https://github.com/Tolar-HashNET/Hashnet-DOME-blockchain_connector-dlt_interface \
  --label org.opencontainers.image.version=mainnet-v2-20261021 \
  --tag dome-connector-dlt-interface:mainnet-v2-20261021 --load .
```

Treat this release tag as fixed. Use a new tag for future source changes rather than overwriting a deployed version.

### Publish subsequent releases with GitHub Actions

The retired AWS workflow is replaced by `.github/workflows/publish-ghcr.yml`.
It uses the repository's short-lived `GITHUB_TOKEN` with `packages: write`,
not an AWS account or a stored personal token. Update the release tag in
`deployment/image-release.json` and the Helm values, commit the source, then
push a matching `mainnet-v2-YYYYMMDD` Git tag (use a suffix for a second
release on the same date). The workflow tests the source and publishes
both platforms with source/version/revision labels. It refuses to overwrite
an existing release tag. Package visibility is set separately in GitHub's
package settings; the workflow cannot assume that it is public.

Release identity and source-context checksum are recorded in `deployment/image-release.json`. Both locally prepared variants were started at 384 MiB and 0.5 CPU: health and event retrieval returned HTTP 200, and read-only simulation of publishing against the current mainnet contract passed. No `.env` file is baked into either image. The local archive represents the prepared local build; GHCR was rebuilt by CI from the same source context with an additional revision label, so its manifest digest differs. The archive remains local and is not in Git.

After publication, both GHCR platforms were pulled with an empty Docker credential configuration and smoke-tested again at the same limits. Health and event retrieval returned HTTP 200, and read-only mainnet contract simulation passed on chain ID 1 at gas price 1. The published images contain no `.env` file. No mainnet transaction was submitted.

## Update the existing deployment

Publish and verify the chosen image first. Then update the same ArgoCD/GitOps values that own the existing release, keeping the registry path and tag in separate fields. `Chart.yaml` needs no dependency change for a registry move. Keep the corrected ABI, mainnet endpoint, contract address, issuer and signing-key Secret settings from the compatibility overlay.

Render with the supplied chart versions before syncing. For a private image, confirm the namespace's pull Secret is configured. After rollout, check `/health`, run the read-only `verify:chain` command with the effective runtime environment, and perform the authorized QA flow described in [the deployment guide](mainnet-v2-deployment.md). An upload or values proposal alone does not update the running adapter.
