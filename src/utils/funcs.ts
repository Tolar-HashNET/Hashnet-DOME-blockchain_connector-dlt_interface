import {type AbiEventFragment, ContractAbi, Web3} from "web3";
import {AbiFunctionFragment} from "web3-types/src/eth_abi_types";

export async function sleep (ms: number) {return new Promise((r) => setTimeout(r, ms))};

// Legacy V1 RPC timestamps are milliseconds; V2 block timestamps are seconds.
export function toTimestampMilliseconds(timestamp: number): number {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error("Invalid blockchain timestamp");
    }
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export class DomeContract {
  private _abi: ContractAbi;
  private readonly _eventDOMEv1Abi: AbiEventFragment;
  private readonly _emitMethodAbi: AbiFunctionFragment;
  private static _instance: DomeContract | null = null;

  private constructor() {
    this._abi = JSON.parse(process.env.DOME_EVENTS_CONTRACT_ABI!) as ContractAbi;

    const eventDOMEv1Abi = this._abi.find(
        abiFragment => abiFragment.type === "event" &&
            (abiFragment as AbiEventFragment).name === "EventDOMEv1"
    );

    if(eventDOMEv1Abi === undefined) {
      throw new Error("Failed to extract ABI for eventDOMEv1");
    }

    this._eventDOMEv1Abi = eventDOMEv1Abi as AbiEventFragment;

    const emitMethodAbi = this._abi.find(
        abiFragment => abiFragment.type === "function" &&
            (abiFragment as AbiFunctionFragment).name === "emitNewEvent"
    );

    if(emitMethodAbi === undefined) {
      throw new Error("Failed to extract ABI for emitNewEvent method");
    }

    this._emitMethodAbi = emitMethodAbi as AbiFunctionFragment;
  }

  public static get instance() {
    if (this._instance === null) {
      this._instance = new DomeContract();
    }

    return this._instance;
  }

  get emitMethodAbi(): AbiFunctionFragment {
    return this._emitMethodAbi;
  }

  get eventDOMEv1Abi(): AbiEventFragment {
    return this._eventDOMEv1Abi;
  }
}

export interface HashnetEnv {
    rpcAddress: string;
    networkId: number;
    gasPrice: string;
}

export async function getHashnetEnv(rpcAddress = process.env.RPC_ADDRESS): Promise<HashnetEnv> {
    if (rpcAddress === undefined || rpcAddress === "") {
        throw new Error("Hashnet RPC_ADDRESS is missing");
    }

    const web3 = new Web3(rpcAddress);
    const [networkId, gasPrice] = await Promise.all([
        web3.eth.getChainId(), web3.eth.getGasPrice()
    ]);

    return {
        rpcAddress: rpcAddress,
        networkId: Number(networkId),
        gasPrice: gasPrice.toString(),
    };
}
