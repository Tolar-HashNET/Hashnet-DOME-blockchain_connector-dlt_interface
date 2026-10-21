import { ContractAbi } from "web3";

// Public ABI shapes: the existing mainnet contract and the supplied Helm values.
export const legacyAbi: ContractAbi = [
  { type: "function", name: "emitNewEvent", stateMutability: "nonpayable", outputs: [{type: "bool", name: ""}], inputs: [
    {name: "_publisherAddress", type: "bytes32"}, {name: "_entityIDHash", type: "bytes32"},
    {name: "_previousEntityHash", type: "bytes32"}, {name: "_eventType", type: "string"},
    {name: "_dataLocation", type: "string"}, {name: "_metadata", type: "string[]"}
  ]},
  { type: "event", name: "EventDOMEv1", anonymous: false, inputs: [
    {name: "index", type: "uint256", indexed: false}, {name: "timestamp", type: "uint256", indexed: false},
    {name: "publisherAddress", type: "bytes32", indexed: true}, {name: "entityIDHash", type: "bytes32", indexed: true},
    {name: "previousEntityHash", type: "bytes32", indexed: true}, {name: "eventType", type: "string", indexed: false},
    {name: "dataLocation", type: "string", indexed: false}, {name: "metadata", type: "string[]", indexed: false}
  ]}
];
export const authorAbi: ContractAbi = JSON.parse(JSON.stringify(legacyAbi));
(authorAbi[0] as any).inputs.splice(1, 0, {name: "_authorAdress", type: "address"});
(authorAbi[1] as any).inputs.splice(3, 0, {name: "authorAddress", type: "address", indexed: false});
export const contract = "0x544b1194f23bd9dd4f9f1a4d0e24a2ec86bbe3ca5ae079c9a6";
export const issuer = "0x43b27fef24cfe8a0b797ed8a36de2884f9963c0c2a0da640e3ec7ad6cd0c493d";
export const entity = "0x" + "ab".repeat(32);
export const previous = "0x" + "00".repeat(32);
// Disposable public test key, not a deployment credential.
export const testKey = "0x" + "0".repeat(63) + "1";
