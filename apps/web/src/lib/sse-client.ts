'use client';

/**
 * React hook for subscribing to the SSE payment push stream (Issue #64).
 * Uses the native EventSource API with automatic exponential-backoff reconnect.
 */
import { useEffect, useCallback, useRef, useState } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface PaymentEvent {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer: string | null;
  fromAddress: string;
  receivedAt: string;
}

export interface SorobanStreamTopic {
  symbol: string;
  type: string;
  value: unknown;
  xdrBase64?: string;
}

export interface SorobanStreamEvent {
  id: string;
  contractId: string;
  txHash: string;
  ledgerSeq: number;
  createdAt: string;
  eventType: 'contract' | 'system' | 'diagnostic';
  topics: SorobanStreamTopic[];
  dataXdr: string;
  decodedData: Record<string, unknown>;
  type?: string;
}

export interface UseSorobanEventStreamOptions {
  contractId?: string;
  enabled?: boolean;
}

/**
 * Type guard and filter that verifies whether a raw SSE payload represents a Soroban contract event.
 */
export function isSorobanStreamEvent(payload: unknown): payload is SorobanStreamEvent {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  if (candidate.type && candidate.type !== 'soroban' && candidate.type !== 'soroban_event') {
    return false;
  }
  const hasContractId = typeof candidate.contractId === 'string' && candidate.contractId.trim().length > 0;
  const hasTopics = Array.isArray(candidate.topics);
  const hasDataXdr = typeof candidate.dataXdr === 'string';
  return hasContractId && hasTopics && hasDataXdr;
}

/**
 * Subscribes to real-time payment events from the Fastify SSE endpoint.
 *
 * @param onPayment  Callback invoked with each incoming payment event payload.
 *
 * Usage:
 *   const { connected } = usePaymentStream((payment) => {
 *     console.log('New payment:', payment);
 *   });
 */
export function usePaymentStream(onPayment: (data: PaymentEvent) => void) {
  const [connected, setConnected] = useState(false);
  const onPaymentRef = useRef(onPayment);
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const esRef = useRef<EventSource | null>(null);
  const unmountedRef = useRef(false);

  // Keep the callback ref current so we don't need to re-subscribe when it changes
  useEffect(() => {
    onPaymentRef.current = onPayment;
  }, [onPayment]);

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (unmountedRef.current || typeof EventSource === 'undefined') return;

    const es = new EventSource(`${API_URL}/events`);
    esRef.current = es;

    es.addEventListener('connected', () => {
      setConnected(true);
      // Reset backoff on successful connection
      reconnectDelayRef.current = RECONNECT_BASE_MS;
    });

    es.addEventListener('payment', (event: MessageEvent) => {
      try {
        const data: PaymentEvent = JSON.parse(event.data);
        onPaymentRef.current(data);
      } catch (err) {
        console.warn('[SSE] Failed to parse payment event:', err);
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);

      if (unmountedRef.current) return;

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);

      setTimeout(() => {
        connectRef.current();
      }, delay);
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [connect]);

  return { connected };
}

/**
 * Subscribes to live SSE stream filtered for Soroban contract events (Issue #642).
 *
 * Listens for 'soroban', 'soroban_event', and generic 'message' SSE frames,
 * validates that payloads match Soroban contract event structure, and optionally
 * filters by contractId.
 */
export function useSorobanEventStream(
  onEvent: (event: SorobanStreamEvent) => void,
  options: UseSorobanEventStreamOptions = {},
) {
  const { contractId = '', enabled = true } = options;
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(!enabled);
  const onEventRef = useRef(onEvent);
  const contractIdRef = useRef(contractId);
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const esRef = useRef<EventSource | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    contractIdRef.current = contractId;
  }, [contractId]);

  useEffect(() => {
    setPaused(!enabled);
  }, [enabled]);

  const connectRef = useRef<() => void>(() => {});

  const handleRawEvent = useCallback((event: MessageEvent) => {
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isSorobanStreamEvent(parsed)) return;

      const activeFilter = contractIdRef.current.trim().toLowerCase();
      if (activeFilter && !parsed.contractId.toLowerCase().includes(activeFilter)) {
        return;
      }

      const normalized: SorobanStreamEvent = {
        ...parsed,
        txHash:
          typeof parsed.txHash === 'string' && parsed.txHash.trim().length > 0
            ? parsed.txHash
            : `tx_${parsed.id}`,
      };
      onEventRef.current(normalized);
    } catch (err) {
      console.warn('[SSE] Failed to parse Soroban event:', err);
    }
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current || paused || typeof EventSource === 'undefined') return;

    const es = new EventSource(`${API_URL}/events`);
    esRef.current = es;

    es.addEventListener('connected', () => {
      setConnected(true);
      reconnectDelayRef.current = RECONNECT_BASE_MS;
    });

    es.addEventListener('soroban', handleRawEvent);
    es.addEventListener('soroban_event', handleRawEvent);
    es.addEventListener('message', handleRawEvent);

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);

      if (unmountedRef.current || paused) return;

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);

      setTimeout(() => {
        connectRef.current();
      }, delay);
    };
  }, [handleRawEvent, paused]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    unmountedRef.current = false;
    if (!paused) {
      connect();
    } else {
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    }

    return () => {
      unmountedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [connect, paused]);

  const togglePause = useCallback(() => {
    setPaused((prev) => !prev);
  }, []);

  return { connected, paused, setPaused, togglePause };
}

