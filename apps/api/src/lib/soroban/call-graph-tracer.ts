import * as StellarSdk from 'stellar-sdk';

/**
 * Soroban Cross-Contract Invocation Call Graph & Sub-Invocation Tracer (#725).
 *
 * Traverses Soroban diagnostic event streams, simulation results, and nested
 * invocation trees to reconstruct hierarchical parent-child call graphs with
 * gas/CPU instruction and memory attribution per sub-contract, cycle detection,
 * and maxDepth recursion protection.
 */

export interface GasMetrics {
  cpuInstructions: bigint;
  memoryBytes: bigint;
  estimatedGas: bigint;
}

export interface CallGraphNode {
  id: string;
  contractId: string;
  callerAddress?: string;
  functionName: string;
  args: unknown[];
  returnValue?: unknown;
  status: 'SUCCESS' | 'FAILED' | 'REVERTED';
  depth: number;
  gasMetrics: GasMetrics;
  children: CallGraphNode[];
  rawTopics?: string[];
  errorMessage?: string;
}

export interface CallGraphSummary {
  rootNodes: CallGraphNode[];
  totalCalls: number;
  maxDepth: number;
  uniqueContracts: string[];
  totalCpuInstructions: bigint;
  totalMemoryBytes: bigint;
  totalEstimatedGas: bigint;
  hasCycle: boolean;
  detectedCycles: string[][];
  flatTrace: string[];
}

export interface InvocationTreeInput {
  contractId: string;
  functionName?: string;
  callerAddress?: string;
  args?: unknown[];
  returnValue?: unknown;
  status?: 'SUCCESS' | 'FAILED' | 'REVERTED';
  cpuInstructions?: number | bigint;
  memoryBytes?: number | bigint;
  estimatedGas?: number | bigint;
  subInvocations?: InvocationTreeInput[];
  children?: InvocationTreeInput[];
}

export interface TraceOptions {
  /** Maximum recursion depth safeguard to prevent infinite call loops (default: 16). */
  maxDepth?: number;
  /** Baseline CPU instruction cost per contract call if not specified (default: 2,500). */
  defaultCpuPerCall?: bigint;
  /** Baseline memory bytes per contract call if not specified (default: 512). */
  defaultMemPerCall?: bigint;
  /** Total transaction CPU instruction budget to distribute proportionally. */
  totalCpuBudget?: bigint;
  /** Total transaction memory byte budget to distribute proportionally. */
  totalMemBudget?: bigint;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_CPU_PER_CALL = 2500n;
const DEFAULT_MEM_PER_CALL = 512n;

const CALL_START_SYMBOLS = new Set([
  'fn_call',
  'call',
  'invoke',
  'contract_call',
  'sub_call',
]);

const CALL_END_SYMBOLS = new Set([
  'fn_return',
  'return',
  'contract_return',
  'sub_return',
]);

/**
 * Decodes a contract strkey (C...) from an ScVal, Buffer, or string.
 */
export function decodeContractAddress(entry: unknown): string | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (trimmed.startsWith('C') || trimmed.startsWith('G')) {
      return trimmed;
    }
    // Attempt base64 ScVal decode
    if (
      trimmed.length >= 4 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(trimmed, 'base64');
        return decodeContractAddress(scVal);
      } catch {
        // Fall through
      }
    }
  }

  // Buffer or Uint8Array (e.g. 32-byte contract hash)
  if (Buffer.isBuffer(entry) || entry instanceof Uint8Array) {
    if (entry.length === 32) {
      try {
        return StellarSdk.Address.contract(Buffer.from(entry)).toString();
      } catch {
        // Fall through
      }
    }
  }

  if (typeof entry === 'object' && entry !== null) {
    // If it is an xdr.Hash object with a buffer
    if (typeof (entry as any).toXDR === 'function') {
      try {
        const native = StellarSdk.scValToNative(entry as any);
        if (typeof native === 'string' && (native.startsWith('C') || native.startsWith('G'))) {
          return native;
        }
      } catch {
        // Fall through
      }
      try {
        return StellarSdk.Address.fromScVal(entry as any).toString();
      } catch {
        // Fall through
      }
    }

    // Direct object shape e.g. { address: 'C...' } or { contractId: 'C...' }
    const candidate =
      (entry as any).address ??
      (entry as any).contractId ??
      (entry as any).contract_id;
    if (typeof candidate === 'string') {
      return decodeContractAddress(candidate);
    }
  }

  return null;
}

/**
 * Decodes a function name symbol or string from a topic entry.
 */
export function decodeFunctionName(entry: unknown): string | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === 'string') {
    if (
      entry.length >= 4 &&
      entry.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(entry)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(entry, 'base64');
        return decodeFunctionName(scVal);
      } catch {
        // Fall through
      }
    }
    return entry;
  }

  if (typeof entry === 'object') {
    if (typeof (entry as any).symbol === 'string') {
      return (entry as any).symbol;
    }
    try {
      const native = StellarSdk.scValToNative(entry as any);
      if (typeof native === 'string') return native;
      if (typeof native === 'symbol') return native.description ?? String(native);
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Safely decodes ScVal arguments into JavaScript primitives / objects.
 */
export function decodeArguments(data: unknown): unknown[] {
  if (data === null || data === undefined) return [];

  if (Array.isArray(data)) {
    return data.map((item) => {
      try {
        return StellarSdk.scValToNative(item as any);
      } catch {
        return item;
      }
    });
  }

  if (typeof data === 'string') {
    if (
      data.length >= 4 &&
      data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(data, 'base64');
        return decodeArguments(scVal);
      } catch {
        return [data];
      }
    }
    return [data];
  }

  if (typeof data === 'object') {
    try {
      const native = StellarSdk.scValToNative(data as any);
      if (Array.isArray(native)) return native;
      return [native];
    } catch {
      return [data];
    }
  }

  return [data];
}

interface ParsedEventEnvelope {
  contractId?: string;
  actionSymbol: string;
  targetContract?: string;
  functionName?: string;
  args: unknown[];
  dataPayload?: unknown;
  isSuccess: boolean;
  rawTopics: string[];
}

/**
 * Parses raw diagnostic event inputs into a standardized internal representation.
 */
function normalizeDiagnosticEvent(raw: unknown): ParsedEventEnvelope | null {
  if (!raw) return null;

  let eventObj: any = raw;

  // Case 1: Base64 string of DiagnosticEvent or ContractEvent
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (
      trimmed.length >= 4 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      try {
        eventObj = StellarSdk.xdr.DiagnosticEvent.fromXDR(trimmed, 'base64');
      } catch {
        try {
          eventObj = StellarSdk.xdr.ContractEvent.fromXDR(trimmed, 'base64');
        } catch {
          return null;
        }
      }
    } else {
      return null;
    }
  }

  let isSuccess = true;
  let contractId: string | undefined;
  let rawTopics: unknown[] = [];
  let dataPayload: unknown;

  // Case 2: StellarSdk.xdr.DiagnosticEvent
  if (
    typeof eventObj.inSuccessfulContractCall === 'function' &&
    typeof eventObj.event === 'function'
  ) {
    try {
      isSuccess = Boolean(eventObj.inSuccessfulContractCall());
      const innerEvent = eventObj.event();
      if (innerEvent.contractId && typeof innerEvent.contractId === 'function') {
        const hash = innerEvent.contractId();
        if (hash) {
          contractId = decodeContractAddress(hash) ?? undefined;
        }
      }
      const body = innerEvent.body().v0();
      rawTopics = body.topics() ?? [];
      dataPayload = body.data();
    } catch {
      return null;
    }
  } else if (
    // Case 3: Plain DiagnosticEvent shape or ContractEvent object
    eventObj.event &&
    typeof eventObj.event === 'object'
  ) {
    isSuccess = eventObj.inSuccessfulContractCall ?? true;
    contractId = decodeContractAddress(eventObj.event.contractId) ?? undefined;
    rawTopics = Array.isArray(eventObj.event.topics)
      ? eventObj.event.topics
      : eventObj.event.topic ?? [];
    dataPayload = eventObj.event.data ?? eventObj.event.value;
  } else {
    // Case 4: Plain Soroban RPC event
    contractId = decodeContractAddress(eventObj.contractId) ?? undefined;
    rawTopics = Array.isArray(eventObj.topic)
      ? eventObj.topic
      : Array.isArray(eventObj.topics)
        ? eventObj.topics
        : [];
    dataPayload = eventObj.value ?? eventObj.data;
  }

  if (rawTopics.length === 0) return null;

  const topic0 = decodeFunctionName(rawTopics[0]);
  if (!topic0) return null;

  const actionSymbol = topic0.toLowerCase();
  const rawTopicsStrings = rawTopics.map((t) => decodeFunctionName(t) ?? String(t));

  let targetContract: string | undefined;
  let functionName: string | undefined;
  let args: unknown[] = [];

  if (CALL_START_SYMBOLS.has(actionSymbol)) {
    // Topic convention: [fn_call, targetContract, functionName]
    if (rawTopics.length > 1) {
      targetContract = decodeContractAddress(rawTopics[1]) ?? undefined;
    }
    if (rawTopics.length > 2) {
      functionName = decodeFunctionName(rawTopics[2]) ?? undefined;
    }
    args = decodeArguments(dataPayload);
  } else if (CALL_END_SYMBOLS.has(actionSymbol)) {
    // Topic convention: [fn_return, functionName]
    if (rawTopics.length > 1) {
      functionName = decodeFunctionName(rawTopics[1]) ?? undefined;
    }
  }

  return {
    contractId: contractId ?? targetContract,
    actionSymbol,
    targetContract,
    functionName,
    args,
    dataPayload,
    isSuccess,
    rawTopics: rawTopicsStrings,
  };
}

/**
 * Reconstructs hierarchical invocation trees from Soroban diagnostic events and trees.
 */
export class CallGraphTracer {
  private maxDepth: number;
  private defaultCpuPerCall: bigint;
  private defaultMemPerCall: bigint;

  constructor(options: TraceOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.defaultCpuPerCall = options.defaultCpuPerCall ?? DEFAULT_CPU_PER_CALL;
    this.defaultMemPerCall = options.defaultMemPerCall ?? DEFAULT_MEM_PER_CALL;
  }

  /**
   * Traverses diagnostic events and reconstructs parent-child call trees using stack tracking.
   */
  public traceDiagnosticEvents(
    rawEvents: unknown[],
    options: TraceOptions = {},
  ): CallGraphSummary {
    const maxDepth = options.maxDepth ?? this.maxDepth;
    const rootNodes: CallGraphNode[] = [];
    const callStack: CallGraphNode[] = [];
    const activeContractStack: string[] = [];

    const uniqueContractsSet = new Set<string>();
    const detectedCycles: string[][] = [];
    let callCounter = 0;
    let maxDepthReached = 0;

    let totalCpu = 0n;
    let totalMem = 0n;

    for (const raw of rawEvents) {
      const parsed = normalizeDiagnosticEvent(raw);
      if (!parsed) continue;

      if (CALL_START_SYMBOLS.has(parsed.actionSymbol)) {
        callCounter++;
        const targetContract =
          parsed.targetContract ?? parsed.contractId ?? `C_UNKNOWN_${callCounter}`;
        uniqueContractsSet.add(targetContract);

        const currentDepth = callStack.length;
        if (currentDepth > maxDepthReached) {
          maxDepthReached = currentDepth;
        }

        // Cycle detection: check if targetContract already exists in the active stack
        const cycleIdx = activeContractStack.indexOf(targetContract);
        if (cycleIdx !== -1) {
          const cyclePath = [...activeContractStack.slice(cycleIdx), targetContract];
          detectedCycles.push(cyclePath);
        }

        const callerAddress =
          callStack.length > 0 ? callStack[callStack.length - 1].contractId : undefined;

        // Calculate gas & memory attribution
        const cpuCost = this.defaultCpuPerCall + BigInt(parsed.args.length * 150);
        const memCost = this.defaultMemPerCall + BigInt(parsed.args.length * 64);
        const estimatedGas = cpuCost + (memCost * 2n);

        totalCpu += cpuCost;
        totalMem += memCost;

        const node: CallGraphNode = {
          id: `call_${callCounter}`,
          contractId: targetContract,
          callerAddress,
          functionName: parsed.functionName || 'default',
          args: parsed.args,
          status: parsed.isSuccess ? 'SUCCESS' : 'FAILED',
          depth: currentDepth,
          gasMetrics: {
            cpuInstructions: cpuCost,
            memoryBytes: memCost,
            estimatedGas,
          },
          children: [],
          rawTopics: parsed.rawTopics,
        };

        if (callStack.length > 0) {
          callStack[callStack.length - 1].children.push(node);
        } else {
          rootNodes.push(node);
        }

        if (currentDepth < maxDepth) {
          callStack.push(node);
          activeContractStack.push(targetContract);
        }
      } else if (CALL_END_SYMBOLS.has(parsed.actionSymbol)) {
        if (callStack.length > 0) {
          const finishedNode = callStack.pop()!;
          activeContractStack.pop();

          if (parsed.dataPayload !== undefined) {
            try {
              finishedNode.returnValue = StellarSdk.scValToNative(parsed.dataPayload as any);
            } catch {
              finishedNode.returnValue = parsed.dataPayload;
            }
          }
          if (!parsed.isSuccess) {
            finishedNode.status = 'FAILED';
          }
        }
      }
    }

    // Auto-finalize any unclosed nodes remaining on the stack
    while (callStack.length > 0) {
      callStack.pop();
      activeContractStack.pop();
    }

    const flatTrace = this.buildFlatTrace(rootNodes);

    return {
      rootNodes,
      totalCalls: callCounter,
      maxDepth: maxDepthReached,
      uniqueContracts: Array.from(uniqueContractsSet),
      totalCpuInstructions: totalCpu,
      totalMemoryBytes: totalMem,
      totalEstimatedGas: totalCpu + (totalMem * 2n),
      hasCycle: detectedCycles.length > 0,
      detectedCycles,
      flatTrace,
    };
  }

  /**
   * Traverses a structured invocation tree (e.g. from SorobanAuthorizedInvocation).
   */
  public traceInvocationTree(
    roots: InvocationTreeInput | InvocationTreeInput[],
    options: TraceOptions = {},
  ): CallGraphSummary {
    const rootList = Array.isArray(roots) ? roots : [roots];
    const maxDepthLimit = options.maxDepth ?? this.maxDepth;

    const rootNodes: CallGraphNode[] = [];
    const uniqueContractsSet = new Set<string>();
    const detectedCycles: string[][] = [];
    let callCounter = 0;
    let maxDepthReached = 0;
    let totalCpu = 0n;
    let totalMem = 0n;

    const traverse = (
      input: InvocationTreeInput,
      depth: number,
      callerAddress?: string,
      callPath: string[] = [],
    ): CallGraphNode => {
      callCounter++;
      const contractId = input.contractId;
      uniqueContractsSet.add(contractId);

      if (depth > maxDepthReached) {
        maxDepthReached = depth;
      }

      // Check cycles
      const cycleIdx = callPath.indexOf(contractId);
      if (cycleIdx !== -1) {
        detectedCycles.push([...callPath.slice(cycleIdx), contractId]);
      }

      const cpuCost =
        input.cpuInstructions !== undefined
          ? BigInt(input.cpuInstructions)
          : this.defaultCpuPerCall;
      const memCost =
        input.memoryBytes !== undefined
          ? BigInt(input.memoryBytes)
          : this.defaultMemPerCall;
      const estimatedGas =
        input.estimatedGas !== undefined
          ? BigInt(input.estimatedGas)
          : cpuCost + (memCost * 2n);

      totalCpu += cpuCost;
      totalMem += memCost;

      const node: CallGraphNode = {
        id: `call_${callCounter}`,
        contractId,
        callerAddress,
        functionName: input.functionName || 'default',
        args: input.args || [],
        returnValue: input.returnValue,
        status: input.status || 'SUCCESS',
        depth,
        gasMetrics: {
          cpuInstructions: cpuCost,
          memoryBytes: memCost,
          estimatedGas,
        },
        children: [],
      };

      const children = input.subInvocations || input.children || [];
      if (depth < maxDepthLimit && children.length > 0) {
        const nextCallPath = [...callPath, contractId];
        for (const child of children) {
          node.children.push(traverse(child, depth + 1, contractId, nextCallPath));
        }
      }

      return node;
    };

    for (const r of rootList) {
      rootNodes.push(traverse(r, 0, undefined, []));
    }

    const flatTrace = this.buildFlatTrace(rootNodes);

    return {
      rootNodes,
      totalCalls: callCounter,
      maxDepth: maxDepthReached,
      uniqueContracts: Array.from(uniqueContractsSet),
      totalCpuInstructions: totalCpu,
      totalMemoryBytes: totalMem,
      totalEstimatedGas: totalCpu + (totalMem * 2n),
      hasCycle: detectedCycles.length > 0,
      detectedCycles,
      flatTrace,
    };
  }

  /**
   * Parses Soroban RPC simulateTransaction response envelopes.
   */
  public traceSimulation(simulation: any, options: TraceOptions = {}): CallGraphSummary {
    if (!simulation) {
      return {
        rootNodes: [],
        totalCalls: 0,
        maxDepth: 0,
        uniqueContracts: [],
        totalCpuInstructions: 0n,
        totalMemoryBytes: 0n,
        totalEstimatedGas: 0n,
        hasCycle: false,
        detectedCycles: [],
        flatTrace: [],
      };
    }

    const events = Array.isArray(simulation.events) ? simulation.events : [];
    const summary = this.traceDiagnosticEvents(events, options);

    // If overall simulation cost is provided, adjust summary totals
    if (simulation.cost) {
      if (simulation.cost.cpuInsns) {
        summary.totalCpuInstructions = BigInt(simulation.cost.cpuInsns);
      }
      if (simulation.cost.memBytes) {
        summary.totalMemoryBytes = BigInt(simulation.cost.memBytes);
      }
      summary.totalEstimatedGas =
        summary.totalCpuInstructions + (summary.totalMemoryBytes * 2n);
    }

    return summary;
  }

  /**
   * Formats call graph summary into clean JSON metadata for developer alerts.
   */
  public buildAlertMetadata(summary: CallGraphSummary): Record<string, unknown> {
    return {
      totalInvocations: summary.totalCalls,
      maxCallDepth: summary.maxDepth,
      uniqueContracts: summary.uniqueContracts,
      totalCpuInstructions: summary.totalCpuInstructions.toString(),
      totalMemoryBytes: summary.totalMemoryBytes.toString(),
      totalEstimatedGas: summary.totalEstimatedGas.toString(),
      hasReentrancyCycle: summary.hasCycle,
      detectedCycles: summary.detectedCycles,
      flatExecutionTrace: summary.flatTrace,
      rootCalls: summary.rootNodes.map((r) => this.serializeNodeForAlert(r)),
    };
  }

  private serializeNodeForAlert(node: CallGraphNode): Record<string, unknown> {
    return {
      id: node.id,
      contractId: node.contractId,
      caller: node.callerAddress ?? null,
      functionName: node.functionName,
      status: node.status,
      depth: node.depth,
      gasCost: node.gasMetrics.estimatedGas.toString(),
      childrenCount: node.children.length,
      subCalls: node.children.map((c) => this.serializeNodeForAlert(c)),
    };
  }

  private buildFlatTrace(rootNodes: CallGraphNode[]): string[] {
    const traceLines: string[] = [];

    const formatNode = (node: CallGraphNode) => {
      const indent = '  '.repeat(node.depth);
      const callerPrefix = node.callerAddress ? `${node.callerAddress.slice(0, 6)}... -> ` : '';
      const contractLabel = `${node.contractId.slice(0, 6)}...`;
      const argsCount = node.args.length;
      const statusLabel = `[${node.status}]`;
      const gasInfo = `(CPU: ${node.gasMetrics.cpuInstructions}, Mem: ${node.gasMetrics.memoryBytes}B)`;

      traceLines.push(
        `${indent}[${node.depth}] ${callerPrefix}${contractLabel}.${node.functionName}(${argsCount} args) ${gasInfo} ${statusLabel}`,
      );

      for (const child of node.children) {
        formatNode(child);
      }
    };

    for (const root of rootNodes) {
      formatNode(root);
    }

    return traceLines;
  }
}

/** Singleton instance with default options. */
export const callGraphTracer = new CallGraphTracer();
