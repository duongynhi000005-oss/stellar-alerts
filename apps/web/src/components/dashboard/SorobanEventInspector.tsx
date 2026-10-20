'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useSorobanEventStream, SorobanStreamEvent } from '../../lib/sse-client';

const Code2Icon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
  </svg>
);
const TagIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5a2 2 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
  </svg>
);
const CopyIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);
const CheckIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);
const DatabaseIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);
const ChevronRightIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);
const ChevronDownIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

export interface SorobanDecodedTopic {
  symbol: string;
  type: string;
  value: unknown;
  xdrBase64?: string;
}

export interface SorobanContractEventItem {
  id: string;
  contractId: string;
  txHash?: string;
  ledgerSeq: number;
  createdAt: string;
  eventType: 'contract' | 'system' | 'diagnostic';
  topics: SorobanDecodedTopic[];
  dataXdr: string;
  decodedData: Record<string, unknown>;
}

export interface DecodedScValEntry {
  key: string;
  scValType: string;
  value: unknown;
  source: 'topic' | 'data';
  xdrBase64?: string;
}

export function inferScValType(key: string, value: unknown): string {
  if (typeof value === 'boolean') return 'ScvBool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'ScvU32' : 'ScvI128';
  if (Array.isArray(value)) return 'ScvVec';
  if (value && typeof value === 'object') return 'ScvMap';
  if (typeof value === 'string') {
    if (/^[CG][A-Z2-7]{20,}$/.test(value)) return 'ScvAddress';
    if (/^\d+(\.\d+)?$/.test(value)) return 'ScvI128';
    if (key.toLowerCase().includes('symbol') || key.toLowerCase().includes('code')) return 'ScvSymbol';
    return 'ScvString';
  }
  return 'ScvVoid';
}

export function extractDecodedScVals(event: SorobanContractEventItem): DecodedScValEntry[] {
  const topicEntries: DecodedScValEntry[] = event.topics.map((t, index) => ({
    key: `topic[${index}] (${t.symbol})`,
    scValType: t.type.startsWith('Scv') ? t.type : `Scv${t.type}`,
    value: t.value,
    source: 'topic',
    xdrBase64: t.xdrBase64,
  }));

  const dataEntries: DecodedScValEntry[] = Object.entries(event.decodedData).map(([key, value]) => ({
    key,
    scValType: inferScValType(key, value),
    value,
    source: 'data',
    xdrBase64: event.dataXdr,
  }));

  return [...topicEntries, ...dataEntries];
}

export const SAMPLE_SOROBAN_EVENTS: SorobanContractEventItem[] = [
  {
    id: 'evt_sac_transfer_001',
    contractId: 'CCONTRACTSAC2222222222222222222222222222222222222222222',
    txHash: '8f4a9c1e5b207d33a91c6e4402d1b87f9a3e5c1208b4d6e7f1a2c3d4b72d04a1',
    ledgerSeq: 4892102,
    createdAt: '2026-08-30T14:22:10Z',
    eventType: 'contract',
    topics: [
      { symbol: 'transfer', type: 'Symbol', value: 'transfer', xdrBase64: 'AAAAEAAAAAh0cmFuc2Zlcg==' },
      { symbol: 'from', type: 'Address', value: 'GABC1234567890ACCOUNTDEEJAH000000000000000000000000000', xdrBase64: 'AAAAEAAAAA...' },
      { symbol: 'to', type: 'Address', value: 'GBUYER987654321ACCOUNTTESTER00000000000000000000000000', xdrBase64: 'AAAAEAAAAA...' },
    ],
    dataXdr: 'AAAAEgAAAAAAAABAAAAAAACW+g==',
    decodedData: {
      amount: '500.0000000',
      rawAmount: '5000000000',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335WFOPVQOI3M7G73X2D4J80000',
    },
  },
  {
    id: 'evt_mint_002',
    contractId: 'CCONTRACTPOOL111111111111111111111111111111111111111111',
    txHash: '3c7e12a9b408f5d16e29c7a481b3d05f7e9a2c4168d0b5e3a7c9f1d2e4b6a8c0',
    ledgerSeq: 4892105,
    createdAt: '2026-08-30T14:23:45Z',
    eventType: 'contract',
    topics: [
      { symbol: 'mint', type: 'Symbol', value: 'mint', xdrBase64: 'AAAAEAAAAARtaW50' },
      { symbol: 'to', type: 'Address', value: 'GMINTER0000000000000000000000000000000000000000000000', xdrBase64: 'AAAAEAAAAA...' },
    ],
    dataXdr: 'AAAAEgAAAAAAAABAAAAAAAFoEA==',
    decodedData: {
      amount: '1000.0000000',
      sharesIssued: '998.5000',
    },
  },
  {
    id: 'evt_swap_003',
    contractId: 'CCONTRACTAMMDEX33333333333333333333333333333333333333',
    txHash: '9d2b5e8f1a4c7d0e3b6a9f2c5d8e1b4a7f0c3d6e9b2a5f8c1d4e7b0a3f6c9d2e',
    ledgerSeq: 4892110,
    createdAt: '2026-08-30T14:25:00Z',
    eventType: 'contract',
    topics: [
      { symbol: 'swap', type: 'Symbol', value: 'swap', xdrBase64: 'AAAAEAAAAARzd2Fw' },
      { symbol: 'trader', type: 'Address', value: 'GTRADER55555555555555555555555555555555555555555555555', xdrBase64: 'AAAAEAAAAA...' },
      { symbol: 'pair', type: 'Vec', value: ['XLM', 'USDC'], xdrBase64: 'AAAAEAAAAA...' },
    ],
    dataXdr: 'AAAAEgAAAAAAAABAAAAAAAIZ0==',
    decodedData: {
      amountIn: '100.0000000',
      amountOut: '22.5000000',
      slippageBps: 15,
    },
  },
];

export interface SorobanEventInspectorProps {
  events?: SorobanContractEventItem[];
  initialContractFilter?: string;
  initialTopicFilter?: string;
  enableStream?: boolean;
}

function formatShortHash(hash?: string, id?: string): string {
  const value = hash && hash.trim().length > 0 ? hash.trim() : `tx_${id ?? 'unknown'}`;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function SorobanEventInspector({
  events = SAMPLE_SOROBAN_EVENTS,
  initialContractFilter = '',
  initialTopicFilter = '',
  enableStream = true,
}: SorobanEventInspectorProps) {
  const [liveEvents, setLiveEvents] = useState<SorobanContractEventItem[]>([]);
  const [contractFilter, setContractFilter] = useState(initialContractFilter);
  const [topicFilter, setTopicFilter] = useState(initialTopicFilter);
  const [selectedEventId, setSelectedEventId] = useState<string>(events[0]?.id || '');
  const [copied, setCopied] = useState(false);
  const [copiedRawXdr, setCopiedRawXdr] = useState(false);
  const [rawXdrExpanded, setRawXdrExpanded] = useState(true);
  const [modalEventId, setModalEventId] = useState<string | null>(null);
  const [modalCopiedXdr, setModalCopiedXdr] = useState(false);
  const [modalCopiedJson, setModalCopiedJson] = useState(false);
  const [modalFullXdr, setModalFullXdr] = useState(false);

  const handleIncomingStreamEvent = useCallback((incoming: SorobanStreamEvent) => {
    setLiveEvents((prev) => {
      if (prev.some((item) => item.id === incoming.id)) return prev;
      return [incoming, ...prev];
    });
    setSelectedEventId((prev) => prev || incoming.id);
  }, []);

  const { connected, paused, togglePause } = useSorobanEventStream(handleIncomingStreamEvent, {
    enabled: enableStream,
  });

  const combinedEvents = useMemo(() => {
    const seen = new Set<string>();
    const merged: SorobanContractEventItem[] = [];
    for (const item of [...liveEvents, ...events]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }, [liveEvents, events]);

  const filteredEvents = useMemo(() => {
    return combinedEvents.filter((evt) => {
      const matchesContract =
        !contractFilter.trim() ||
        evt.contractId.toLowerCase().includes(contractFilter.trim().toLowerCase());

      const matchesTopic =
        !topicFilter.trim() ||
        evt.topics.some(
          (t) =>
            t.symbol.toLowerCase().includes(topicFilter.trim().toLowerCase()) ||
            String(t.value).toLowerCase().includes(topicFilter.trim().toLowerCase()),
        );

      return matchesContract && matchesTopic;
    });
  }, [combinedEvents, contractFilter, topicFilter]);

  const selectedEvent = useMemo(() => {
    return filteredEvents.find((e) => e.id === selectedEventId) || filteredEvents[0] || null;
  }, [filteredEvents, selectedEventId]);

  const modalEvent = useMemo(() => {
    if (!modalEventId) return null;
    return combinedEvents.find((e) => e.id === modalEventId) || selectedEvent;
  }, [modalEventId, combinedEvents, selectedEvent]);

  const modalScVals = useMemo(() => {
    return modalEvent ? extractDecodedScVals(modalEvent) : [];
  }, [modalEvent]);

  useEffect(() => {
    if (!modalEventId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModalEventId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalEventId]);

  const copyEventJson = () => {
    if (!selectedEvent) return;
    navigator.clipboard?.writeText(JSON.stringify(selectedEvent, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyRawXdrText = (xdr: string, isModal = false) => {
    navigator.clipboard?.writeText(xdr);
    if (isModal) {
      setModalCopiedXdr(true);
      setTimeout(() => setModalCopiedXdr(false), 2000);
    } else {
      setCopiedRawXdr(true);
      setTimeout(() => setCopiedRawXdr(false), 2000);
    }
  };

  const copyModalJsonText = (eventItem: SorobanContractEventItem) => {
    navigator.clipboard?.writeText(JSON.stringify(eventItem.decodedData, null, 2));
    setModalCopiedJson(true);
    setTimeout(() => setModalCopiedJson(false), 2000);
  };

  return (
    <section
      aria-label="Soroban Contract Event Explorer"
      className="w-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden text-slate-100 shadow-xl"
      data-testid="soroban-event-inspector"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Code2Icon className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Soroban Contract Event Explorer</h2>
            <p className="text-xs text-slate-400">
              Inspect decoded XDR topics, contract events, and binary payloads in real-time
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span
            data-testid="sse-connection-badge"
            aria-live="polite"
            className={`px-2.5 py-1 rounded-full border font-mono flex items-center gap-1.5 ${
              connected
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : paused
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  : 'bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? 'bg-emerald-400 animate-pulse' : paused ? 'bg-amber-400' : 'bg-slate-400'
              }`}
            />
            {connected ? 'Live SSE Stream' : paused ? 'Stream Paused' : 'SSE Listening'}
          </span>
          <button
            type="button"
            onClick={togglePause}
            data-testid="toggle-stream-btn"
            aria-pressed={paused}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium transition-colors"
          >
            {paused ? 'Resume Stream' : 'Pause Stream'}
          </button>
          <span className="px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 font-mono">
            {filteredEvents.length} Event{filteredEvents.length === 1 ? '' : 's'} Found
          </span>
        </div>
      </div>

      {/* Controls & Filter Bar */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/50 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="relative">
          <label htmlFor="soroban-contract-filter-input" className="sr-only">
            Filter by Contract ID
          </label>
          <DatabaseIcon className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
          <input
            id="soroban-contract-filter-input"
            type="text"
            aria-label="Filter by Contract ID"
            data-testid="contract-id-input"
            value={contractFilter}
            onChange={(e) => setContractFilter(e.target.value)}
            placeholder="Filter by Contract ID (C...)..."
            className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <div className="relative">
          <label htmlFor="soroban-topic-filter-input" className="sr-only">
            Filter by Topic Symbol
          </label>
          <TagIcon className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
          <input
            id="soroban-topic-filter-input"
            type="text"
            aria-label="Filter by Topic Symbol"
            data-testid="topic-symbol-input"
            value={topicFilter}
            onChange={(e) => setTopicFilter(e.target.value)}
            placeholder="Filter by Topic Symbol (e.g. transfer, mint, swap)..."
            className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
      </div>

      {/* Main Content Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[420px]">
        {/* Left Event Stream List */}
        <div
          role="list"
          aria-label="Soroban contract events"
          className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-950/40 max-h-[540px] overflow-y-auto divide-y divide-slate-800/60"
        >
          {filteredEvents.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              No matching Soroban events found for current filter criteria.
            </div>
          ) : (
            filteredEvents.map((evt) => {
              const isSelected = selectedEvent?.id === evt.id;
              const primaryTopic = evt.topics[0]?.symbol || 'event';
              const txHashDisplay = formatShortHash(evt.txHash, evt.id);

              return (
                <div
                  key={evt.id}
                  role="listitem"
                  className={`w-full text-left p-4 transition-colors flex flex-col gap-2 ${
                    isSelected
                      ? 'bg-indigo-600/10 border-l-4 border-indigo-500'
                      : 'hover:bg-slate-800/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedEventId(evt.id)}
                    className="w-full text-left flex flex-col gap-2 cursor-pointer"
                    data-testid={`event-item-${evt.id}`}
                  >
                    <div className="flex items-center justify-between w-full gap-2">
                      <span
                        data-testid={`event-topic-badge-${evt.id}`}
                        className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-indigo-500/20 text-indigo-300"
                      >
                        {primaryTopic}
                      </span>
                      <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                        <span>Ledger #{evt.ledgerSeq}</span>
                        <span>•</span>
                        <time
                          dateTime={evt.createdAt}
                          data-testid={`event-timestamp-${evt.id}`}
                          className="text-slate-400"
                        >
                          {evt.createdAt}
                        </time>
                      </div>
                    </div>

                    <div
                      data-testid={`event-contract-${evt.id}`}
                      className="text-xs font-mono text-slate-300 truncate w-full"
                    >
                      {evt.contractId}
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                      <span data-testid={`event-tx-hash-${evt.id}`} className="truncate">
                        tx: {txHashDisplay}
                      </span>
                      <span className="uppercase text-[10px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300">
                        {evt.eventType}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                      {evt.topics.map((t, idx) => (
                        <span
                          key={idx}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700/50"
                        >
                          {t.symbol}: {String(t.value).substring(0, 12)}
                        </span>
                      ))}
                    </div>
                  </button>

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEventId(evt.id);
                        setModalEventId(evt.id);
                      }}
                      data-testid={`open-xdr-modal-${evt.id}`}
                      className="text-[11px] font-mono font-medium text-indigo-400 hover:text-indigo-300 px-2 py-1 rounded bg-indigo-500/10 border border-indigo-500/20 transition-colors"
                    >
                      Inspect ScVal &amp; XDR
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Event Inspector Details */}
        <div className="lg:col-span-7 p-6 bg-slate-900 flex flex-col gap-6 max-h-[540px] overflow-y-auto">
          {selectedEvent ? (
            <>
              {/* Event Header Info */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-400 font-mono">Contract Event ID</div>
                  <div className="text-sm font-bold text-white font-mono">{selectedEvent.id}</div>
                  <div className="text-xs text-slate-400 font-mono mt-0.5">
                    Tx Hash: <span className="text-slate-300">{selectedEvent.txHash || `tx_${selectedEvent.id}`}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setModalEventId(selectedEvent.id)}
                    data-testid="open-xdr-modal-btn"
                    className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 text-xs font-medium transition-colors"
                  >
                    Expand ScVal Modal
                  </button>
                  <button
                    type="button"
                    onClick={copyEventJson}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                  >
                    {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied JSON' : 'Copy JSON'}</span>
                  </button>
                </div>
              </div>

              {/* Decoded Topic Tree Viewer */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
                  Decoded XDR Topic Structure
                </h3>
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs space-y-2">
                  {selectedEvent.topics.map((topic, idx) => (
                    <div key={idx} className="p-2.5 rounded bg-slate-900/80 border border-slate-800 flex flex-col gap-1">
                      <div className="flex items-center justify-between text-slate-300">
                        <span className="text-indigo-300 font-bold">Topic[{idx}]: {topic.symbol}</span>
                        <span className="text-[10px] text-slate-500 font-sans px-1.5 py-0.5 rounded bg-slate-800">
                          {topic.type}
                        </span>
                      </div>
                      <div className="text-slate-200 font-semibold break-all">
                        {JSON.stringify(topic.value, null, 2)}
                      </div>
                      {topic.xdrBase64 && (
                        <div className="text-[10px] text-slate-500 break-all">
                          XDR: <span className="text-slate-400">{topic.xdrBase64}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Side-by-Side View: Decoded Event Data Payload JSON vs Raw Base64 XDR */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4" data-testid="side-by-side-xdr-json">
                {/* Decoded Event Data Payload JSON */}
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Decoded Event Data Payload
                  </h3>
                  <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto h-full">
                    <pre data-testid="json-payload-tree">{JSON.stringify(selectedEvent.decodedData, null, 2)}</pre>
                  </div>
                </div>

                {/* Raw Data XDR */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setRawXdrExpanded(!rawXdrExpanded)}
                      className="flex items-center space-x-1 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      {rawXdrExpanded ? <ChevronDownIcon className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
                      <span>Raw Data XDR (Base64)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => copyRawXdrText(selectedEvent.dataXdr, false)}
                      data-testid="copy-raw-xdr-btn"
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-mono text-slate-300"
                    >
                      {copiedRawXdr ? 'Copied XDR' : 'Copy XDR'}
                    </button>
                  </div>
                  {rawXdrExpanded && (
                    <div
                      data-testid="raw-data-xdr-box"
                      className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 break-all"
                    >
                      {selectedEvent.dataXdr}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-slate-500 text-sm">
              Select an event from the left list to view its decoded XDR topics.
            </div>
          )}
        </div>
      </div>

      {/* Expandable Modal showing Decoded ScVal values and Copyable Raw XDR */}
      {modalEvent && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="xdr-modal-title"
          data-testid="xdr-inspector-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-800 bg-slate-950 flex items-center justify-between">
              <div>
                <h3 id="xdr-modal-title" className="text-base font-bold text-white">
                  ScVal &amp; Raw XDR Inspector — {modalEvent.id}
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  Contract: {modalEvent.contractId} | Ledger #{modalEvent.ledgerSeq}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalEventId(null)}
                data-testid="close-xdr-modal-btn"
                aria-label="Close ScVal Inspector Modal"
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
              >
                Close
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {/* Decoded ScVal Values Table */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-400">
                  Decoded ScVal Values ({modalScVals.length})
                </h4>
                <div className="rounded-lg border border-slate-800 overflow-hidden bg-slate-950">
                  <table className="w-full text-left border-collapse text-xs font-mono" data-testid="modal-scval-table">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-900/70 text-slate-400">
                        <th className="py-2 px-3">Source / Field</th>
                        <th className="py-2 px-3">ScVal Type</th>
                        <th className="py-2 px-3">Decoded Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {modalScVals.map((entry, idx) => (
                        <tr key={idx} data-testid={`modal-scval-row-${idx}`}>
                          <td className="py-2 px-3 text-indigo-300 font-semibold">{entry.key}</td>
                          <td className="py-2 px-3">
                            <span className="px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
                              {entry.scValType}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-slate-200 break-all">
                            {typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Side-by-Side Raw Base64 XDR vs Formatted JSON in Modal */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
                      Raw Base64 XDR
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setModalFullXdr((prev) => !prev)}
                        data-testid="modal-expand-xdr-btn"
                        className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300"
                      >
                        {modalFullXdr ? 'Compact View' : 'Expand All Topic XDR'}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyRawXdrText(modalEvent.dataXdr, true)}
                        data-testid="modal-copy-xdr-btn"
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
                      >
                        {modalCopiedXdr ? 'Copied XDR!' : 'Copy Raw XDR'}
                      </button>
                    </div>
                  </div>
                  <div
                    data-testid="modal-raw-xdr-content"
                    className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 break-all space-y-2"
                  >
                    <div>
                      <span className="text-slate-500">Data XDR: </span>
                      <span>{modalEvent.dataXdr}</span>
                    </div>
                    {modalFullXdr &&
                      modalEvent.topics.map((t, i) => (
                        <div key={i} className="text-[11px] text-slate-400">
                          Topic[{i}] ({t.symbol}): {t.xdrBase64 || 'N/A'}
                        </div>
                      ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                      Formatted JSON Payload
                    </span>
                    <button
                      type="button"
                      onClick={() => copyModalJsonText(modalEvent)}
                      data-testid="modal-copy-json-btn"
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
                    >
                      {modalCopiedJson ? 'Copied JSON!' : 'Copy JSON'}
                    </button>
                  </div>
                  <pre
                    data-testid="modal-formatted-json"
                    className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto"
                  >
                    {JSON.stringify(modalEvent.decodedData, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
