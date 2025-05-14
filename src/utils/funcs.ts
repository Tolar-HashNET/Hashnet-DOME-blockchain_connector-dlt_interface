import {type AbiEventFragment, ContractAbi} from "web3";
import {AbiFunctionFragment} from "web3-types/src/eth_abi_types";
export async function sleep (ms: number) {return new Promise((r) => setTimeout(r, ms))};

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
