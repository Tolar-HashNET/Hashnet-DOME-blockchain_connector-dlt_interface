import {StrHexAddress, StrHexHash, TolarPlugin} from "@tolar/web3-plugin-tolar";
import {type AbiEventFragment, Web3} from "web3";
import {toDomeEvent} from "../utils/types";


export const MAX_BLOCKS_PER_PULL = 1000;

export class EventPuller {
    private readonly _contractAddress: StrHexAddress;
    private _fromBlockIdx: number;
    private readonly _eventDOMEv1Abi: AbiEventFragment;
    private readonly _topic0: StrHexHash;
    private readonly _web3: Web3;

    public constructor(
        rpcAddress: string,
        contractAddress: StrHexAddress,
        eventDOMEv1Abi: AbiEventFragment,
        fromBlockIdx: number
    ) {
        this._web3 = new Web3(rpcAddress);
        this._web3.registerPlugin(new TolarPlugin());

        this._contractAddress = contractAddress;
        this._eventDOMEv1Abi = eventDOMEv1Abi;
        this._topic0 = this._web3.eth.abi.encodeEventSignature(this._eventDOMEv1Abi);
        this._fromBlockIdx = fromBlockIdx;
    }

    public async pull() {
        const blockCount = await this._web3.tolar.getBlockCount();
        if (this._fromBlockIdx > blockCount) {
            return;
        }

        const toBlockIndex = blockCount - this._fromBlockIdx > MAX_BLOCKS_PER_PULL ?
            this._fromBlockIdx + MAX_BLOCKS_PER_PULL :
            blockCount;

        const rpcPastEvent = await this._web3.tolar.getPastEventsByBlockRange(
            this._contractAddress,
            this._topic0,
            this._fromBlockIdx,
            toBlockIndex);

        this._fromBlockIdx = toBlockIndex + 1;

        if(rpcPastEvent === undefined || rpcPastEvent === null || rpcPastEvent.length === 0) {
            return [];
        }

        return rpcPastEvent.map((rpcEvent) => {
            return toDomeEvent(rpcEvent, this._web3, this._eventDOMEv1Abi.inputs!);
        });
    }

    get fromBlockIdx(): number {
        return this._fromBlockIdx;
    }
}