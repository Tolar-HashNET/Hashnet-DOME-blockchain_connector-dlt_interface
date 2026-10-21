import {Web3} from "web3";
import {converters, TolarPlugin} from "@tolar/web3-plugin-tolar";
import {DomeContract, getHashnetEnv} from "../src/utils/funcs";

// Reads configuration from the runtime environment; never loads the tracked .env.
// No signing, transaction submission, or HTTP notifications occur in this check.
async function verifyChain(contractOnly: boolean) {
  for (const key of ["RPC_ADDRESS", "DOME_EVENTS_CONTRACT_ADDRESS", "DOME_EVENTS_CONTRACT_ABI", "ISS"]) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const web3 = new Web3(process.env.RPC_ADDRESS!);
  web3.registerPlugin(new TolarPlugin());
  const network = await getHashnetEnv();
  if (process.env.EXPECTED_CHAIN_ID && Number(process.env.EXPECTED_CHAIN_ID) !== network.networkId) {
    throw new Error("RPC chain ID differs from EXPECTED_CHAIN_ID");
  }
  const contract = converters.toEthAddress(process.env.DOME_EVENTS_CONTRACT_ADDRESS!);
  const code = await web3.eth.getCode(contract);
  if (code === "0x") throw new Error("Configured contract has no deployed code");
  const owner = web3.eth.abi.decodeParameter("address", await web3.eth.call({to: contract, data: "0x8da5cb5b"})) as string;
  const ownerAddress = converters.toTolHexAddress(owner);
  const abi = DomeContract.instance;
  const topic = web3.eth.abi.encodeEventSignature(abi.eventDOMEv1Abi);
  // The configured non-proxy DOME contract embeds its fixed event topic.
  if (!code.toLowerCase().includes(topic.slice(2).toLowerCase())) {
    throw new Error("Configured event ABI does not match the deployed DOME runtime");
  }
  const args: unknown[] = [process.env.ISS, "0x" + "ab".repeat(32), "0x" + "00".repeat(32),
    "ProductUpdated", "https://example.invalid/dome-readonly-check", ["sbx"]];
  if (abi.emitMethodAbi.inputs?.length === 7) args.splice(1, 0, owner);
  const transaction = {
    senderAddress: ownerAddress, receiverAddress: process.env.DOME_EVENTS_CONTRACT_ADDRESS!, amount: "0",
    networkId: converters.toNetworkId(network.networkId), nonce: "0", gas: "0", gasPrice: network.gasPrice,
    data: web3.eth.abi.encodeFunctionCall(abi.emitMethodAbi, args)
  };
  transaction.gas = await web3.tolar.getGasEstimate(transaction);
  const block = await web3.eth.getBlock("latest");
  if (BigInt(transaction.gas) <= BigInt(0) || BigInt(transaction.gas) > block.gasLimit ||
      (await web3.tolar.tryCallTransaction(transaction)).excepted) {
    throw new Error("Publishing simulation failed; verify the contract ABI and ownership");
  }
  let publisher: {address: string; balance: string} | null = null;
  if (!contractOnly) {
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required to check the effective publisher; use --contract-only for contract checks");
    let address: string;
    try {
      web3.tolar.wallet!.add(process.env.PRIVATE_KEY);
      address = converters.toEthAddress(web3.tolar.wallet![0].address);
    } catch {throw new Error("PRIVATE_KEY is invalid");}
    if (address.toLowerCase() !== owner.toLowerCase()) throw new Error("Effective publisher is not the contract owner");
    const balance = await web3.eth.getBalance(address);
    if (balance < BigInt(transaction.gas) * BigInt(transaction.gasPrice)) throw new Error("Effective publisher has insufficient balance for publishing fees");
    publisher = {address, balance: balance.toString()};
  }
  return {chainId: network.networkId, gasPrice: network.gasPrice, contract, owner, eventTopic: topic,
    estimatedGas: transaction.gas, contractReady: true, publisher, contractOnly};
}

if (require.main === module) {
  verifyChain(process.argv.includes("--contract-only"))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {console.error(error.message); process.exitCode = 1;});
}

export {verifyChain};
