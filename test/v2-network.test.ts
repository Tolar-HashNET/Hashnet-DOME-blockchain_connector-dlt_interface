import {ChildProcess, execFileSync, spawn} from "child_process";
import {closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync} from "fs";
import {createServer, request, Server} from "http";
import {AddressInfo} from "net";
import {tmpdir} from "os";
import {join, resolve} from "path";
import express from "express";
import {AbiEventFragment} from "web3";
import {converters} from "@tolar/web3-plugin-tolar";
import {DomeEvent} from "../src/utils/types";

// Optional real-process regression, never needed by the normal unit-test run:
// HASHNET_V2_BIN_DIR=/path/to/HashNET-v2/build-clang22 npm test -- --runInBand test/v2-network.test.ts
// All keys come from hashnet-test-fixtures (public keys 1..20); an inherited PRIVATE_KEY is never used.
const describeV2 = process.env.HASHNET_V2_BIN_DIR ? describe : describe.skip;
const domeFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/v2-dome-mainnet.json"), "utf8"));
const eventAbi = domeFixture.abi.find((entry: any) => entry.type === "event") as AbiEventFragment;
const publisher = "0x" + "ab".repeat(32);
const entity = "0x" + "12".repeat(32);
const previous = "0x" + "34".repeat(32);

interface Reply { status: number; body: any; }

function http(url: string, body?: any, timeout = 5000): Promise<Reply> {
    if (new URL(url).hostname !== "127.0.0.1") throw new Error("V2 regression HTTP must stay on loopback");
    return new Promise((resolveReply, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request(url, {
            method: payload === undefined ? "GET" : "POST",
            headers: payload === undefined ? {} : {"Content-Type": "application/json"},
            timeout
        }, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                let parsed: any = text;
                try { parsed = JSON.parse(text); } catch { /* Some adapter responses are plain text. */ }
                resolveReply({status: res.statusCode!, body: parsed});
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Local HTTP request timed out")));
        req.end(payload);
    });
}

async function rpc(url: string, method: string, params: any[] = []): Promise<any> {
    const reply = await http(url, {jsonrpc: "2.0", id: 1, method, params});
    if (reply.status !== 200 || reply.body.error) throw new Error(`${method}: ${JSON.stringify(reply.body)}`);
    return reply.body.result;
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function eventually<T>(probe: () => Promise<T>, description: string, timeout = 30000): Promise<T> {
    const deadline = Date.now() + timeout;
    let observation: unknown;
    while (Date.now() < deadline) {
        try {
            const result = await probe();
            if (result) return result;
        } catch (error) { observation = error; }
        await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`Timed out waiting for ${description}: ${String(observation)}`);
}

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => {
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(force); done(); });
        child.kill("SIGTERM");
    });
}

describeV2("adapter against an isolated real HashNET V2 validator network", () => {
    const children: ChildProcess[] = [];
    const servers: Server[] = [];
    const logFiles: number[] = [];
    const originalEnv = new Map<string, string | undefined>();
    let root: string;
    let rpcUrl: string;
    let adapterUrl: string;
    let notifications: DomeEvent[];
    let callbackUrl: string;
    let contractAddress: string;
    let senderEthereumAddress: string;
    let notifier: typeof import("../src/subscriber/notifier");
    let EventPuller: typeof import("../src/subscriber/puller").EventPuller;

    beforeAll(async () => {
        const binDir = resolve(process.env.HASHNET_V2_BIN_DIR!);
        const binaries = {
            node: join(binDir, "src/hashnet-node"),
            snapshot: join(binDir, "src/hashnet-snapshot"),
            fixtures: join(binDir, "tests/hashnet-test-fixtures")
        };
        for (const binary of Object.values(binaries)) {
            if (!existsSync(binary)) throw new Error(`Missing V2 binary: ${binary}`);
        }
        root = mkdtempSync(join(tmpdir(), "dome-adapter-v2-"));
        console.log(`Local HashNET V2 regression artifacts: ${root}`);
        const accounts = JSON.parse(execFileSync(binaries.fixtures, ["accounts"], {encoding: "utf8", timeout: 15000}));
        senderEthereumAddress = accounts[0].address;
        const validators = accounts.slice(0, 4).map((account: any, id: number) => ({id, public_key: account.public_key, stake: 1}));
        const config = JSON.parse(readFileSync(join(__dirname, "fixtures/v2-network-config.json"), "utf8"));
        config.validators = validators;
        writeFileSync(join(root, "network.json"), JSON.stringify(config));
        const balance = "1000000000000000000";
        const stateAccounts = accounts.map((account: any) => ({address: account.address, balance, nonce: 0}));
        // This is the mainnet runtime, preloaded only into disposable local genesis.
        // Its Ownable slot 0 is assigned to fixture key 1. Index slot 1 starts at zero.
        stateAccounts.push({address: domeFixture.source.address, balance: "0", nonce: 1,
            code: domeFixture.bytecode,
            storage: { ["0x" + "00".repeat(32)]: "0x" + accounts[0].address.slice(2).padStart(64, "0") }});
        writeFileSync(join(root, "state.json"), JSON.stringify({
            format: "tolar-v1-state-v1", chain_id: 1,
            source: {height: 0, timestamp: Math.floor(Date.now() / 1000) - 10,
                block_hash: "0x" + "aa".repeat(32), state_root: "0x" + "bb".repeat(32)},
            expected_total_supply: "20000000000000000000", accounts: stateAccounts
        }));
        execFileSync(binaries.snapshot, ["build", join(root, "state.json"), join(root, "genesis.hns")], {timeout: 15000, stdio: "pipe"});

        // Hold all four ephemeral ports until immediately before their respective binds.
        const reservations = Array.from({length: 4}, () => createServer());
        const urls = await Promise.all(reservations.map(listen));
        try {
            for (let id = 0; id < 4; id++) {
                writeFileSync(join(root, `validator-${id}.json`), JSON.stringify({
                    network_id: 1, validator_id: id, private_key: accounts[id].private_key,
                    validators, peers: urls.filter((_, peer) => peer !== id), event_interval_ms: 150,
                    consensus_checkpoint_interval_rounds: 4, consensus_event_retention_rounds: 64
                }));
                await new Promise<void>(done => reservations[id].close(() => done()));
                const log = openSync(join(root, `node-${id}.log`), "w");
                logFiles.push(log);
                children.push(spawn(binaries.node, [
                    "--data-dir", join(root, `data-${id}`), "--genesis", join(root, "genesis.hns"),
                    "--network-config", join(root, "network.json"), "--validator-config", join(root, `validator-${id}.json`),
                    "--rpc-address", "127.0.0.1", "--rpc-port", new URL(urls[id]).port,
                    "--rpc-workers", "4", "--rpc-execution-workers", "2"
                ], {stdio: ["ignore", log, log]}));
            }
        } finally {
            for (const reservation of reservations) if (reservation.listening) await new Promise<void>(done => reservation.close(() => done()));
        }
        rpcUrl = `${urls[0]}/jsonrpc`;
        for (const url of urls) await eventually(async () => (await rpc(`${url}/jsonrpc`, "eth_chainId")) === "0x1", "local validator readiness");
        expect(await rpc(rpcUrl, "eth_getCode", [domeFixture.source.address, "latest"])).toBe(domeFixture.bytecode);

        contractAddress = converters.toTolHexAddress(domeFixture.source.address);
        const env = {
            RPC_ADDRESS: rpcUrl, PRIVATE_KEY: accounts[0].private_key,
            DOME_EVENTS_CONTRACT_ADDRESS: contractAddress,
            DOME_EVENTS_CONTRACT_ABI: JSON.stringify(domeFixture.abi),
            DOME_PRODUCTION_BLOCK_NUMBER: "1", ISS: publisher
        };
        for (const [key, value] of Object.entries(env)) {
            originalEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        // Import the real route/pull/notifier without server.ts's fixed port or scheduler.
        const router = require("../src/routes/routes");
        notifier = require("../src/subscriber/notifier");
        EventPuller = require("../src/subscriber/puller").EventPuller;
        const app = express();
        app.use(express.json());
        app.use(router);
        const adapter = createServer(app);
        servers.push(adapter);
        adapterUrl = await listen(adapter);
        notifications = [];
        const callback = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(Buffer.from(chunk)));
            req.on("end", () => {
                notifications.push(JSON.parse(Buffer.concat(chunks).toString()));
                res.writeHead(204).end();
            });
        });
        servers.push(callback);
        callbackUrl = await listen(callback);
    }, 90000);

    afterAll(async () => {
        await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
        await Promise.all(children.map(stop));
        for (const fd of logFiles) closeSync(fd);
        for (const [key, value] of originalEnv) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        if (root) writeFileSync(join(root, "cleanup.json"), JSON.stringify(children.map(child => ({pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode}))));
    }, 15000);

    it("signs, executes and returns an event with its entity, publisher, metadata and local notification intact", async () => {
        expect(await http(`${adapterUrl}/health`)).toMatchObject({status: 200, body: {status: "UP"}});
        expect(await http(`${adapterUrl}/api/v1/subscribe`, {eventTypes: ["ProductOffering"], notificationEndpoint: callbackUrl})).toEqual({status: 201, body: "OK"});
        const started = Date.now();
        const published = await http(`${adapterUrl}/api/v1/publishEvent`, {
            eventType: "ProductOffering", dataLocation: "https://example.test/local-v2/entity",
            relevantMetadata: ["region:EU", "regression:real-v2"], iss: publisher,
            entityId: entity, previousEntityHash: previous
        }, 60000);
        expect(published.status).toBe(201);
        expect(typeof published.body).toBe("string");
        expect(new Date(published.body).toISOString()).toBe(published.body);
        expect(Date.parse(published.body)).toBeGreaterThanOrEqual(started - 1000);
        expect(Date.parse(published.body)).toBeLessThanOrEqual(Date.now() + 1000);

        const queried = await http(`${adapterUrl}/api/v1/events?startDate=${started - 1000}&endDate=${Date.now() + 1000}`);
        expect(queried.status).toBe(200);
        expect(queried.body).toHaveLength(1);
        expect(queried.body[0]).toMatchObject({
            id: 0, publisherAddress: publisher, entityIDHash: entity, previousEntityHash: previous,
            eventType: "ProductOffering", dataLocation: "https://example.test/local-v2/entity",
            relevantMetadata: ["region:EU", "regression:real-v2"]
        });
        expect(queried.body[0].timestamp).toBeGreaterThanOrEqual(started - 1000);
        expect(queried.body[0].timestamp).toBeLessThanOrEqual(Date.now() + 1000);

        const puller = new EventPuller(rpcUrl, contractAddress, eventAbi, 1);
        const events = await eventually(async () => {
            const page = await puller.pull();
            return page.length ? page : undefined;
        }, "real legacy event RPC to expose the committed event");
        expect(events).toEqual(queried.body);
        await notifier.notify(events!);
        await eventually(async () => notifications.length === 1, "loopback notification delivery");
        expect(notifications).toEqual(queried.body);
        expect(await puller.pull()).toEqual([]);
        expect(notifications).toHaveLength(1);
    }, 90000);

    it("rejects a seven-argument ABI against the six-argument runtime before consuming a nonce", async () => {
        const incompatibleAbi = domeFixture.abi.map((fragment: any) => ({
            ...fragment,
            inputs: fragment.type === "function"
                ? [fragment.inputs[0], {name: "_authorAdress", type: "address"}, ...fragment.inputs.slice(1)]
                : [...fragment.inputs.slice(0, 3), {name: "authorAddress", type: "address", indexed: false}, ...fragment.inputs.slice(3)]
        }));
        const beforeNonce = await rpc(rpcUrl, "eth_getTransactionCount", [senderEthereumAddress, "latest"]);
        const configuredAbi = process.env.DOME_EVENTS_CONTRACT_ABI;
        try {
            process.env.DOME_EVENTS_CONTRACT_ABI = JSON.stringify(incompatibleAbi);
            let publish: typeof import("../src/api/DLTInterface").publishDOMEEvent;
            // Each configuration gets its own real contract singleton; no methods are mocked.
            jest.isolateModules(() => { publish = require("../src/api/DLTInterface").publishDOMEEvent; });
            await expect(publish!("ProductOffering", "https://example.test/must-not-publish", ["mismatch"],
                publisher, entity, previous, rpcUrl)).rejects.toThrow(/contract|preflight|revert|execution/i);
        } finally {
            process.env.DOME_EVENTS_CONTRACT_ABI = configuredAbi;
        }
        expect(await rpc(rpcUrl, "eth_getTransactionCount", [senderEthereumAddress, "latest"])).toBe(beforeNonce);
    }, 60000);
});
