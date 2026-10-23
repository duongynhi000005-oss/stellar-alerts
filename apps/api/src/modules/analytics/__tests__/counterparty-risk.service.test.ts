import { describe, it, expect, beforeEach } from 'vitest';
import {
  CounterpartyRiskService,
  TransactionHop,
  FlaggedEntity,
} from '../counterparty-risk.service';

describe('CounterpartyRiskService (#738)', () => {
  let service: CounterpartyRiskService;
  let mockGraph: Map<string, TransactionHop[]>;

  beforeEach(() => {
    mockGraph = new Map();

    service = new CounterpartyRiskService({
      decayFactor: 0.5,
      criticalThreshold: 75,
      transactionLookup: async (address: string) => {
        return mockGraph.get(address) || [];
      },
    });
  });

  const addTx = (from: string, to: string, amount = 100, asset = 'XLM', txHash = `tx_${from}_${to}`) => {
    if (!mockGraph.has(to)) {
      mockGraph.set(to, []);
    }
    mockGraph.get(to)!.push({
      txHash,
      from,
      to,
      amount,
      asset,
      timestamp: new Date(),
    });
  };

  it('initializes with default flagged entities and options', () => {
    expect(service.isFlagged('G_OFAC_SANCTIONED_1')).toBe(true);
    expect(service.isFlagged('G_BRIDGE_EXPLOIT_MALICIOUS_2')).toBe(true);
    expect(service.isFlagged('G_UNKNOWN_CLEAN_WALLET')).toBe(false);

    const entity = service.getFlaggedEntity('G_OFAC_SANCTIONED_1');
    expect(entity?.severity).toBe(100);
    expect(entity?.category).toBe('sanctioned');
  });

  it('correctly assesses a clean wallet with no flagged counterparties', async () => {
    const target = 'G_TARGET_CLEAN';
    addTx('G_LEGIT_MERCHANT_A', target, 500);
    addTx('G_LEGIT_USER_B', target, 250);

    const assessment = await service.assessCounterpartyRisk(target);

    expect(assessment.targetAddress).toBe(target);
    expect(assessment.riskScore).toBe(0);
    expect(assessment.riskLevel).toBe('CLEAN');
    expect(assessment.directExposureCount).toBe(0);
    expect(assessment.indirectExposureCount).toBe(0);
    expect(assessment.securityWarningTriggered).toBe(false);
    expect(assessment.exposurePaths).toHaveLength(0);
  });

  it('calculates direct 1-hop exposure to a flagged entity with full severity', async () => {
    const target = 'G_TARGET_EXPOSED_DIRECT';
    // G_OFAC_SANCTIONED_1 sends directly to target (hop 1)
    addTx('G_OFAC_SANCTIONED_1', target, 1000);
    addTx('G_CLEAN_FRIEND', target, 50);

    const assessment = await service.assessCounterpartyRisk(target);

    expect(assessment.directExposureCount).toBe(1);
    expect(assessment.indirectExposureCount).toBe(0);
    expect(assessment.riskScore).toBe(100);
    expect(assessment.riskLevel).toBe('CRITICAL');
    expect(assessment.securityWarningTriggered).toBe(true);
    expect(assessment.warningMessage).toContain('CRITICAL SECURITY WARNING');
    expect(assessment.warningMessage).toContain('G_OFAC_SANCTIONED_1');

    const path = assessment.exposurePaths[0];
    expect(path.hopDistance).toBe(1);
    expect(path.path).toEqual(['G_OFAC_SANCTIONED_1', target]);
    expect(path.decayedRiskContribution).toBe(100);
  });

  it('calculates indirect 2-hop exposure with decay factor (delta = 0.5)', async () => {
    const target = 'G_TARGET_INDIRECT';
    const intermediary = 'G_MIDDLEMAN_EXCHANGE';

    // Bridge exploiter (severity 90) -> Middleman -> Target
    addTx('G_BRIDGE_EXPLOIT_MALICIOUS_2', intermediary, 2000);
    addTx(intermediary, target, 2000);

    const assessment = await service.assessCounterpartyRisk(target);

    expect(assessment.directExposureCount).toBe(0);
    expect(assessment.indirectExposureCount).toBe(1);

    // 2-hop decay: 90 * 0.5 = 45
    expect(assessment.riskScore).toBe(45);
    expect(assessment.riskLevel).toBe('MEDIUM');
    expect(assessment.securityWarningTriggered).toBe(false);

    const path = assessment.exposurePaths[0];
    expect(path.hopDistance).toBe(2);
    expect(path.intermediaryAddress).toBe(intermediary);
    expect(path.path).toEqual(['G_BRIDGE_EXPLOIT_MALICIOUS_2', intermediary, target]);
    expect(path.decayedRiskContribution).toBe(45);
  });

  it('accumulates multi-hop exposures and strictly clamps score to 100', async () => {
    const target = 'G_TARGET_MULTI_EXPOSURE';
    const middle1 = 'G_MIDDLE_1';
    const middle2 = 'G_MIDDLE_2';

    // 1-hop mixer (severity 80, decay = 80)
    addTx('G_TORNADO_MIXER_POOL_3', target, 500);

    // 2-hop exploit (severity 90 * 0.5 = 45)
    addTx('G_BRIDGE_EXPLOIT_MALICIOUS_2', middle1, 100);
    addTx(middle1, target, 100);

    // 2-hop sanctioned (severity 100 * 0.5 = 50)
    addTx('G_OFAC_SANCTIONED_1', middle2, 100);
    addTx(middle2, target, 100);

    const assessment = await service.assessCounterpartyRisk(target);

    // Raw sum: 80 + 45 + 50 = 175 -> clamped to 100
    expect(assessment.riskScore).toBe(100);
    expect(assessment.riskLevel).toBe('CRITICAL');
    expect(assessment.directExposureCount).toBe(1);
    expect(assessment.indirectExposureCount).toBe(2);
    expect(assessment.exposurePaths).toHaveLength(3);
  });

  it('safely handles cyclic / loop transactions without infinite loops or duplicate paths', async () => {
    const target = 'G_CYCLIC_TARGET';
    const peerA = 'G_PEER_A';
    const peerB = 'G_PEER_B';

    // Create a cycle: Target -> PeerA -> PeerB -> PeerA -> Target
    addTx(peerA, target, 100);
    addTx(peerB, peerA, 100);
    addTx(peerA, peerB, 100);
    addTx(target, peerA, 100); // Back-edge to target

    const assessment = await service.assessCounterpartyRisk(target);

    // Should complete cleanly and not loop infinitely
    expect(assessment.targetAddress).toBe(target);
    expect(assessment.riskScore).toBe(0);
    expect(assessment.riskLevel).toBe('CLEAN');
  });

  it('clusters graph neighbors into connected counterparty components', async () => {
    const target = 'G_CLUSTER_TARGET';
    const cluster1_A = 'G_CORRIDOR_1_A';
    const cluster1_B = 'G_CORRIDOR_1_B';

    addTx(cluster1_A, target, 1000);
    addTx(cluster1_B, cluster1_A, 500);

    const assessment = await service.assessCounterpartyRisk(target);

    expect(assessment.clusters.length).toBeGreaterThanOrEqual(1);
    const mainCluster = assessment.clusters[0];
    expect(mainCluster.addresses).toContain(target);
    expect(mainCluster.addresses).toContain(cluster1_A);
    expect(mainCluster.addresses).toContain(cluster1_B);
    expect(mainCluster.totalVolume).toBeGreaterThan(0);
  });

  it('supports custom entity registration and parameterized decay factors', async () => {
    const customService = new CounterpartyRiskService({
      decayFactor: 0.25, // Stronger decay
      criticalThreshold: 60,
      transactionLookup: async (addr) => mockGraph.get(addr) || [],
    });

    const customFlagged: FlaggedEntity = {
      address: 'G_CUSTOM_PHISHING_ACTOR',
      category: 'phishing',
      severity: 80,
    };
    customService.registerFlaggedEntity(customFlagged);

    const target = 'G_TARGET_CUSTOM';
    const hop1 = 'G_HOP_1';
    addTx('G_CUSTOM_PHISHING_ACTOR', hop1, 100);
    addTx(hop1, target, 100);

    const assessment = await customService.assessCounterpartyRisk(target);

    // 2-hop with decayFactor 0.25: 80 * 0.25 = 20
    expect(assessment.riskScore).toBe(20);
    expect(assessment.riskLevel).toBe('LOW');
  });
});
