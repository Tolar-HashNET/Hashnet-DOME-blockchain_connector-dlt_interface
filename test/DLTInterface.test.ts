import express from "express";
import { Server } from "http";
import { AddressInfo } from "net";
import { Web3 } from "web3";
import { proto } from "@tolar/web3-plugin-tolar";
import {legacyAbi, authorAbi, contract, issuer, entity, previous, testKey} from "./fixtures/publish-config";

const request = require("supertest");
const hash = "0x" + "ab".repeat(32);
const web3 = new Web3();
const savedEnv = {...process.env};
let server: Server, rpc: string, app: express.Express;
interface SubmittedTx {networkId: number; gasPrice: bigint; nonce: bigint; data: string;}
let signed: SubmittedTx[] = [], calls: string[] = [];
let confirmedNonce = 4, pendingReads = 0;
let acceptedNonces = new Set<number>();
let estimate = "120000", simulationReverts = false, txReverts = false;
let timestamp = 1792535919;

beforeAll(async () => {
  const chain = express().use(express.json());
  chain.post("/", (req, res) => {
    const {id, method, params} = req.body;
    calls.push(method);
    let result: unknown;
    switch (method) {
      case "eth_chainId": result = "0x1"; break;
      case "eth_gasPrice": result = "0x7"; break;
      case "eth_getBlockByNumber": result = {gasLimit: "0x989680", timestamp: "0x6ad7ed6f", number: "0x17c9"}; break;
      case "tol_getGasEstimate": result = estimate; break;
      case "tol_tryCallTransaction": result = {excepted: simulationReverts, output: simulationReverts ? "526576657274496e737472756374696f6e" : "00".repeat(31) + "01"}; break;
      case "tol_getNonce": result = confirmedNonce.toString(); break;
      case "tol_getPastEvents": {
        const event = legacyAbi[1] as any;
        result = {past_events: [{address: contract.slice(2), topic: web3.eth.abi.encodeEventSignature(event).slice(2),
          topic_arg_0: issuer.slice(2), topic_arg_1: entity.slice(2), topic_arg_2: previous.slice(2),
          data: web3.eth.abi.encodeParameters(event.inputs.filter((input: any) => !input.indexed), ["42", "1792535919", "ProductUpdated", "https://test_marketplace/test?hl=0xabc123", ["sbx"]]).slice(2),
          block_index: 2980959, transaction_hash: hash.slice(2), block_hash: hash.slice(2)}]};
        break;
      }
      case "tx_sendSignedTransaction": {
        const body = proto.SignedTransaction.fromBinary(web3.utils.hexToBytes("0x" + params[0])).body!;
        const uint = (bytes: Uint8Array) => BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
        const nonce = Number(uint(body.nonce));
        if (acceptedNonces.has(nonce)) {res.json({jsonrpc: "2.0", id, error: {code: -32000, message: "transaction already pending"}}); return;}
        acceptedNonces.add(nonce);
        signed.push({networkId: Number(body.networkId), gasPrice: uint(body.gasPrice), nonce: uint(body.nonce), data: web3.utils.bytesToHex(body.data)});
        result = hash.slice(2); break;
      }
      case "tol_getTransaction":
        if (pendingReads-- > 0) {result = {}; break;}
        confirmedNonce = Number(signed[signed.length - 1].nonce) + 1;
        result = {
        transaction_hash: hash.slice(2), block_hash: hash.slice(2), transaction_index: 0,
        sender_address: "54" + "11".repeat(24), receiver_address: contract.slice(2),
        value: "0", gas: estimate, gas_price: "7", data: "", nonce: "4", network_id: 1,
        confirmation_timestamp: timestamp, gas_used: "100000", gas_refunded: "20000",
        new_address: "", output: "", excepted: txReverts, exception: txReverts ? 1 : 0
      }; break;
      default: res.json({jsonrpc: "2.0", id, error: {code: -32601, message: "Unexpected RPC: " + method}}); return;
    }
    res.json({jsonrpc: "2.0", id, result});
  });
  server = await new Promise<Server>(resolve => {const s = chain.listen(0, "127.0.0.1", () => resolve(s));});
  rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  process.env = {...savedEnv, PRIVATE_KEY: testKey, RPC_ADDRESS: rpc, ISS: issuer,
    DOME_EVENTS_CONTRACT_ADDRESS: contract, DOME_EVENTS_CONTRACT_ABI: JSON.stringify(legacyAbi), DOME_PRODUCTION_BLOCK_NUMBER: "0"};
  signed = []; calls = []; estimate = "120000"; simulationReverts = false; txReverts = false; timestamp = 1792535919;
  confirmedNonce = 4; pendingReads = 0; acceptedNonces = new Set();
  jest.resetModules();
  app = express().use(express.json()).use(require("../src/routes/routes"));
});
afterAll(async () => {process.env = savedEnv; await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));});
const body = () => ({eventType: "ProductUpdated", dataLocation: "https://test_marketplace/test?hl=0xabc123",
  entityId: entity, previousEntityHash: previous, relevantMetadata: ["sbx"]});

test("QA health and subscription retain documented response bodies and statuses", async () => {
  expect((await request(app).get("/health")).body).toEqual({status: "UP", checks: [{name: "DLT Adapter health check", status: "UP"}]});
  const response = await request(app).post("/api/v1/subscribe").send({eventTypes: ["ProductAdded", "ProductUpdated"], notificationEndpoint: "http://127.0.0.1:8916/adapter_listener"});
  expect(response.status).toBe(201); expect(response.text).toBe("OK");
});
test("signed publish uses RPC chain ID, current gas price, nonce and unchanged entity hash", async () => {
  const response = await request(app).post("/api/v1/publishEvent").send(body());
  expect(response.status).toBe(201);
  expect(response.body).toBe("2026-10-20T22:38:39.000Z");
  expect(signed).toHaveLength(1);
  const tx = signed[0];
  expect(tx.networkId).toBe(1); expect(tx.gasPrice.toString()).toBe("7"); expect(tx.nonce.toString()).toBe("4");
  const args = web3.eth.abi.decodeParameters((legacyAbi[0] as any).inputs, "0x" + tx.data.slice(10));
  expect(args[0]).toBe(issuer); expect(args[1]).toBe(entity); expect(args[2]).toBe(previous); expect(args[5]).toEqual(["sbx"]);
  expect(calls).toContain("tol_tryCallTransaction");
});
test("seven-argument contract ABI receives the signing account's EVM author address", async () => {
  process.env.DOME_EVENTS_CONTRACT_ABI = JSON.stringify(authorAbi);
  const response = await request(app).post("/api/v1/publishEvent").send(body());
  expect(response.status).toBe(201); expect(signed).toHaveLength(1);
  const args = web3.eth.abi.decodeParameters((authorAbi[0] as any).inputs, "0x" + signed[0].data.slice(10));
  expect((args[1] as string).toLowerCase()).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"); expect(args[2]).toBe(entity);
});
test("legacy millisecond confirmation timestamp remains supported", async () => {
  timestamp = 1792535919000;
  const response = await request(app).post("/api/v1/publishEvent").send(body());
  expect(response.status).toBe(201); expect(response.body).toBe("2026-10-20T22:38:39.000Z");
});
test("reverting preflight does not broadcast or spend fees", async () => {
  simulationReverts = true;
  expect((await request(app).post("/api/v1/publishEvent").send(body())).status).toBe(400); expect(signed).toHaveLength(0);
});
test("zero gas estimate is rejected before signing", async () => {
  estimate = "0";
  expect((await request(app).post("/api/v1/publishEvent").send(body())).status).toBe(400); expect(signed).toHaveLength(0);
});
test("reverted confirmed transaction cannot be reported as published", async () => {
  txReverts = true;
  expect((await request(app).post("/api/v1/publishEvent").send(body())).status).toBe(400);
});
test("pending empty V2 transaction response is retried until confirmation", async () => {
  pendingReads = 1;
  const response = await request(app).post("/api/v1/publishEvent").send(body());
  expect(response.status).toBe(201);
  expect(response.body).toBe("2026-10-20T22:38:39.000Z");
  expect(calls.filter(method => method === "tol_getTransaction")).toHaveLength(2);
  expect(signed).toHaveLength(1);
}, 10000);
test("simultaneous publications use distinct confirmed nonces", async () => {
  const responses = await Promise.all([request(app).post("/api/v1/publishEvent").send(body()), request(app).post("/api/v1/publishEvent").send(body())]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  expect(signed.map(tx => tx.nonce.toString())).toEqual(["4", "5"]);
});
test("QA date retrieval includes matching V2 events and does not scan three million empty blocks", async () => {
  const response = await request(app).get("/api/v1/events").query({startDate: "0", endDate: "1792535920000"});
  expect(response.status).toBe(200);
  expect(response.body).toEqual([{id: 42, publisherAddress: issuer, entityIDHash: entity, previousEntityHash: previous,
    eventType: "ProductUpdated", timestamp: 1792535919000, dataLocation: "https://test_marketplace/test?hl=0xabc123", relevantMetadata: ["sbx"]}]);
  expect(calls).toEqual(["tol_getPastEvents"]);
});
test.each(["eventType", "dataLocation", "entityId", "previousEntityHash", "relevantMetadata"])("invalid publish %s is rejected before RPC", async key => {
  const invalid: any = body(); invalid[key] = null;
  expect((await request(app).post("/api/v1/publishEvent").send(invalid)).status).toBe(400); expect(calls).toHaveLength(0);
});
test.each([undefined, "", "not-a-number", "-1", "1.5"])("invalid date %p is rejected before RPC", async startDate => {
  expect((await request(app).get("/api/v1/events").query({startDate, endDate: "1792535919000"})).status).toBe(400); expect(calls).toHaveLength(0);
});
test.each([null, "ProductUpdated", [], [""]])("invalid eventTypes %p rejected", async eventTypes => {
  expect((await request(app).post("/api/v1/subscribe").send({eventTypes, notificationEndpoint: "http://127.0.0.1:8916/adapter_listener"})).status).toBe(400);
});
test.each(["", "not-a-url", "file:///tmp/listener"])("invalid notification URL %p rejected", async notificationEndpoint => {
  expect((await request(app).post("/api/v1/subscribe").send({eventTypes: ["ProductUpdated"], notificationEndpoint})).status).toBe(400);
});
