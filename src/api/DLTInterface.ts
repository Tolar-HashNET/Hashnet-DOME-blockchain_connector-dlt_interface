import {
  converters,
  INVALID_NONCE,
  RpcTxRequest,
  RpcTxResponse,
  TolarPlugin,
  ZERO_HEX_ADDRESS
} from "@tolar/web3-plugin-tolar";

import { debug } from "debug";
import { IllegalArgumentError } from "../exceptions/IllegalArgumentError";
import {DomeEvent, toDomeEvent} from "../utils/types";
import {HexString, Web3} from "web3";
import {retryDecorator} from "ts-retry-promise";
import {DomeContract} from "../utils/funcs";
import {getHashnetEnv, toTimestampMilliseconds} from "../utils/funcs";

const debugLog = debug("DLT Interface Service: ");
const errorLog = debug("DLT Interface Service:error ");

const publisherQueues = new Map<string, Promise<void>>();

async function serializePublisher<T>(key: string, publish: () => Promise<T>): Promise<T> {
  const previous = publisherQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {release = resolve;});
  publisherQueues.set(key, current);
  await previous;
  try {
    return await publish();
  } finally {
    release();
    if (publisherQueues.get(key) === current) publisherQueues.delete(key);
  }
}

/**
 * Publish DOME event as a blockchain event.
 *
 * @param eventType the name of the dome event
 * @param dataLocation the storage or location of the data associated with the event.
 * @param relevantMetadata additional information or metadata relevant to the event.
 * @param iss the organization identifier hash
 * @param rpcAddress the address of the blockchain node
 * @param entityIDHash entity identifier hash
 * @returns the timestamp of the block where the event was published to.
 */
export async function publishDOMEEvent(
    eventType: string,
    dataLocation: string,
    relevantMetadata: Array<string>,
    iss: string,
    entityIDHash: string,
    previousEntityHash: string,
    rpcAddress: string
) {
  if (eventType === undefined || eventType === null) {
    throw new IllegalArgumentError("The eventType is null.");
  }
  if (eventType === "") {
    throw new IllegalArgumentError("The eventType is blank.");
  }
  if (dataLocation === undefined || dataLocation === null) {
    throw new IllegalArgumentError("The dataLocation is null.");
  }
  if (dataLocation === "") {
    throw new IllegalArgumentError("The dataLocation is blank.");
  }
  if (iss === undefined || iss === null) {
    throw new IllegalArgumentError("The iss identifier is null.");
  }
  if (iss === "") {
    throw new IllegalArgumentError("The iss identifier is blank.");
  }
  if (entityIDHash === undefined || entityIDHash === null) {
    throw new IllegalArgumentError("The entity identifier hash is null.");
  }
  if (entityIDHash === "") {
    throw new IllegalArgumentError("The entity identifier hash is blank.");
  }
  if (previousEntityHash === null || previousEntityHash === undefined) {
    throw new IllegalArgumentError("The previousEntityHash is null.");
  }
  if (rpcAddress === undefined || rpcAddress === null) {
    throw new IllegalArgumentError("The rpc address is null.");
  }
  if (rpcAddress === "") {
    throw new IllegalArgumentError("The rpc address is null.");
  }
  for (const [name, value] of Object.entries({iss, entityIDHash, previousEntityHash})) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new IllegalArgumentError(`${name} must be a 32-byte hexadecimal value.`);
    }
  }
  if (!Array.isArray(relevantMetadata) || relevantMetadata.some(item => typeof item !== "string")) {
    throw new IllegalArgumentError("relevantMetadata must be an array of strings.");
  }

  try {
    debugLog(">>> Publishing event to blockchain node...");
    debugLog("  > Entry Data:", {
      iss,
      entityIDHash,
      previousEntityHash,
      eventType,
      dataLocation,
      relevantMetadata,
    });

    const web3 = new Web3(rpcAddress);
    web3.registerPlugin(new TolarPlugin());
    web3.tolar.wallet!.add(process.env.PRIVATE_KEY!);
    const senderAddress =  web3.tolar.wallet![0].address;

    debugLog("  > Ethereum Address of event publisher: ", senderAddress);

    const method = DomeContract.instance.emitMethodAbi;
    const argumentsList: unknown[] = [iss, entityIDHash, previousEntityHash, eventType, dataLocation, relevantMetadata];
    if (method.inputs?.length === 7) {
      argumentsList.splice(1, 0, converters.toEthAddress(senderAddress));
    }
    const data = web3.eth.abi.encodeFunctionCall(method, argumentsList);

    const hashnetEnv = await getHashnetEnv(rpcAddress);

    const contractTxRequest: RpcTxRequest = {
      senderAddress: senderAddress,
      receiverAddress: process.env.DOME_EVENTS_CONTRACT_ADDRESS!,
      amount: "0",
      networkId: converters.toNetworkId(hashnetEnv.networkId),
      nonce: "0",
      data: data,
      gas: "0",
      gasPrice: hashnetEnv.gasPrice,
    };

    debugLog("  > Ethereum Remittent: ", iss);
    debugLog("  > Publishing event to blockchain node...");

    const gasEstimate = await web3.tolar.getGasEstimate(contractTxRequest);
    const block = await web3.eth.getBlock("latest");
    if (BigInt(gasEstimate) <= BigInt(0) || BigInt(gasEstimate) > block.gasLimit) {
      throw new Error("Contract gas estimate is outside the block gas limit.");
    }
    // V1-compatible estimation returns a number even when the method reverts.
    // Check execution separately, especially for a wrong ABI or non-owner key.
    const simulation = await web3.tolar.tryCallTransaction({...contractTxRequest, gas: gasEstimate});
    if (simulation.excepted) {
      throw new Error("Contract preflight reverted; verify the contract ABI and publishing account.");
    }
    // tol_getNonce reports confirmed state. Serialize through confirmation.
    return await serializePublisher(`${hashnetEnv.networkId}:${senderAddress.toLowerCase()}`, async () => {
    contractTxRequest.gasPrice = (await web3.eth.getGasPrice()).toString();
    let nonce = await web3.tolar.getNonce(senderAddress);
    if (nonce === INVALID_NONCE) {
      nonce = "0";
    }

    const txHash = await web3.tolar.sendTransactionWithWallet({
      from: contractTxRequest.senderAddress,
      to: contractTxRequest.receiverAddress,
      value: contractTxRequest.amount,
      nonce: nonce,
      networkId: hashnetEnv.networkId,
      gas: gasEstimate,
      gasPrice: contractTxRequest.gasPrice,
      data: data
    });

    const retryGetTx = retryDecorator(
        async (txHash: string) => {
          const transaction = await web3.tolar.getTransaction(txHash);
          if (typeof transaction.excepted !== "boolean" ||
              !Number.isFinite(transaction.confirmationTimestamp.getTime())) {
            throw new Error("Transaction is not confirmed yet");
          }
          return transaction;
        },
        { timeout: 30_000, delay: 2000 },
    );

    debugLog("  > Transaction waiting to be mined...");
    const emitEventResult: RpcTxResponse = await retryGetTx(txHash);
    if (emitEventResult.excepted) {
      throw Error( `Failed to execute contract method with error: ${emitEventResult.exception}`);
    }

    debugLog("  > Transaction executed:\n" + JSON.stringify(emitEventResult));
    return new Date(toTimestampMilliseconds(emitEventResult.confirmationTimestamp.getTime()));
    });
  } catch (error) {
    errorLog(" > !! Error in publishDOMEEvent");
    throw error;
  }
}

/**
 * Returns all the DOME active events from the blockchain between given dates
 * @param startDateMs the given start date in miliseconds
 * @param endDateMs the given end date in miliseconds
 * @param endDateMs
 * @param rpcAddress
 * @returns active DOME events with timestamps in Unix milliseconds
 */
export async function getActiveDOMEEventsByDate(
    startDateMs: number,
    endDateMs: number,
    rpcAddress: string
): Promise<DomeEvent[]> {
  if(rpcAddress === ""){
    throw new IllegalArgumentError("The rpc address is blank.");
  }
  for (const value of [startDateMs, endDateMs]) {
    if (value === undefined || value === null || String(value).trim() === "" ||
        !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
      throw new IllegalArgumentError("Dates must be non-negative Unix milliseconds.");
    }
  }
  startDateMs = Number(startDateMs);
  endDateMs = Number(endDateMs);
  if(startDateMs > endDateMs){
    throw new IllegalArgumentError("The end date can't be lower than the start date.");
  }

  debugLog(
      `>>>> Getting active events between ${new Date(parseInt(startDateMs.toString()))} and ${new Date(parseInt(endDateMs.toString()))}`
  );

  const web3 = new Web3(rpcAddress);
  web3.registerPlugin(new TolarPlugin());

  const eventDOMEv1Abi = DomeContract.instance.eventDOMEv1Abi;

  const topic0 = web3.eth.abi.encodeEventSignature(eventDOMEv1Abi);
  const contractAddress = process.env.DOME_EVENTS_CONTRACT_ADDRESS!;

  // Query contract/topic-filtered events in one request. Mainnet retains millions
  // of mostly empty V1 blocks; walking every 1000-block page times out.
  const allPastEvents = await web3.tolar.getPastEvents(contractAddress, topic0);
  const productionBlock = Number(process.env.DOME_PRODUCTION_BLOCK_NUMBER);
  if (!Number.isSafeInteger(productionBlock) || productionBlock < 0) {
    throw new IllegalArgumentError("DOME_PRODUCTION_BLOCK_NUMBER is invalid.");
  }

  const domeEvents = allPastEvents
      .filter(event => event.blockIndex >= productionBlock)
      .map(rpcPastEvent => toDomeEvent(rpcPastEvent, web3, eventDOMEv1Abi.inputs!))
      .filter(domeEvent => domeEvent.timestamp >= startDateMs && domeEvent.timestamp <= endDateMs)

  const duplicateEvents = new Set<HexString>();
  return domeEvents.reverse().filter(domeEvent => {
    if(duplicateEvents.has(domeEvent.entityIDHash)) {
      return false;
    }

    duplicateEvents.add(domeEvent.entityIDHash);
    return true;
  }).reverse();
}
