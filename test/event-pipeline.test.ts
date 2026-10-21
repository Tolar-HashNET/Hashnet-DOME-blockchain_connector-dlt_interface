import {createServer, IncomingMessage, Server, ServerResponse} from "http";
import {AddressInfo} from "net";
import {RpcPastEvent} from "@tolar/web3-plugin-tolar";
import {AbiEventFragment, Web3} from "web3";
import {EventPuller} from "../src/subscriber/puller";
import {DomeEvent, toDomeEvent} from "../src/utils/types";
import notifier from "../src/subscriber/notifier";

// Event layout from the deployment values supplied with the mainnet QA report.
const EVENT_ABI: AbiEventFragment = {
    anonymous: false,
    type: "event",
    name: "EventDOMEv1",
    inputs: [
        {name: "index", type: "uint256", indexed: false},
        {name: "timestamp", type: "uint256", indexed: false},
        {name: "publisherAddress", type: "bytes32", indexed: true},
        {name: "authorAddress", type: "address", indexed: false},
        {name: "entityIDHash", type: "bytes32", indexed: true},
        {name: "previousEntityHash", type: "bytes32", indexed: true},
        {name: "eventType", type: "string", indexed: false},
        {name: "dataLocation", type: "string", indexed: false},
        {name: "metadata", type: "string[]", indexed: false}
    ]
};

const web3 = new Web3();
const publisher = "0x" + "ab".repeat(32);
const entity = "0x" + "12".repeat(32);
const previous = "0x" + "34".repeat(32);
const contract = "0x" + "56".repeat(25);
const topic = web3.eth.abi.encodeEventSignature(EVENT_ABI);
const encodedData = web3.eth.abi.encodeParameters(
    ["uint256", "uint256", "address", "string", "string", "string[]"],
    ["702", "1705401561000", "0x" + "78".repeat(20), "ProductOffering", "https://example.test/entity", ["region:EU"]]
);

const expectedEvent: DomeEvent = {
    id: 702,
    timestamp: 1705401561000,
    publisherAddress: publisher,
    entityIDHash: entity,
    previousEntityHash: previous,
    eventType: "ProductOffering",
    dataLocation: "https://example.test/entity",
    relevantMetadata: ["region:EU"]
};

function rpcEvent(blockIndex = 2001, data = encodedData): RpcPastEvent {
    return {
        address: contract,
        topic,
        topicArg0: publisher,
        topicArg1: entity,
        topicArg2: previous,
        data,
        transactionHash: "0x" + "9a".repeat(32),
        blockHash: "0x" + "bc".repeat(32),
        blockIndex
    };
}

// The Tolar RPC uses unprefixed hexadecimal fields; keep its converter real.
function rawRpcEvent(blockIndex = 2001, data = encodedData) {
    const event = rpcEvent(blockIndex, data);
    return {
        address: event.address.slice(2),
        topic: event.topic.slice(2),
        topic_arg_0: event.topicArg0.slice(2),
        topic_arg_1: event.topicArg1.slice(2),
        topic_arg_2: event.topicArg2.slice(2),
        data: event.data.slice(2),
        transaction_hash: event.transactionHash.slice(2),
        block_hash: event.blockHash.slice(2),
        block_index: blockIndex
    };
}

async function readJson(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString());
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const server = createServer((req, res) => {
        handler(req, res).catch(error => {
            res.statusCode = 500;
            res.end(String(error));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return {server, url: `http://127.0.0.1:${address.port}`};
}

async function close(server: Server) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("mainnet event decoding", () => {
    it("reads the deployed publisherAddress field instead of an absent origin field", () => {
        expect(toDomeEvent(rpcEvent(), web3, EVENT_ABI.inputs!)).toEqual(expectedEvent);
    });

    it("continues decoding older ABI events whose publisher field was named origin", () => {
        const oldInputs = EVENT_ABI.inputs!.map(input => input.name === "publisherAddress" ? {...input, name: "origin"} : input);
        expect(toDomeEvent(rpcEvent(), web3, oldInputs)).toEqual(expectedEvent);
    });

    it.each([
        [1_792_535_919, 1_792_535_919_000],
        [1_700_000_000_000, 1_700_000_000_000]
    ])("normalizes on-chain timestamp %i to API milliseconds %i", (timestamp, expectedTimestamp) => {
        const data = web3.eth.abi.encodeParameters(
            ["uint256", "uint256", "address", "string", "string", "string[]"],
            ["702", timestamp.toString(), "0x" + "78".repeat(20), "ProductOffering", "https://example.test/entity", ["region:EU"]]
        );
        expect(toDomeEvent(rpcEvent(2001, data), web3, EVENT_ABI.inputs!)).toEqual({
            ...expectedEvent,
            timestamp: expectedTimestamp
        });
    });
});

describe("event pull cursor", () => {
    it("pulls pages of at most 1000 inclusive blocks through the latest visible index", async () => {
        const ranges: number[][] = [];
        const {server, url} = await serve(async (req, res) => {
            const call = await readJson(req);
            let result: any;
            if (call.method === "tol_getBlockCount") {
                // V2's legacy RPC returns the latest index despite its name.
                result = 2001;
            } else if (call.method === "tol_getPastEventsFromBlocks") {
                const [, , from, to] = call.params;
                ranges.push([from, to]);
                result = {past_events: from <= 2001 && to >= 2001 ? [rawRpcEvent()] : []};
            } else {
                throw new Error(`Unexpected RPC method: ${call.method}`);
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, result}));
        });
        try {
            const puller = new EventPuller(url, contract, EVENT_ABI, 1);
            expect(await puller.pull()).toEqual([]);
            expect(await puller.pull()).toEqual([]);
            expect(await puller.pull()).toEqual([expectedEvent]);
            expect(await puller.pull()).toEqual([]);
            expect(ranges).toEqual([[1, 1000], [1001, 2000], [2001, 2001]]);
            expect(puller.fromBlockIdx).toBe(2002);
        } finally {
            await close(server);
        }
    });

    it("retries the same block after event decoding fails", async () => {
        const ranges: number[][] = [];
        let malformed = true;
        const {server, url} = await serve(async (req, res) => {
            const call = await readJson(req);
            let result: any = 17;
            if (call.method === "tol_getPastEventsFromBlocks") {
                ranges.push(call.params.slice(2));
                result = {past_events: [rawRpcEvent(17, malformed ? "0x01" : encodedData)]};
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, result}));
        });
        try {
            const puller = new EventPuller(url, contract, EVENT_ABI, 17);
            await expect(puller.pull()).rejects.toThrow();
            expect(puller.fromBlockIdx).toBe(17);
            malformed = false;
            expect(await puller.pull()).toEqual([expectedEvent]);
            expect(ranges).toEqual([[17, 17], [17, 17]]);
            expect(puller.fromBlockIdx).toBe(18);
        } finally {
            await close(server);
        }
    });

    it("retries the same block after an RPC rejection", async () => {
        let fail = true;
        const ranges: number[][] = [];
        const {server, url} = await serve(async (req, res) => {
            const call = await readJson(req);
            res.setHeader("Content-Type", "application/json");
            if (call.method === "tol_getBlockCount") {
                res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, result: 17}));
                return;
            }
            ranges.push(call.params.slice(2));
            res.end(JSON.stringify(fail ?
                {jsonrpc: "2.0", id: call.id, error: {code: -32000, message: "temporary read failure"}} :
                {jsonrpc: "2.0", id: call.id, result: {past_events: [rawRpcEvent(17)]}}));
        });
        try {
            const puller = new EventPuller(url, contract, EVENT_ABI, 17);
            await expect(puller.pull()).rejects.toThrow("temporary read failure");
            expect(puller.fromBlockIdx).toBe(17);
            fail = false;
            expect(await puller.pull()).toEqual([expectedEvent]);
            expect(ranges).toEqual([[17, 17], [17, 17]]);
        } finally {
            await close(server);
        }
    });
});

describe("event notifications", () => {
    it("posts matching own-ISS events regardless of hexadecimal casing", async () => {
        const received: DomeEvent[] = [];
        const {server, url} = await serve(async (req, res) => {
            received.push(await readJson(req));
            res.statusCode = 204;
            res.end();
        });
        try {
            notifier.add(url, {eventTypes: ["ProductOffering"], ownIss: publisher.toUpperCase()});
            await notifier.notify([
                expectedEvent,
                {...expectedEvent, eventType: "UnsubscribedType"},
                {...expectedEvent, publisherAddress: "0x" + "cd".repeat(32)}
            ]);
            expect(received).toEqual([expectedEvent]);
        } finally {
            await close(server);
        }
    });
});
