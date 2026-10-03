import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { IServiceAdapter, IServiceConfig, ServiceStatus } from './types.js';
import wssAdapter from './wss-adapter.js';

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: { seq: number }[] = [];

  constructor(_url: string, _protocols: string[]) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  receive(response: unknown) {
    this.onmessage?.({ data: JSON.stringify(response) });
  }

  close(code = 1000, wasClean = true) {
    this.readyState = 3;
    const event = new CloseEvent('close', { code, wasClean });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}

const originalWebSocket = globalThis.WebSocket;
const services = wssAdapter.services as Record<string, IServiceAdapter>;
const sessions = wssAdapter.sessions as Record<string, Record<string, () => Promise<unknown>>>;

beforeEach(() => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.instances = [];
  wssAdapter.configure({
    timeout: 10000,
    errors: { language: 'en', codes: [] },
    services: {
      first: {
        remote: 'wss://first.example.com',
        methods: { '1': { name: 'read', parameters: [] } },
      },
      second: {
        remote: 'wss://second.example.com',
        methods: { '1': { name: 'read', parameters: [] } },
      },
    },
  });
});

afterEach(() => {
  services.first?.disconnect();
  services.second?.disconnect();
  globalThis.WebSocket = originalWebSocket;
});

async function connect(service: string) {
  const connected = services[service]!.connect(['test-protocol']);
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.receive({ type: 'Immediate', params: {} });
  await connected;
  return socket;
}

function configure(firstOptions: Partial<IServiceConfig> = {}) {
  wssAdapter.configure({
    timeout: 1000,
    errors: { language: 'en', codes: [] },
    services: {
      first: {
        remote: 'wss://first.example.com',
        methods: { '1': { name: 'read', parameters: [] } },
        ...firstOptions,
      },
      second: {
        remote: 'wss://second.example.com',
        methods: { '1': { name: 'read', parameters: [] } },
      },
    },
  });
}

function request(service: string) {
  return sessions[service]!.read!().then(
    (value) => ({ value }),
    (error: Error) => ({ error })
  );
}

describe('pending requests per service', () => {
  for (const wasClean of [true, false]) {
    it(`rejects only the closed service's calls (wasClean=${wasClean})`, async () => {
      const first = await connect('first');
      const second = await connect('second');
      const firstCalls = [request('first'), request('first')];
      const secondCalls = [request('second'), request('second')];
      let secondSettled = false;
      void Promise.all(secondCalls).then(() => {
        secondSettled = true;
      });

      first.close(1001, wasClean);
      for (const call of firstCalls) {
        expect(await call).toEqual({ error: new Error('read: WebSocket closed (code 1001)') });
      }
      expect(secondSettled).toBe(false);
      expect(services.second!.isOpen()).toBe(true);

      for (const { seq } of second.sent) {
        second.receive({ type: 'Immediate', seq, params: { success: true } });
      }
      for (const call of secondCalls) {
        expect(await call).toHaveProperty('value.params.success', true);
      }
    });
  }

  it('detaches the close handler on deliberate disconnect and preserves other calls', async () => {
    const first = await connect('first');
    const second = await connect('second');
    const firstCall = request('first');
    const secondCall = request('second');
    let secondSettled = false;
    void secondCall.then(() => {
      secondSettled = true;
    });

    services.first!.disconnect();
    expect(first.onclose).toBeNull();
    expect(await firstCall).toEqual({ error: new Error('read: Service first disconnected') });
    expect(secondSettled).toBe(false);
    const response = { type: 'Immediate', seq: second.sent[0]!.seq, params: {} };
    second.receive(response);
    expect(await secondCall).toEqual({ value: response });
  });

  it("routes success and error responses through the receiving service's pending table", async () => {
    const first = await connect('first');
    const second = await connect('second');
    const firstCall = request('first');
    const secondCall = request('second');
    const firstResponse = { type: 'Immediate', seq: first.sent[0]!.seq, params: {} };

    first.receive(firstResponse);
    second.receive({
      type: 'Error',
      method: 1,
      code: 400,
      seq: second.sent[0]!.seq,
      params: 'Request failed',
    });
    expect(await firstCall).toEqual({ value: firstResponse });
    expect(await secondCall).toHaveProperty('error.message', 'Request failed');
  });
});

describe('independent service connections', () => {
  it('owns independent sequences and never reuses a rejected sequence', async () => {
    const first = await connect('first');
    const second = await connect('second');
    const firstCall = request('first');
    const secondCall = request('second');
    expect(first.sent[0]!.seq).toBe(second.sent[0]!.seq);
    first.send = () => {
      throw new Error('Send failed');
    };
    expect(await request('first')).toHaveProperty('error.message', 'Send failed');
    first.send = FakeWebSocket.prototype.send;
    const nextCall = request('first');
    expect(first.sent[1]!.seq).toBe(first.sent[0]!.seq + 2);
    first.receive({ type: 'Immediate', seq: first.sent[0]!.seq });
    first.receive({ type: 'Immediate', seq: first.sent[1]!.seq });
    second.receive({ type: 'Immediate', seq: second.sent[0]!.seq });
    for (const call of [firstCall, secondCall, nextCall])
      expect(await call).toHaveProperty('value');
  });

  it('times out only its own calls and ignores late answers without replay', async () => {
    configure({ timeout: 15 });
    const first = await connect('first');
    const second = await connect('second');
    const firstCall = request('first');
    const secondCall = request('second');
    expect(await firstCall).toHaveProperty('error.message', 'read took too long, aborting');
    first.receive({ type: 'Error', method: 1, seq: first.sent[0]!.seq, code: 400 });
    const nextCall = request('first');
    first.receive({ type: 'Immediate', seq: first.sent[0]!.seq });
    first.receive({ type: 'Immediate', seq: first.sent[1]!.seq });
    second.receive({ type: 'Immediate', seq: second.sent[0]!.seq });
    expect(await nextCall).toHaveProperty('value.seq', first.sent[1]!.seq);
    expect(await secondCall).toHaveProperty('value');
    expect(first.sent).toHaveLength(2);
  });

  it('reconnects a flapping service while its peer keeps completing calls', async () => {
    configure({ reconnect: { initialDelay: 5, maxDelay: 10 } });
    let first = await connect('first');
    const second = await connect('second');
    const states: ServiceStatus[] = [];
    const unsubscribe = services.first!.subscribeStatus((status) => states.push(status));
    let lastSeq = 0;
    for (let flap = 0; flap < 3; flap++) {
      const firstCall = request('first');
      lastSeq = first.sent[0]!.seq;
      const staleMessage = first.onmessage!;
      first.close(1006, false);
      expect(await firstCall).toHaveProperty('error');
      const secondCall = request('second');
      second.receive({ type: 'Immediate', seq: second.sent.at(-1)!.seq });
      expect(await secondCall).toHaveProperty('value');
      expect(services.second!.status).toBe('connected');
      await Bun.sleep(15);
      first = FakeWebSocket.instances.at(-1)!;
      first.receive({ type: 'Immediate', params: {} });
      staleMessage({ data: JSON.stringify({ type: 'Error', seq: lastSeq, code: 400 }) });
      expect(services.first!.status).toBe('connected');
    }
    const finalCall = request('first');
    expect(first.sent[0]!.seq).toBeGreaterThan(lastSeq);
    first.receive({ type: 'Immediate', seq: first.sent[0]!.seq });
    expect(await finalCall).toHaveProperty('value');
    expect(states).toEqual([
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
    ]);
    unsubscribe();
    services.first!.disconnect();
    expect(states).toHaveLength(7);
  });

  it('backs off and goes down after exhausting consecutive reconnect attempts', async () => {
    configure({ reconnect: { initialDelay: 5, maxDelay: 10, maxAttempts: 2 } });
    const states: ServiceStatus[] = [];
    services.first!.subscribeStatus((status) => states.push(status));
    const first = await connect('first');
    first.close(1006, false);
    await Bun.sleep(8);
    const retry = FakeWebSocket.instances.at(-1)!;
    expect(FakeWebSocket.instances).toHaveLength(2);
    retry.onerror?.();
    await Bun.sleep(4);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await Bun.sleep(12);
    FakeWebSocket.instances.at(-1)!.close(1006, false);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(states).toEqual(['down', 'reconnecting', 'connected', 'reconnecting', 'down']);
  });

  it('cancels reconnect and detaches all handlers on deliberate disconnect', async () => {
    configure({ reconnect: { initialDelay: 5 } });
    const first = await connect('first');
    const second = await connect('second');
    const secondCall = request('second');
    first.close(1006, false);
    services.first!.disconnect();
    expect(services.first!.status).toBe('down');
    for (const handler of [first.onopen, first.onmessage, first.onclose, first.onerror])
      expect(handler).toBeNull();
    await Bun.sleep(15);
    expect(FakeWebSocket.instances).toHaveLength(2);
    second.receive({ type: 'Immediate', seq: second.sent[0]!.seq });
    expect(await secondCall).toHaveProperty('value');
  });

  it('rejects connecting calls and authentication when deliberately disconnected', async () => {
    const connecting = services.first!.connect(['test-protocol']).catch((error: Error) => error);
    const first = FakeWebSocket.instances.at(-1)!;
    first.readyState = FakeWebSocket.CONNECTING;
    const call = request('first');
    services.first!.disconnect();
    expect(await connecting).toHaveProperty('message', 'Service first disconnected');
    expect(await call).toHaveProperty('error.message', 'read: Service first disconnected');
    expect(first.sent).toHaveLength(0);
  });

  it('rejects authentication on clean close and can disable reconnection', async () => {
    configure({ reconnect: false });
    const connecting = services.first!.connect(['test-protocol']).catch((error: Error) => error);
    FakeWebSocket.instances.at(-1)!.close();
    expect(await connecting).toHaveProperty('message', 'WebSocket closed (code 1000)');
    expect(services.first!.status).toBe('down');
  });

  it('bounds authentication time without affecting another connected service', async () => {
    configure({ timeout: 15, reconnect: false });
    const second = await connect('second');
    const connecting = services.first!.connect(['test-protocol']).catch((error: Error) => error);
    const first = FakeWebSocket.instances.at(-1)!;
    const secondCall = request('second');
    expect(await connecting).toHaveProperty('message', 'WebSocket authentication took too long');
    expect(first.onmessage).toBeNull();
    expect(services.first!.status).toBe('down');
    second.receive({ type: 'Immediate', seq: second.sent[0]!.seq });
    expect(await secondCall).toHaveProperty('value');
  });

  it('sends queued calls once on open and registers pending before sending', async () => {
    const connected = services.first!.connect(['test-protocol']);
    const first = FakeWebSocket.instances.at(-1)!;
    first.readyState = FakeWebSocket.CONNECTING;
    const call = request('first');
    expect(first.sent).toHaveLength(0);
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    first.onopen?.();
    expect(first.sent).toHaveLength(1);
    first.receive({ type: 'Immediate', params: {} });
    await connected;
    first.receive({ type: 'Immediate', seq: first.sent[0]!.seq });
    expect(await call).toHaveProperty('value');
    first.send = (data) => first.receive({ type: 'Immediate', seq: JSON.parse(data).seq });
    expect(await request('first')).toHaveProperty('value');
  });

  it('replaces a connection without letting its stale handlers affect the replacement', async () => {
    const first = await connect('first');
    const firstCall = request('first');
    const staleClose = first.onclose!;
    const staleMessage = first.onmessage!;
    const replacement = await connect('first');
    expect(await firstCall).toHaveProperty('error.message', 'read: Service first disconnected');
    const nextCall = request('first');
    staleClose(new CloseEvent('close', { code: 1006 }));
    staleMessage({ data: JSON.stringify({ type: 'Immediate', seq: replacement.sent[0]!.seq }) });
    expect(services.first!.status).toBe('connected');
    replacement.receive({ type: 'Immediate', seq: replacement.sent[0]!.seq });
    expect(await nextCall).toHaveProperty('value');
  });

  it('allows a status observer to cancel connecting before a socket is created', async () => {
    const unsubscribe = services.first!.subscribeStatus((status) => {
      if (status === 'reconnecting') services.first!.disconnect();
    });
    const connected = services.first!.connect(['test-protocol']).catch((error: Error) => error);
    expect(await connected).toHaveProperty('message', 'Service first disconnected');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(services.first!.status).toBe('down');
    unsubscribe();
  });

  it('keeps configure, connect result, method proxies and stream facade compatible', async () => {
    const received: unknown[] = [];
    const callbacks: unknown[] = [];
    configure({ subscriptions: { '1': (response) => callbacks.push(response) } });
    const unsubscribe = wssAdapter.subscribeTo('read', { next: (data) => received.push(data) });
    const connected = services.first!.connect(['test-protocol']);
    const first = FakeWebSocket.instances.at(-1)!;
    first.receive({ type: 'Immediate', method: 20000, params: { accessToken: 'test-session' } });
    expect(await connected).toEqual({ accessToken: 'test-session' });
    expect(services.first!.name).toBe('first');
    const second = await connect('second');
    second.receive({ type: 'Stream', method: 1, params: { value: 1 } });
    expect(callbacks).toHaveLength(0);
    first.receive({ type: 'Stream', method: 1, data: { data: { value: 2 } } });
    expect(callbacks).toHaveLength(1);
    expect(received).toEqual([{ value: 1 }, { value: 2 }]);
    unsubscribe();
    wssAdapter.configure({ timeout: 1000, errors: { language: 'en', codes: [] }, services: {} });
    expect(Object.keys(wssAdapter.services)).toHaveLength(0);
    expect(Object.keys(wssAdapter.sessions)).toHaveLength(0);
    expect(first.onmessage).toBeNull();
  });
});
