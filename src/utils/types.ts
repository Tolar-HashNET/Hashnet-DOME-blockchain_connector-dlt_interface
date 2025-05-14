import {RpcPastEvent, StrHexAddress} from "@tolar/web3-plugin-tolar";
import {AbiParameter, HexString, Web3} from "web3";

export interface DomeEvent {
    id: number;
    publisherAddress: StrHexAddress;
    entityIDHash: HexString;
    previousEntityHash: HexString;
    eventType: string;
    timestamp: number;
    dataLocation: string;
    relevantMetadata: string[];
}

export interface SubscriberFilter {
    eventTypes: string[],
    ownIss: string
}

export function toDomeEvent(rpcPastEvent: RpcPastEvent, web3: Web3, eventDOMEv1AbiParams: readonly AbiParameter[]): DomeEvent {
    const rawParams = web3.eth.abi.decodeLog(
        eventDOMEv1AbiParams,
        rpcPastEvent.data,
        [rpcPastEvent.topicArg0, rpcPastEvent.topicArg1, rpcPastEvent.topicArg2]);

    const eventType = rawParams.eventType as string;
    const id = Number(rawParams.index as bigint);

    return {
        id: Number(rawParams.index as bigint),
        publisherAddress: rawParams.origin as HexString,
        entityIDHash: rawParams.entityIDHash as HexString,
        previousEntityHash: rawParams.previousEntityHash as HexString,
        eventType: rawParams.eventType as string,
        timestamp: Number(rawParams.timestamp as bigint),
        dataLocation: rawParams.dataLocation as string,
        relevantMetadata: rawParams.metadata as string[]
    };
}