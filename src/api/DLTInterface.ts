import {
  converters,
  INVALID_NONCE, RpcPastEvent,
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
import {MAX_BLOCKS_PER_PULL} from "../subscriber/puller";
import {getHashnetEnv} from "../utils/funcs";

const debugLog = debug("DLT Interface Service: ");
const errorLog = debug("DLT Interface Service:error ");

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

    const data = web3.eth.abi.encodeFunctionCall(
        DomeContract.instance.emitMethodAbi, [
          iss,
          entityIDHash,
          previousEntityHash,
          eventType,
          dataLocation,
          relevantMetadata
    ]);

    const hashnetEnv = getHashnetEnv();

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
    let nonce = await web3.tolar.getNonce(senderAddress);
    if (nonce === INVALID_NONCE) {
      nonce = "0";
    }

    const txHash = await web3.tolar.sedTransactionWithWallet({
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
        (txHash: string) => web3.tolar.getTransaction(txHash),
        { timeout: 30_000, delay: 2000 },
    );

    debugLog("  > Transaction waiting to be mined...");
    const emitEventResult: RpcTxResponse = await retryGetTx(txHash);
    if (emitEventResult.excepted) {
      throw Error( `Failed to execute contract method with error: ${emitEventResult.exception}`);
    }

    debugLog("  > Transaction executed:\n" + JSON.stringify(emitEventResult));
    return emitEventResult.confirmationTimestamp;
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
 * @returns a JSON with all the DOME active events from the blockchain between the given dates with its timestamp truncated to seconds, not to miliseconds
 */
export async function getActiveDOMEEventsByDate(
    startDateMs: number,
    endDateMs: number,
    rpcAddress: string
): Promise<DomeEvent[]> {
  if(rpcAddress === ""){
    throw new IllegalArgumentError("The rpc address is blank.");
  }
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

  const blockCount = await web3.tolar.getBlockCount();
  const allPastEvents: RpcPastEvent[] = [];

  let fromIdx = web3.utils.toNumber(process.env.DOME_PRODUCTION_BLOCK_NUMBER!) as number;
  while (fromIdx <= blockCount) {
    const toIdx = fromIdx + Math.min(MAX_BLOCKS_PER_PULL - 1, blockCount - fromIdx);

    const pastEvents = await web3.tolar.getPastEventsByBlockRange(
        contractAddress,
        topic0,
        fromIdx,
        toIdx);
    allPastEvents.push(...pastEvents);

    fromIdx = toIdx + 1;
  }

  const domeEvents = allPastEvents
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