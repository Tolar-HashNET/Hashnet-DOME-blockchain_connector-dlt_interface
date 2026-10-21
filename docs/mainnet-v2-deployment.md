# HashNET V2 mainnet deployment values

Apply `deployment/mainnet-v2.values.yaml` after the supplied access-node values. It targets the supplied wrapper dependencies: `access-node` 1.2.7 and the alias `dlt-adapter-hashnet` of Alastria `dlt-adapter` 8.0.0.

AWS ECR is retired. The overlay now proposes `ghcr.io/tolar-hashnet/dome-connector-dlt-interface:mainnet-v2-20261021`. Publish the prepared replacement image to the selected registry before deploying it. This work has not published the tag or changed a live deployment. See [registry options and upload instructions](image-registry-options.md).

The replacement image is built for Linux/AMD64 and Linux/ARM64. Keep both platform variants when loading and publishing the release; Docker's containerd image store supports this.

The overlay corrects these values:

| Value | Required setting |
| --- | --- |
| HashNET image repository | `ghcr.io/tolar-hashnet/dome-connector-dlt-interface` (proposed; no tag suffix) |
| HashNET image tag | `mainnet-v2-20261021` |
| Desmos `app.dltAdapter.internalDomain` | `http://dlt-adapter-hashnet:8080` |
| Desmos `app.dltAdapter.externalDomain` | `http://dlt-adapter-hashnet:8080` |
| Desmos `app.dltAdapter.provider` | `digitelts` |
| HashNET signing key | Secret `access-node-secret`, key `dlt-private-key`, in the release namespace |

Chart 8.0.0 renders the image as `repository:tag`, so the supplied repository ending in `:hashnet-integration` produces an invalid double tag. The chart renders the aliased Service name from `fullnameOverride`. Desmos uses its internal URL for its startup health check and its external URL for REST calls, so both must point to the HashNET Service. Keep `digitelts`: the Desmos v2.0.3 factory accepts only this provider name, independently of the underlying blockchain.

With `existingSecret.enabled: true`, chart 8.0.0 ignores `env.PRIVATE_KEY` and renders a `secretKeyRef`. The overlay also clears the redundant inline key in the effective Helm values. The original private values file must stay outside this repository. Signer funding cannot be verified from the configured inline value: the effective signer comes from the existing Secret. Check its derived public address and mainnet balance through your secret-management process without exposing the key.

The mainnet RPC URL, ISS, production floor `0`, and legacy contract address remain as supplied. The adapter converts the configured legacy contract address `0x544b1194f23bd9dd4f9f1a4d0e24a2ec86bbe3ca5ae079c9a6` to EVM address `0x4b1194f23bd9dd4f9f1a4d0e24a2ec86bbe3ca5a` for HashNET V2 Ethereum RPC calls.

The contract permits only its owner to publish. Read-only `owner()` on 2026-10-21 returned `0x495636f6ed54e5c19114d04e25cd9aca03b16d77`. Recheck it before rollout: the effective Secret's derived EVM address must match the current owner and hold enough TOL for fees. A funded unrelated key still reverts. Do not change ownership or transfer funds as part of this configuration correction.

Run `EXPECTED_CHAIN_ID=1 npm run verify:chain` inside the built adapter with the actual runtime environment. It checks the contract, event ABI, simulated publication, owner equality, and publisher balance without signing, submitting a transaction, or printing the private key. `npm run verify:chain -- --contract-only` checks the contract using a disposable simulation from its owner; it deliberately does not verify the Secret or publisher balance.

Publishing waits for confirmation and serializes requests for a signer within one process. Keep one adapter replica and a dedicated publishing account; sharing the same signer among multiple independent instances requires coordination outside this process. Subscriptions remain in memory and must be renewed after an adapter restart. Notifications begin at the live tail captured before the API accepts requests; historical retrieval still uses the configured production floor.

The supplied ABI does not match that deployed contract. Read-only mainnet bytecode inspection on 2026-10-21 found the six-argument `emitNewEvent(bytes32,bytes32,bytes32,string,string,string[])` selector `0xea968463` and the eight-field `EventDOMEv1` topic `0x1cd51b9a0e7a5215ccff58a059f28158d89e915273764818e05f7438a0f00acb`. The supplied ABI adds `authorAddress`, producing different selectors/topics. The overlay removes that argument from the event and function while preserving the remaining ABI entries. See the captured runtime and matching ABI in `test/fixtures/v2-dome-mainnet.json`. Use this ABI for the existing contract; no contract redeployment is needed.

Render locally against the supplied wrapper chart before applying through the existing release process:

```sh
helm dependency build /path/to/access-node-wrapper
helm template access-node /path/to/access-node-wrapper \
  --namespace YOUR_EXISTING_NAMESPACE \
  --values /path/to/private/base-values.yaml \
  --values deployment/mainnet-v2.values.yaml
```

Review the HashNET Deployment for the single image tag and `PRIVATE_KEY.valueFrom.secretKeyRef`, and the Desmos Deployment for both corrected URLs and `DLT_ADAPTER_PROVIDER=digitelts`. Existing non-HashNET components remain configured by the base values. The overlay does not disable the original Alastria adapter.

Verification used Helm 3.19.0 and the published, checksum-verified charts: `dlt-adapter` 8.0.0 SHA256 `19ce1f0e201897a65a27e24a1d8ce7cf6512bd849c8939a63a5ad9645dfa3a66`; `access-node` 1.2.7 SHA256 `951df85544a40c6b86c0f2c72baedc32d30aa024e5642105991c96839c9243aa`. Local rendering checks configuration only; it does not prove image availability, the live Secret, signer funding, or a successful mainnet publication.

References: [DLT chart repository](https://alastria.github.io/helm-charts/), [access-node chart repository](https://dome-marketplace.github.io/access-node/), [Desmos v2.0.3 provider factory](https://github.com/IN2Workspace/in2-dome-desmos-core-api/blob/v2.0.3/src/main/java/es/in2/desmos/domain/services/blockchain/adapter/factory/BlockchainAdapterFactory.java), [Desmos v2.0.3 REST adapter](https://github.com/IN2Workspace/in2-dome-desmos-core-api/blob/v2.0.3/src/main/java/es/in2/desmos/domain/services/blockchain/adapter/impl/BlockchainAdapterServiceImpl.java).

## Source verification and QA

Run `npm ci --ignore-scripts`, `npm run build`, and `npm test`. The default tests use only local HTTP fixtures. To run the QA health/subscribe/publish/events/notification flow on four real disposable V2 validators with a copy of the mainnet contract runtime:

```sh
HASHNET_V2_BIN_DIR=/path/to/HashNET-v2/build-clang22 npm run test:v2
```

Build those C/C++ binaries and any source dependencies with upstream Clang 22.x. The tests use public disposable fixture keys and loopback RPC only. They do not publish to mainnet or testnet. For QA on a deployed adapter, use a notification URL reachable from its pod; `127.0.0.1` refers to the pod itself. Use a current `endDate` in Unix milliseconds rather than the March example's fixed end date when looking for newly published events. The health endpoint confirms API readiness; `verify:chain` separately verifies chain/publisher configuration.

## Verification performed on 2026-10-21

- TypeScript build and all 39 tests passed, including both real four-validator V2 tests and readiness/notification tests. The real-chain tests use the captured mainnet runtime on an isolated chain, not a replacement test contract.
- The original supplied ABI failed the live read-only contract check. The corrected overlay passed against chain ID 1 at gas price 1, with a publishing gas estimate of 60,137. This simulated from the owner; it did not check the live Kubernetes Secret.
- Built the proposed image locally, then ran it with a disposable public test key at 384 MiB and 0.5 CPU. Its health and event retrieval endpoints returned HTTP 200 against mainnet, and its contract-only verifier passed. The smoke container was stopped and removed.
- The replacement release `mainnet-v2-20261021` was subsequently built and smoke-tested for both Linux/AMD64 and Linux/ARM64 at the same limits, exported to a compressed image archive, and proposed for GHCR. Upload options and the corresponding values are in `image-registry-options.md`; release digests are in `deployment/image-release.json`.
- Mainnet retrieval returned zero matching events. The contract's index storage slot was also zero, and the legacy archive reported available with 2,974,869 blocks; an empty event response does not by itself indicate an adapter error.

The source changes and local image have not been pushed/published, and no Kubernetes deployment or mainnet transaction was performed. Deployment still requires publishing the new image, applying the overlay through the existing release process, and verifying the effective Secret's owner address and balance. A live adapter URL was not available for testing the existing deployment itself.
