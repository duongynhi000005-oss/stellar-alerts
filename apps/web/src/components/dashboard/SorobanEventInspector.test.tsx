import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SorobanEventInspector,
  SAMPLE_SOROBAN_EVENTS,
  extractDecodedScVals,
  inferScValType,
} from './SorobanEventInspector';
import { isSorobanStreamEvent } from '../../lib/sse-client';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, Array<(evt: MessageEvent) => void>> = {};
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: (evt: MessageEvent) => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(callback);
  }

  emit(type: string, data?: unknown) {
    const handlers = this.listeners[type] || [];
    const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    const messageEvent = { data: payload } as MessageEvent;
    handlers.forEach((fn) => fn(messageEvent));
  }

  close() {
    this.closed = true;
  }
}

describe('SorobanEventInspector Component', () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  it('renders correctly with default sample events', () => {
    render(<SorobanEventInspector />);

    expect(screen.getByTestId('soroban-event-inspector')).toBeInTheDocument();
    expect(screen.getByText('Soroban Contract Event Explorer')).toBeInTheDocument();
    expect(screen.getByText(/3 Events Found/i)).toBeInTheDocument();
    expect(screen.getAllByText('evt_sac_transfer_001')[0]).toBeInTheDocument();
  });

  it('renders decoded XDR topic structure and JSON data payload', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    expect(screen.getByText(/Topic\[0\]: transfer/i)).toBeInTheDocument();
    expect(screen.getByText(/AAAAEAAAAAh0cmFuc2Zlcg==/i)).toBeInTheDocument();

    const payloadTree = screen.getByTestId('json-payload-tree');
    expect(payloadTree.textContent).toContain('500.0000000');
    expect(payloadTree.textContent).toContain('USDC');
  });

  it('displays event cards with timestamp, contract address, event topic badge, and transaction hash', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const firstId = SAMPLE_SOROBAN_EVENTS[0].id;
    expect(screen.getByTestId(`event-timestamp-${firstId}`)).toHaveTextContent('2026-08-30T14:22:10Z');
    expect(screen.getByTestId(`event-contract-${firstId}`)).toHaveTextContent(
      'CCONTRACTSAC2222222222222222222222222222222222222222222',
    );
    expect(screen.getByTestId(`event-topic-badge-${firstId}`)).toHaveTextContent('transfer');
    expect(screen.getByTestId(`event-tx-hash-${firstId}`)).toHaveTextContent('tx: 8f4a9c1e...b72d04a1');
  });

  it('filters events dynamically by contract ID', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const contractInput = screen.getByTestId('contract-id-input');
    fireEvent.change(contractInput, {
      target: { value: 'CCONTRACTAMMDEX33333333333333333333333333333333333333' },
    });

    expect(screen.getAllByText('evt_swap_003')[0]).toBeInTheDocument();
    expect(screen.queryByText('evt_sac_transfer_001')).not.toBeInTheDocument();
    expect(screen.getByText(/1 Event Found/i)).toBeInTheDocument();
  });

  it('filters events dynamically by topic symbol keyword', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const topicInput = screen.getByTestId('topic-symbol-input');
    fireEvent.change(topicInput, { target: { value: 'mint' } });

    expect(screen.getAllByText('evt_mint_002')[0]).toBeInTheDocument();
    expect(screen.queryByText('evt_sac_transfer_001')).not.toBeInTheDocument();
    expect(screen.getByText(/1 Event Found/i)).toBeInTheDocument();
  });

  it('allows switching selected events to view detailed decoded XDR topics', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const swapButton = screen.getAllByTestId('event-item-evt_swap_003')[0];
    fireEvent.click(swapButton);

    expect(screen.getAllByText('evt_swap_003')[0]).toBeInTheDocument();
    expect(screen.getByText(/Topic\[0\]: swap/i)).toBeInTheDocument();
    expect(screen.getByTestId('json-payload-tree').textContent).toContain('100.0000000');
  });

  it('subscribes to live SSE stream filtered for Soroban events and ignores non-Soroban payloads', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    expect(MockEventSource.instances.length).toBe(1);
    const es = MockEventSource.instances[0];

    act(() => {
      es.emit('connected', {});
    });
    expect(screen.getByTestId('sse-connection-badge')).toHaveTextContent('Live SSE Stream');

    // Emit a non-Soroban payment payload on generic message channel — should be ignored
    act(() => {
      es.emit('message', {
        type: 'payment',
        paymentId: 'pay_1',
        amount: '100',
      });
    });
    expect(screen.getByText(/3 Events Found/i)).toBeInTheDocument();

    // Emit a valid live Soroban contract event
    act(() => {
      es.emit('soroban', {
        id: 'evt_live_invoke_004',
        contractId: 'CCONTRACTLIVE444444444444444444444444444444444444444444',
        txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        ledgerSeq: 4892120,
        createdAt: '2026-08-30T14:26:30Z',
        eventType: 'contract',
        topics: [
          { symbol: 'stake', type: 'Symbol', value: 'stake', xdrBase64: 'AAAAEAAAAAVzdGFrZQ==' },
        ],
        dataXdr: 'AAAAEgAAAAAAAABAAAAAAAL4QA==',
        decodedData: {
          stakedAmount: '2500.0000000',
          validator: 'GVALIDATOR9999999999999999999999999999999999999999999999',
        },
      });
    });

    expect(screen.getByText(/4 Events Found/i)).toBeInTheDocument();
    expect(screen.getByTestId('event-item-evt_live_invoke_004')).toBeInTheDocument();
    expect(screen.getByTestId('event-topic-badge-evt_live_invoke_004')).toHaveTextContent('stake');
    expect(screen.getByTestId('event-tx-hash-evt_live_invoke_004')).toHaveTextContent('tx: a1b2c3d4...6d7e8f90');
  });

  it('opens expandable modal showing decoded ScVal values and copyable raw XDR', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const openModalBtn = screen.getByTestId('open-xdr-modal-evt_sac_transfer_001');
    fireEvent.click(openModalBtn);

    const modal = screen.getByTestId('xdr-inspector-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');

    const scValTable = screen.getByTestId('modal-scval-table');
    expect(scValTable).toHaveTextContent('topic[0] (transfer)');
    expect(scValTable).toHaveTextContent('ScvSymbol');
    expect(scValTable).toHaveTextContent('ScvAddress');
    expect(scValTable).toHaveTextContent('ScvI128');

    // Copy raw XDR inside modal
    const copyXdrBtn = screen.getByTestId('modal-copy-xdr-btn');
    fireEvent.click(copyXdrBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('AAAAEgAAAAAAAABAAAAAAACW+g==');
    expect(copyXdrBtn).toHaveTextContent('Copied XDR!');

    // Expand all topic XDRs inside modal
    const expandBtn = screen.getByTestId('modal-expand-xdr-btn');
    fireEvent.click(expandBtn);
    expect(screen.getByTestId('modal-raw-xdr-content')).toHaveTextContent('AAAAEAAAAAh0cmFuc2Zlcg==');

    // Close modal with Escape key
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('xdr-inspector-modal')).not.toBeInTheDocument();
  });

  it('verifies responsive layout and accessibility compliance', () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const section = screen.getByTestId('soroban-event-inspector');
    expect(section).toHaveAttribute('aria-label', 'Soroban Contract Event Explorer');

    expect(screen.getByLabelText('Filter by Contract ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by Topic Symbol')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Soroban contract events' })).toBeInTheDocument();

    const sideBySide = screen.getByTestId('side-by-side-xdr-json');
    expect(sideBySide.className).toContain('grid-cols-1');
    expect(sideBySide.className).toContain('xl:grid-cols-2');

    // Pause / resume stream accessibility state
    const toggleStreamBtn = screen.getByTestId('toggle-stream-btn');
    expect(toggleStreamBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggleStreamBtn);
    expect(toggleStreamBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sse-connection-badge')).toHaveTextContent('Stream Paused');
  });

  it('correctly classifies ScVal types and stream payloads', () => {
    expect(inferScValType('flag', true)).toBe('ScvBool');
    expect(inferScValType('count', 42)).toBe('ScvU32');
    expect(inferScValType('pair', ['XLM', 'USDC'])).toBe('ScvVec');
    expect(inferScValType('meta', { k: 'v' })).toBe('ScvMap');
    expect(inferScValType('amount', '500.0000000')).toBe('ScvI128');
    expect(inferScValType('assetCode', 'USDC')).toBe('ScvSymbol');

    const scVals = extractDecodedScVals(SAMPLE_SOROBAN_EVENTS[0]);
    expect(scVals.length).toBe(7);

    expect(isSorobanStreamEvent(SAMPLE_SOROBAN_EVENTS[0])).toBe(true);
    expect(isSorobanStreamEvent({ type: 'payment', contractId: 'C123' })).toBe(false);
    expect(isSorobanStreamEvent(null)).toBe(false);
  });
});
