import axios from "axios";
import {createServer, IncomingMessage, Server, ServerResponse} from "http";
import {AddressInfo} from "net";
import {SimpleIntervalJob} from "toad-scheduler";
import {AbiEventFragment, Web3} from "web3";
import {authorAbi, contract, issuer, entity, previous, testKey} from "./fixtures/publish-config";

const savedEnv = {...process.env};
const web3 = new Web3();
const eventAbi = authorAbi.find(item => item.type === "event") as AbiEventFragment;
const startingHead = 2_980_959;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return {promise, resolve};
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
    return {server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`};
}

async function close(server: Server) {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function configure(rpc: string, productionFloor: number) {
    process.env = {...savedEnv, RPC_ADDRESS: rpc, ISS: issuer, PRIVATE_KEY: testKey,
        DOME_EVENTS_CONTRACT_ADDRESS: contract, DOME_EVENTS_CONTRACT_ABI: JSON.stringify(authorAbi),
        DOME_PRODUCTION_BLOCK_NUMBER: String(productionFloor)};
}

afterEach(() => { process.env = savedEnv; jest.restoreAllMocks(); });

it.each([1, 2_980_965])("starts notifications at the current head or production floor %i before accepting requests", async productionFloor => {
    let head = startingHead;
    let headQueries = 0;
    const firstHeadRequested = deferred();
    const releaseFirstHead = deferred();
    const ranges: number[][] = [];
    const received: unknown[] = [];
    const newBlock = Math.max(productionFloor, startingHead + 1);
    const rpcFixture = await serve(async (req, res) => {
        const call = await readJson(req);
        let result: unknown;
        if (call.method === "tol_getBlockCount") {
            if (headQueries++ === 0) {
                firstHeadRequested.resolve();
                await releaseFirstHead.promise;
            }
            result = head;
        } else if (call.method === "tol_getPastEventsFromBlocks") {
            const [, , from, to] = call.params;
            ranges.push([from, to]);
            result = {past_events: from <= newBlock && newBlock <= to ? [{
                address: contract.slice(2), topic: web3.eth.abi.encodeEventSignature(eventAbi).slice(2),
                topic_arg_0: issuer.slice(2), topic_arg_1: entity.slice(2), topic_arg_2: previous.slice(2),
                data: web3.eth.abi.encodeParameters(
                    ["uint256", "uint256", "address", "string", "string", "string[]"],
                    ["703", "1792535919", "0x" + "78".repeat(20), "ProductUpdated", "https://example.test/new", ["sbx"]]
                ).slice(2),
                block_index: newBlock, transaction_hash: "ab".repeat(32), block_hash: "cd".repeat(32)
            }] : []};
        } else {
            throw new Error(`Unexpected RPC method: ${call.method}`);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, result}));
    });
    const notifications = await serve(async (req, res) => {
        received.push(await readJson(req));
        res.statusCode = 204;
        res.end();
    });
    configure(rpcFixture.url, productionFloor);
    jest.resetModules();
    const expressModule = require("express");
    const listenSpy = jest.spyOn(expressModule.application, "listen");
    let application: any;
    try {
        application = require("../src/server");
        expect(listenSpy).not.toHaveBeenCalled();
        expect(typeof application.startServer).toBe("function");

        const starting = application.startServer(0);
        await firstHeadRequested.promise;
        expect(listenSpy).not.toHaveBeenCalled();
        releaseFirstHead.resolve();
        const apiServer: Server = await starting;
        const port = (apiServer.address() as AddressInfo).port;
        expect(port).toBeGreaterThan(0);
        expect((await axios.get(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        expect((await axios.post(`http://127.0.0.1:${port}/api/v1/subscribe`, {
            eventTypes: ["ProductUpdated"], notificationEndpoint: notifications.url
        })).status).toBe(201);

        head = newBlock;
        const jobs = application.scheduler.getAllJobs() as SimpleIntervalJob[];
        expect(jobs).toHaveLength(1);
        await jobs[0].executeAsync();
        expect(ranges).toEqual([[newBlock, newBlock]]);
        expect(received).toEqual([{
            id: 703, timestamp: 1792535919000, publisherAddress: issuer, entityIDHash: entity,
            previousEntityHash: previous, eventType: "ProductUpdated", dataLocation: "https://example.test/new",
            relevantMetadata: ["sbx"]
        }]);
    } finally {
        releaseFirstHead.resolve();
        application?.scheduler.stop();
        for (const result of listenSpy.mock.results) {
            if (result.type === "return") await close(result.value as Server);
        }
        await close(notifications.server);
        await close(rpcFixture.server);
    }
});
