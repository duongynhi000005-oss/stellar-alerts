import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'CounterpartyRiskService' });

export type RiskLevel = 'CLEAN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FlaggedEntity {
  address: string;
  category: 'sanctioned' | 'exploit' | 'phishing' | 'mixer' | 'suspicious';
  severity: number; // 0 to 100
  source?: string;
  name?: string;
}

export interface TransactionHop {
  txHash: string;
  from: string;
  to: string;
  amount: number;
  asset: string;
  timestamp: Date;
}

export interface ExposurePath {
  flaggedEntity: FlaggedEntity;
  hopDistance: 1 | 2;
  intermediaryAddress?: string;
  path: string[];
  volume: number;
  decayedRiskContribution: number;
}

export interface CounterpartyCluster {
  clusterId: string;
  seedAddress: string;
  addresses: string[];
  totalVolume: number;
  maxHopDistance: number;
  flaggedCount: number;
  riskScore: number;
}

export interface RiskAssessmentResult {
  targetAddress: string;
  riskScore: number; // 0 to 100
  riskLevel: RiskLevel;
  directExposureCount: number;
  indirectExposureCount: number;
  exposurePaths: ExposurePath[];
  clusters: CounterpartyCluster[];
  securityWarningTriggered: boolean;
  warningMessage?: string;
}

export interface CounterpartyRiskOptions {
  decayFactor?: number; // Multiplier per additional hop distance, e.g. 0.5
  criticalThreshold?: number; // default 75
  highThreshold?: number; // default 50
  mediumThreshold?: number; // default 25
  lowThreshold?: number; // default 10
  transactionLookup?: (address: string) => Promise<TransactionHop[]>;
}

export class CounterpartyRiskService {
  private flaggedRegistry: Map<string, FlaggedEntity> = new Map();
  private options: Required<Omit<CounterpartyRiskOptions, 'transactionLookup'>> & {
    transactionLookup?: (address: string) => Promise<TransactionHop[]>;
  };

  constructor(options: CounterpartyRiskOptions = {}) {
    this.options = {
      decayFactor: options.decayFactor ?? 0.5,
      criticalThreshold: options.criticalThreshold ?? 75,
      highThreshold: options.highThreshold ?? 50,
      mediumThreshold: options.mediumThreshold ?? 25,
      lowThreshold: options.lowThreshold ?? 10,
      transactionLookup: options.transactionLookup,
    };

    // Pre-populate default known flagged test entities
    this.registerDefaultFlaggedEntities();
  }

  private registerDefaultFlaggedEntities(): void {
    const defaults: FlaggedEntity[] = [
      {
        address: 'G_OFAC_SANCTIONED_1',
        category: 'sanctioned',
        severity: 100,
        name: 'OFAC SDN Specially Designated Entity',
        source: 'OFAC',
      },
      {
        address: 'G_BRIDGE_EXPLOIT_MALICIOUS_2',
        category: 'exploit',
        severity: 90,
        name: 'Known Bridge Drain Exploit Wallet',
        source: 'Chainalysis/Security-Advisory',
      },
      {
        address: 'G_TORNADO_MIXER_POOL_3',
        category: 'mixer',
        severity: 80,
        name: 'Darknet Asset Mixing Contract',
        source: 'Stellar Compliance Watch',
      },
    ];

    for (const entity of defaults) {
      this.flaggedRegistry.set(entity.address, entity);
    }
  }

  public registerFlaggedEntity(entity: FlaggedEntity): void {
    this.flaggedRegistry.set(entity.address, entity);
  }

  public registerFlaggedEntities(entities: FlaggedEntity[]): void {
    for (const entity of entities) {
      this.flaggedRegistry.set(entity.address, entity);
    }
  }

  public getFlaggedEntity(address: string): FlaggedEntity | undefined {
    return this.flaggedRegistry.get(address);
  }

  public isFlagged(address: string): boolean {
    return this.flaggedRegistry.has(address);
  }

  /**
   * Retrieves incoming payment transaction hops for a given recipient address.
   */
  public async getIncomingTransactions(address: string): Promise<TransactionHop[]> {
    if (this.options.transactionLookup) {
      return this.options.transactionLookup(address);
    }

    try {
      const { getReadClient } = await import('../../lib/prisma');
      const client = getReadClient();
      const rows = await client.payment.findMany({
        where: {
          wallet: {
            publicKey: address,
          },
        },
        orderBy: { receivedAt: 'desc' },
        take: 200,
      });

      return rows.map((r: any) => ({
        txHash: r.txHash,
        from: r.fromAddress,
        to: address,
        amount: Number(r.amount),
        asset: r.asset,
        timestamp: r.receivedAt,
      }));
    } catch (err: any) {
      log.error({ err: err.message, address }, '[CounterpartyRiskService] Failed to load transactions from DB');
      return [];
    }
  }

  /**
   * Performs 2-hop transaction graph traversal, acyclic traversal checking,
   * risk scoring decay computation, and neighbor clustering.
   */
  public async assessCounterpartyRisk(targetAddress: string): Promise<RiskAssessmentResult> {
    log.info({ targetAddress }, '[CounterpartyRiskService] Evaluating multi-hop risk for address');

    const exposurePaths: ExposurePath[] = [];
    const visitedEdges = new Set<string>(); // "from->to"
    const visitedAddresses = new Set<string>([targetAddress]);

    // Graph representation for clustering: adjacency list
    const adjacency = new Map<string, Set<string>>();
    const nodeVolumes = new Map<string, number>();

    const addEdge = (u: string, v: string, vol: number) => {
      if (!adjacency.has(u)) adjacency.set(u, new Set());
      if (!adjacency.has(v)) adjacency.set(v, new Set());
      adjacency.get(u)!.add(v);
      adjacency.get(v)!.add(u);

      nodeVolumes.set(u, (nodeVolumes.get(u) ?? 0) + vol);
      nodeVolumes.set(v, (nodeVolumes.get(v) ?? 0) + vol);
    };

    // 1. Hop 1: Direct counterparties sending to targetAddress
    const hop1Txs = await this.getIncomingTransactions(targetAddress);
    const hop1Senders = new Map<string, { totalAmount: number; txs: TransactionHop[] }>();

    for (const tx of hop1Txs) {
      const sender = tx.from;
      if (!sender || sender === targetAddress) continue; // Skip self transactions

      const edgeKey = `${sender}->${targetAddress}`;
      visitedEdges.add(edgeKey);
      addEdge(sender, targetAddress, tx.amount);

      if (!hop1Senders.has(sender)) {
        hop1Senders.set(sender, { totalAmount: 0, txs: [] });
      }
      const entry = hop1Senders.get(sender)!;
      entry.totalAmount += tx.amount;
      entry.txs.push(tx);
    }

    // Check direct 1-hop exposure
    for (const [sender, data] of hop1Senders.entries()) {
      visitedAddresses.add(sender);
      const flagged = this.flaggedRegistry.get(sender);

      if (flagged) {
        // Direct exposure: hopDistance = 1, decay = 1.0 (delta^0)
        const decayedRisk = flagged.severity * 1.0;
        exposurePaths.push({
          flaggedEntity: flagged,
          hopDistance: 1,
          path: [sender, targetAddress],
          volume: data.totalAmount,
          decayedRiskContribution: decayedRisk,
        });
      }
    }

    // 2. Hop 2: Senders to our Hop 1 counterparties (Indirect 2-hop exposure)
    for (const [hop1Sender] of hop1Senders.entries()) {
      const hop2Txs = await this.getIncomingTransactions(hop1Sender);

      for (const tx of hop2Txs) {
        const sender2 = tx.from;
        if (!sender2) continue;

        // Acyclic protection: Skip if already visited target or forming immediate self-cycle
        if (sender2 === targetAddress || sender2 === hop1Sender) {
          continue;
        }

        const edgeKey = `${sender2}->${hop1Sender}`;
        if (visitedEdges.has(edgeKey)) {
          continue; // Already processed edge
        }
        visitedEdges.add(edgeKey);
        addEdge(sender2, hop1Sender, tx.amount);

        const flagged2 = this.flaggedRegistry.get(sender2);
        if (flagged2) {
          // Indirect exposure: hopDistance = 2, decay = delta^1
          const decayedRisk = flagged2.severity * this.options.decayFactor;
          exposurePaths.push({
            flaggedEntity: flagged2,
            hopDistance: 2,
            intermediaryAddress: hop1Sender,
            path: [sender2, hop1Sender, targetAddress],
            volume: tx.amount,
            decayedRiskContribution: decayedRisk,
          });
        }

        visitedAddresses.add(sender2);
      }
    }

    // 3. Compute Aggregated Risk Score: R = sum(decayedRiskContribution) clamped to [0, 100]
    let rawScore = 0;
    for (const exp of exposurePaths) {
      rawScore += exp.decayedRiskContribution;
    }
    const riskScore = Math.min(100, Math.max(0, Math.round(rawScore)));

    // Categorize Risk Level
    let riskLevel: RiskLevel = 'CLEAN';
    if (riskScore >= this.options.criticalThreshold) {
      riskLevel = 'CRITICAL';
    } else if (riskScore >= this.options.highThreshold) {
      riskLevel = 'HIGH';
    } else if (riskScore >= this.options.mediumThreshold) {
      riskLevel = 'MEDIUM';
    } else if (riskScore >= this.options.lowThreshold) {
      riskLevel = 'LOW';
    }

    // Exposure Counts
    const directExposureCount = exposurePaths.filter((p) => p.hopDistance === 1).length;
    const indirectExposureCount = exposurePaths.filter((p) => p.hopDistance === 2).length;

    // 4. Graph Neighbor Clustering: Connected Components via BFS
    const clusters: CounterpartyCluster[] = [];
    const clusteredNodes = new Set<string>();

    for (const node of adjacency.keys()) {
      if (clusteredNodes.has(node)) continue;

      // BFS to find all connected component members
      const componentAddresses: string[] = [];
      const queue = [node];
      clusteredNodes.add(node);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        componentAddresses.push(curr);

        const neighbors = adjacency.get(curr);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!clusteredNodes.has(neighbor)) {
              clusteredNodes.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
      }

      // Calculate cluster metrics
      let clusterVolume = 0;
      let flaggedCount = 0;
      let maxHopDistance = 1;
      let clusterRisk = 0;

      for (const addr of componentAddresses) {
        clusterVolume += nodeVolumes.get(addr) ?? 0;
        if (this.flaggedRegistry.has(addr)) {
          flaggedCount++;
          clusterRisk += this.flaggedRegistry.get(addr)!.severity;
        }
      }

      for (const path of exposurePaths) {
        if (componentAddresses.includes(path.flaggedEntity.address)) {
          if (path.hopDistance > maxHopDistance) {
            maxHopDistance = path.hopDistance;
          }
        }
      }

      // Seed address is the highest volume address in the cluster
      const seedAddress = [...componentAddresses].sort(
        (a, b) => (nodeVolumes.get(b) ?? 0) - (nodeVolumes.get(a) ?? 0)
      )[0] ?? node;

      clusters.push({
        clusterId: `cluster_${seedAddress.slice(0, 8)}_${clusters.length + 1}`,
        seedAddress,
        addresses: componentAddresses.sort(),
        totalVolume: clusterVolume,
        maxHopDistance,
        flaggedCount,
        riskScore: Math.min(100, Math.round(clusterRisk)),
      });
    }

    // 5. Critical Security Warning Trigger
    const hasSanctionedDirect = exposurePaths.some(
      (p) => p.hopDistance === 1 && p.flaggedEntity.severity >= 80
    );
    const securityWarningTriggered = riskScore >= this.options.criticalThreshold || hasSanctionedDirect;

    let warningMessage: string | undefined;
    if (securityWarningTriggered) {
      const topEntity = exposurePaths.sort((a, b) => b.decayedRiskContribution - a.decayedRiskContribution)[0];
      const entityDesc = topEntity ? `${topEntity.flaggedEntity.category.toUpperCase()} (${topEntity.flaggedEntity.address}) via ${topEntity.hopDistance}-hop` : 'Flagged entity';
      warningMessage = `CRITICAL SECURITY WARNING: Payment graph for ${targetAddress} has high exposure to ${entityDesc}. Risk score: ${riskScore}/100. Immediate compliance review recommended.`;
      log.warn({ targetAddress, riskScore, warningMessage }, '[CounterpartyRiskService] Security Warning dispatched');
    }

    return {
      targetAddress,
      riskScore,
      riskLevel,
      directExposureCount,
      indirectExposureCount,
      exposurePaths,
      clusters,
      securityWarningTriggered,
      warningMessage,
    };
  }
}

export const counterpartyRiskService = new CounterpartyRiskService();
