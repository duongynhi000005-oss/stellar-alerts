import { describe, it, expect } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  CallGraphTracer,
  callGraphTracer,
  decodeContractAddress,
  decodeFunctionName,
  decodeArguments,
} from '../call-graph-tracer';

const CONTRACT_A = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const CONTRACT_B = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const CONTRACT_C = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3';

function makeScValAddress(strkey: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(strkey).toScVal();
}

function makeDiagnosticEventXdr(
  inSuccess: boolean,
  contractStrkey: string | null,
  topics: StellarSdk.xdr.ScVal[],
  data: StellarSdk.xdr.ScVal = StellarSdk.xdr.ScVal.scvVoid(),
): string {
  const hash = contractStrkey
    ? StellarSdk.Address.fromString(contractStrkey).toBuffer()
    : null;

  const event = new StellarSdk.xdr.DiagnosticEvent({
    inSuccessfulContractCall: inSuccess,
    event: new StellarSdk.xdr.ContractEvent({
      ext: new (StellarSdk.xdr.ExtensionPoint as any)(0),
      contractId: hash,
      type: StellarSdk.xdr.ContractEventType.diagnostic(),
      body: new (StellarSdk.xdr.ContractEventBody as any)(
        0,
        new StellarSdk.xdr.ContractEventV0({
          topics,
          data,
        }),
      ),
    }),
  });

  return event.toXDR('base64');
}

describe('CallGraphTracer: Decoding Helpers', () => {
  it('decodes contract addresses from strkeys, Buffers, and ScVals', () => {
    expect(decodeContractAddress(CONTRACT_A)).toBe(CONTRACT_A);

    const scv = makeScValAddress(CONTRACT_A);
    expect(decodeContractAddress(scv)).toBe(CONTRACT_A);

    const b64 = scv.toXDR('base64');
    expect(decodeContractAddress(b64)).toBe(CONTRACT_A);

    const rawHash = Buffer.alloc(32, 1);
    const expectedStrkey = StellarSdk.Address.contract(rawHash).toString();
    expect(decodeContractAddress(rawHash)).toBe(expectedStrkey);

    expect(decodeContractAddress(null)).toBeNull();
  });

  it('decodes function names from symbols and plain strings', () => {
    expect(decodeFunctionName('swap')).toBe('swap');

    const scv = StellarSdk.xdr.ScVal.scvSymbol('transfer');
    expect(decodeFunctionName(scv)).toBe('transfer');
    expect(decodeFunctionName(scv.toXDR('base64'))).toBe('transfer');

    expect(decodeFunctionName({ symbol: 'mint' })).toBe('mint');
    expect(decodeFunctionName(null)).toBeNull();
  });

  it('decodes arguments from ScVal vec, arrays, and primitives', () => {
    expect(decodeArguments(null)).toEqual([]);

    const vec = [
      StellarSdk.xdr.ScVal.scvU32(100),
      StellarSdk.xdr.ScVal.scvString('USDC'),
    ];
    const decoded = decodeArguments(vec);
    expect(decoded).toEqual([100, 'USDC']);
  });
});

describe('CallGraphTracer: Diagnostic Event Traversal', () => {
  it('traces a direct single-hop contract call', () => {
    const events = [
      {
        topic: ['fn_call', CONTRACT_A, 'get_pool_reserves'],
        value: [10],
      },
      {
        topic: ['fn_return', 'get_pool_reserves'],
        value: { reserve_a: 5000, reserve_b: 10000 },
      },
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    expect(summary.totalCalls).toBe(1);
    expect(summary.maxDepth).toBe(0);
    expect(summary.uniqueContracts).toEqual([CONTRACT_A]);
    expect(summary.hasCycle).toBe(false);

    const root = summary.rootNodes[0];
    expect(root.contractId).toBe(CONTRACT_A);
    expect(root.functionName).toBe('get_pool_reserves');
    expect(root.args).toEqual([10]);
    expect(root.returnValue).toEqual({ reserve_a: 5000, reserve_b: 10000 });
    expect(root.status).toBe('SUCCESS');
    expect(root.children).toHaveLength(0);
  });

  it('reconstructs a nested 3-tier sub-invocation call graph (A -> B -> C)', () => {
    const events = [
      // 1. Root call: CONTRACT_A.swap()
      {
        topic: ['fn_call', CONTRACT_A, 'swap'],
        value: ['USDC', 'XLM', 1000],
      },
      // 2. Child call: CONTRACT_A invokes CONTRACT_B.quote()
      {
        topic: ['fn_call', CONTRACT_B, 'quote'],
        value: [1000],
      },
      // 3. Grandchild call: CONTRACT_B invokes CONTRACT_C.get_rate()
      {
        topic: ['fn_call', CONTRACT_C, 'get_rate'],
        value: [],
      },
      // 4. Return Grandchild
      {
        topic: ['fn_return', 'get_rate'],
        value: 125,
      },
      // 5. Return Child
      {
        topic: ['fn_return', 'quote'],
        value: 125000,
      },
      // 6. Return Root
      {
        topic: ['fn_return', 'swap'],
        value: { received: 125000 },
      },
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    expect(summary.totalCalls).toBe(3);
    expect(summary.maxDepth).toBe(2);
    expect(summary.uniqueContracts).toHaveLength(3);
    expect(summary.uniqueContracts).toContain(CONTRACT_A);
    expect(summary.uniqueContracts).toContain(CONTRACT_B);
    expect(summary.uniqueContracts).toContain(CONTRACT_C);
    expect(summary.hasCycle).toBe(false);

    // Assert Root Node
    expect(summary.rootNodes).toHaveLength(1);
    const root = summary.rootNodes[0];
    expect(root.contractId).toBe(CONTRACT_A);
    expect(root.depth).toBe(0);
    expect(root.callerAddress).toBeUndefined();
    expect(root.children).toHaveLength(1);

    // Assert Child Node
    const child = root.children[0];
    expect(child.contractId).toBe(CONTRACT_B);
    expect(child.callerAddress).toBe(CONTRACT_A);
    expect(child.depth).toBe(1);
    expect(child.children).toHaveLength(1);

    // Assert Grandchild Node
    const grandchild = child.children[0];
    expect(grandchild.contractId).toBe(CONTRACT_C);
    expect(grandchild.callerAddress).toBe(CONTRACT_B);
    expect(grandchild.depth).toBe(2);
    expect(grandchild.returnValue).toBe(125);
    expect(grandchild.children).toHaveLength(0);
  });

  it('reconstructs a multi-branch call tree (A calls B and then calls C sequentially)', () => {
    const events = [
      {
        topic: ['fn_call', CONTRACT_A, 'execute_batch'],
        value: [],
      },
      // Branch 1: call CONTRACT_B
      {
        topic: ['fn_call', CONTRACT_B, 'step_one'],
        value: [],
      },
      {
        topic: ['fn_return', 'step_one'],
        value: 'ok',
      },
      // Branch 2: call CONTRACT_C
      {
        topic: ['fn_call', CONTRACT_C, 'step_two'],
        value: [],
      },
      {
        topic: ['fn_return', 'step_two'],
        value: 'completed',
      },
      // Return Root
      {
        topic: ['fn_return', 'execute_batch'],
        value: true,
      },
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    expect(summary.totalCalls).toBe(3);
    expect(summary.maxDepth).toBe(1);

    const root = summary.rootNodes[0];
    expect(root.children).toHaveLength(2);
    expect(root.children[0].contractId).toBe(CONTRACT_B);
    expect(root.children[1].contractId).toBe(CONTRACT_C);
  });

  it('parses base64-XDR encoded DiagnosticEvent instances', () => {
    const b64CallA = makeDiagnosticEventXdr(true, CONTRACT_A, [
      StellarSdk.xdr.ScVal.scvSymbol('fn_call'),
      makeScValAddress(CONTRACT_A),
      StellarSdk.xdr.ScVal.scvSymbol('init'),
    ]);

    const b64CallB = makeDiagnosticEventXdr(true, CONTRACT_A, [
      StellarSdk.xdr.ScVal.scvSymbol('fn_call'),
      makeScValAddress(CONTRACT_B),
      StellarSdk.xdr.ScVal.scvSymbol('deposit'),
    ]);

    const b64ReturnB = makeDiagnosticEventXdr(true, CONTRACT_B, [
      StellarSdk.xdr.ScVal.scvSymbol('fn_return'),
      StellarSdk.xdr.ScVal.scvSymbol('deposit'),
    ]);

    const b64ReturnA = makeDiagnosticEventXdr(true, CONTRACT_A, [
      StellarSdk.xdr.ScVal.scvSymbol('fn_return'),
      StellarSdk.xdr.ScVal.scvSymbol('init'),
    ]);

    const summary = callGraphTracer.traceDiagnosticEvents([
      b64CallA,
      b64CallB,
      b64ReturnB,
      b64ReturnA,
    ]);

    expect(summary.totalCalls).toBe(2);
    expect(summary.rootNodes).toHaveLength(1);
    expect(summary.rootNodes[0].contractId).toBe(CONTRACT_A);
    expect(summary.rootNodes[0].children[0].contractId).toBe(CONTRACT_B);
  });

  it('detects circular reentrancy loops (A -> B -> A)', () => {
    const events = [
      {
        topic: ['fn_call', CONTRACT_A, 'flash_borrow'],
        value: [],
      },
      {
        topic: ['fn_call', CONTRACT_B, 'callback'],
        value: [],
      },
      // Reentrant call back into CONTRACT_A
      {
        topic: ['fn_call', CONTRACT_A, 'withdraw'],
        value: [],
      },
      {
        topic: ['fn_return', 'withdraw'],
        value: 'reentered',
      },
      {
        topic: ['fn_return', 'callback'],
        value: 'done',
      },
      {
        topic: ['fn_return', 'flash_borrow'],
        value: 'finished',
      },
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    expect(summary.hasCycle).toBe(true);
    expect(summary.detectedCycles).toHaveLength(1);
    expect(summary.detectedCycles[0]).toEqual([CONTRACT_A, CONTRACT_B, CONTRACT_A]);
  });

  it('enforces maxDepth limit safeguard without throwing', () => {
    const tracer = new CallGraphTracer({ maxDepth: 2 });
    const events = [
      { topic: ['fn_call', CONTRACT_A, 'l0'], value: [] },
      { topic: ['fn_call', CONTRACT_B, 'l1'], value: [] },
      { topic: ['fn_call', CONTRACT_C, 'l2'], value: [] },
      { topic: ['fn_call', CONTRACT_A, 'l3_exceeds'], value: [] },
      { topic: ['fn_return', 'l3_exceeds'] },
      { topic: ['fn_return', 'l2'] },
      { topic: ['fn_return', 'l1'] },
      { topic: ['fn_return', 'l0'] },
    ];

    const summary = tracer.traceDiagnosticEvents(events);
    expect(summary.maxDepth).toBe(2);
    // Tree was capped at depth 2
    expect(summary.totalCalls).toBe(4);
  });

  it('handles malformed XDR and unclosed calls gracefully', () => {
    const events = [
      '%%%corrupt_base64_string%%%',
      null,
      {},
      { topic: [] },
      { topic: ['fn_call', CONTRACT_A, 'orphan_call'], value: [42] },
      // No fn_return provided (simulating truncated event log)
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    expect(summary.totalCalls).toBe(1);
    expect(summary.rootNodes).toHaveLength(1);
    expect(summary.rootNodes[0].functionName).toBe('orphan_call');
    expect(summary.rootNodes[0].status).toBe('SUCCESS');
  });
});

describe('CallGraphTracer: InvocationTree and Simulation Envelopes', () => {
  it('traverses direct InvocationTreeInput objects with gas attribution', () => {
    const tree = {
      contractId: CONTRACT_A,
      functionName: 'execute',
      cpuInstructions: 10000n,
      memoryBytes: 2048n,
      subInvocations: [
        {
          contractId: CONTRACT_B,
          functionName: 'transfer',
          cpuInstructions: 3000n,
          memoryBytes: 512n,
        },
      ],
    };

    const summary = callGraphTracer.traceInvocationTree(tree);
    expect(summary.totalCalls).toBe(2);
    expect(summary.uniqueContracts).toEqual([CONTRACT_A, CONTRACT_B]);
    expect(summary.totalCpuInstructions).toBe(13000n);
    expect(summary.totalMemoryBytes).toBe(2560n);
    expect(summary.flatTrace).toHaveLength(2);
    expect(summary.flatTrace[0]).toContain('[0]');
    expect(summary.flatTrace[1]).toContain('[1]');
  });

  it('parses simulateTransaction response envelopes', () => {
    const simulation = {
      cost: {
        cpuInsns: '50000',
        memBytes: '8192',
      },
      events: [
        {
          topic: ['fn_call', CONTRACT_A, 'simulate_swap'],
          value: [],
        },
        {
          topic: ['fn_return', 'simulate_swap'],
          value: 100,
        },
      ],
    };

    const summary = callGraphTracer.traceSimulation(simulation);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totalCpuInstructions).toBe(50000n);
    expect(summary.totalMemoryBytes).toBe(8192n);
  });

  it('builds structured alert metadata for developer notification dispatch', () => {
    const events = [
      {
        topic: ['fn_call', CONTRACT_A, 'distribute_rewards'],
        value: [1000],
      },
      {
        topic: ['fn_call', CONTRACT_B, 'mint'],
        value: [50],
      },
      {
        topic: ['fn_return', 'mint'],
        value: true,
      },
      {
        topic: ['fn_return', 'distribute_rewards'],
        value: true,
      },
    ];

    const summary = callGraphTracer.traceDiagnosticEvents(events);
    const meta = callGraphTracer.buildAlertMetadata(summary);

    expect(meta.totalInvocations).toBe(2);
    expect(meta.maxCallDepth).toBe(1);
    expect(meta.hasReentrancyCycle).toBe(false);
    expect(Array.isArray(meta.flatExecutionTrace)).toBe(true);
    expect(Array.isArray(meta.rootCalls)).toBe(true);
    expect((meta.rootCalls as any[])[0].subCalls).toHaveLength(1);
  });
});
