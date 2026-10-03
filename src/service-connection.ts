import { buildServiceError } from './errors.js';
import type { IConfiguration, IServiceAdapter, IServiceConfig, ServiceStatus } from './types.js';

interface Response {
  type?: string;
  method?: number;
  seq?: number;
  code?: number;
  params?: any;
  data?: any;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  methodName: string;
  payload: string;
  sent: boolean;
}

/** One transport lifecycle and request namespace for one configured service. */
export class ServiceConnection implements IServiceAdapter {
  private socket: WebSocket | undefined;
  private sequence = 1;
  private pending = new Map<number, PendingCall>();
  private observers = new Set<(status: ServiceStatus) => void>();
  private currentStatus: ServiceStatus = 'down';
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private generation = 0;
  private protocols: string[] = [];
  private remote = '';
  private cancelConnect: ((reason: Error) => void) | undefined;
  private readonly timeout: number;
  private readonly reconnect:
    | false
    | { initialDelay: number; maxDelay: number; maxAttempts: number };

  constructor(
    readonly name: string,
    private readonly config: IServiceConfig,
    private readonly configuration: IConfiguration,
    private readonly onStream: (response: Response, error?: Error) => void
  ) {
    this.timeout = config.timeout ?? configuration.timeout;
    this.reconnect =
      config.reconnect === false
        ? false
        : {
            initialDelay: config.reconnect?.initialDelay ?? 1000,
            maxDelay: config.reconnect?.maxDelay ?? 30000,
            maxAttempts: config.reconnect?.maxAttempts ?? 5,
          };
  }

  get status(): ServiceStatus {
    return this.currentStatus;
  }

  subscribeStatus = (observer: (status: ServiceStatus) => void): (() => void) => {
    this.observers.add(observer);
    this.notify(observer);
    return () => {
      this.observers.delete(observer);
    };
  };

  private notify(observer: (status: ServiceStatus) => void) {
    try {
      observer(this.status);
    } catch {
      console.error('[wss-adapter] Status callback failed');
    }
  }

  private setStatus(status: ServiceStatus) {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const observer of this.observers) this.notify(observer);
  }

  isOpen = (): boolean => this.socket?.readyState === WebSocket.OPEN;

  connect = <T>(payload?: string | string[], remote?: string): Promise<T> => {
    if (!Array.isArray(payload)) {
      return Promise.reject(new Error('WebSocket protocols required for authentication'));
    }
    this.disconnect();
    this.protocols = [...payload];
    this.remote = remote || this.config.remote;
    this.attempts = 0;
    return new Promise<T>((resolve, reject) => {
      this.cancelConnect = reject;
      const generation = this.generation;
      this.setStatus('reconnecting');
      if (this.generation === generation) this.open((value) => resolve(value as T));
    });
  };

  private detachSocket() {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* Already closed. */
    }
  }

  disconnect = (): void => {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.detachSocket();
    const reason = new Error(`Service ${this.name} disconnected`);
    this.cancelConnect?.(reason);
    this.cancelConnect = undefined;
    this.rejectPending(reason.message);
    this.setStatus('down');
  };

  private rejectPending(reason: string) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`${call.methodName}: ${reason}`));
    }
    this.pending.clear();
  }

  private failed(reason: Error, event?: CloseEvent) {
    this.detachSocket();
    this.cancelConnect?.(reason);
    this.cancelConnect = undefined;
    this.rejectPending(reason.message);
    const reconnect = this.reconnect;
    if (reconnect && this.attempts < reconnect.maxAttempts) {
      const delay = Math.min(reconnect.initialDelay * 2 ** this.attempts++, reconnect.maxDelay);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.open();
      }, delay);
      this.setStatus('reconnecting');
    } else {
      this.setStatus('down');
    }
    if (event) {
      try {
        this.config.onDisconnect?.(event);
      } catch {
        console.error('[wss-adapter] Disconnect callback failed');
      }
    }
  }

  private open(resolve?: (value: unknown) => void) {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.remote, this.protocols);
    } catch {
      this.failed(new Error('WebSocket connection failed'));
      return;
    }
    this.socket = socket;
    let authenticated = false;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket) this.failed(new Error('WebSocket authentication took too long'));
    }, this.timeout);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      for (const [seq, call] of this.pending) this.sendCall(seq, call);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let response: Response;
      try {
        response = JSON.parse(event.data);
        if (!response || typeof response !== 'object' || Array.isArray(response))
          throw new Error('Invalid response');
      } catch {
        this.failed(new Error('Invalid WebSocket response'));
        return;
      }
      if (!authenticated) {
        if (response.type === 'Error' || response.code) {
          this.failed(this.serviceError(response));
          return;
        }
        authenticated = true;
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.attempts = 0;
        this.cancelConnect = undefined;
        this.setStatus('connected');
        resolve?.(response.params);
        return;
      }
      this.receive(response);
    };
    socket.onclose = (event) => {
      if (this.socket === socket)
        this.failed(new Error(`WebSocket closed (code ${event.code || 'unknown'})`), event);
    };
    socket.onerror = () => {
      if (this.socket === socket) this.failed(new Error('WebSocket connection failed'));
    };
  }

  send(methodName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const entry = Object.entries(this.config.methods).find(([, info]) => info.name === methodName);
    if (!entry) throw new Error(`method ${methodName} not available in ${this.name} service`);
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      return Promise.reject(new Error(`No active session for service ${this.name}`));
    }
    const [code, info] = entry;
    const seq = ++this.sequence;
    const payload = JSON.stringify({
      method: Number.parseInt(code),
      seq,
      params: info.parameters.map((name) => params[name]),
    });
    return new Promise((resolve, reject) => {
      const call: PendingCall = {
        resolve,
        reject,
        methodName,
        payload,
        sent: false,
        timer: setTimeout(() => {
          this.pending.delete(seq);
          reject(new Error(`${methodName} took too long, aborting`));
        }, this.timeout),
      };
      this.pending.set(seq, call);
      if (this.isOpen()) this.sendCall(seq, call);
    });
  }

  private sendCall(seq: number, call: PendingCall) {
    if (call.sent) return;
    call.sent = true;
    try {
      this.socket!.send(call.payload);
    } catch (error) {
      clearTimeout(call.timer);
      this.pending.delete(seq);
      call.reject(error);
    }
  }

  private serviceError(response: Response): Error {
    const methodName = this.config.methods[String(response.method)]?.name;
    const catalogMessage = this.configuration.errors.codes.find(
      (entry) => entry.code === response.code
    )?.message;
    const error = buildServiceError(response, { methodName, catalogMessage });
    try {
      this.configuration.onError?.(
        methodName
          ? `[${response.code ?? 'Error'}]: ${methodName}: ${error.message}`
          : error.message
      );
    } catch {
      console.error('[wss-adapter] Error callback failed');
    }
    return error;
  }

  private receive(response: Response) {
    if (response.type === 'Stream') {
      try {
        this.config.subscriptions?.[String(response.method)]?.(response);
      } catch {
        console.error('[wss-adapter] Stream callback failed');
      }
      this.onStream(response);
      return;
    }
    const call = response.seq === undefined ? undefined : this.pending.get(response.seq);
    const failed =
      response.type === 'Error' ||
      response.code ||
      response.params?.success === false ||
      response.params?.error;
    if (!call) {
      // Late replies cannot settle rejected promises. Never replay a request automatically.
      if (response.seq === undefined && failed && response.method !== undefined)
        this.onStream(response, this.serviceError(response));
      return;
    }
    clearTimeout(call.timer);
    this.pending.delete(response.seq!);
    if (failed) call.reject(this.serviceError(response));
    else call.resolve(response);
  }
}
