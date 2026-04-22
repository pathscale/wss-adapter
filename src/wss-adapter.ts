import type {
  ApiMethods,
  IServiceAdapter,
  IServiceConfig,
  IStreamingSubscriptionObserver,
  IStreamingUnsubscribe,
  IStore,
  IWssAdapter,
  ServiceName,
} from "./types.js";
const wssAdapter: IWssAdapter = {
  services: {} as Record<ServiceName, IServiceAdapter>,
  sessions: {} as ApiMethods,
  configure() {},
  subscribeTo() {
    return () => {};
  },
  __store: undefined as unknown as IStore,
};

const streamSubscribers = new Map<
  string,
  Map<number, IStreamingSubscriptionObserver<unknown>>
>();
let streamSubscriberId = 1;

const normalizeStreamEvent = (event: string): string => event.trim();

const subscribeStreamEvent = (
  event: string,
  observer: IStreamingSubscriptionObserver<unknown>
): IStreamingUnsubscribe => {
  const eventName = normalizeStreamEvent(event);
  if (!eventName) {
    throw new Error("Stream event name is required");
  }

  const id = streamSubscriberId++;
  const subscribers = streamSubscribers.get(eventName) ?? new Map();
  subscribers.set(id, observer);
  streamSubscribers.set(eventName, subscribers);

  return () => {
    const eventSubscribers = streamSubscribers.get(eventName);
    if (!eventSubscribers) return;
    eventSubscribers.delete(id);
    if (eventSubscribers.size === 0) {
      streamSubscribers.delete(eventName);
    }
  };
};

const notifyStreamSubscribers = (
  eventKeys: string[],
  notify: (observer: IStreamingSubscriptionObserver<unknown>) => void
) => {
  const seen = new Set<number>();

  for (const eventKey of eventKeys) {
    const subscribers = streamSubscribers.get(eventKey);
    if (!subscribers) continue;

    for (const [id, observer] of subscribers) {
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        notify(observer);
      } catch (err) {
        console.error("[wss-adapter] Stream subscriber callback failed:", err);
      }
    }
  }
};

const notifyStreamCompleteAll = () => {
  for (const subscribers of streamSubscribers.values()) {
    for (const observer of subscribers.values()) {
      try {
        observer.complete?.();
      } catch (err) {
        console.error("[wss-adapter] Stream complete callback failed:", err);
      }
    }
  }
};

const getStreamEventKeys = (method: unknown): string[] => {
  if (method == null) return [];

  const eventKeys = new Set<string>();
  const methodCode = String(method);
  eventKeys.add(methodCode);

  for (const serviceConfig of Object.values(store.services)) {
    const methodInfo = serviceConfig.methods?.[methodCode];
    if (methodInfo?.name) {
      eventKeys.add(methodInfo.name);
    }
  }

  return [...eventKeys];
};

const getStreamPayload = (response: any): unknown => {
  if (response?.data !== undefined) {
    if (response.data?.data !== undefined) {
      return response.data.data;
    }
    return response.data;
  }

  if (response?.params !== undefined) {
    return response.params;
  }

  return response;
};

const store: IStore = {
  timeout: 0,
  errors: {
    language: "en",
    codes: [],
  },
  services: {},
  subscriptions: {},
  sequence: {
    value: 1,
    getSeq() {
      store.sequence.value += 1;
      return store.sequence.value;
    },
    decreaseSeq() {
      store.sequence.value -= 1;
    },
  },
  sessions: {},
  pendingPromises: {},
};

/**
 * Reject all pending promises and clear their timeout handlers.
 * Called when a WebSocket connection closes (clean or unclean) and
 * when disconnectHandler is invoked, so no API call promise is ever
 * left hanging after the transport is gone.
 */
const rejectPendingPromises = (reason: string) => {
  for (const [seq, executor] of Object.entries(store.pendingPromises)) {
    clearTimeout(executor.toHandler);
    executor.reject(
      new Error(`${executor.methodName}: ${reason}`)
    );
    delete store.pendingPromises[Number(seq)];
  }
};

wssAdapter.configure = (configuration) => {
  const { timeout, services, errors, onError } = configuration;

  store.timeout = timeout;
  store.errors = errors;
  store.services = services;
  if (onError !== undefined) {
    store.onError = onError;
  }

  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    const serviceNameTyped = serviceName as ServiceName;

    wssAdapter.services[serviceNameTyped] = {
      connect: <T>(payload?: string | string[], remote?: string) =>
        connectHandler<T>(serviceName, serviceConfig, payload, remote),
      disconnect: () => disconnectHandler(serviceName),
      isOpen: () => store.sessions[serviceName]?.readyState === WebSocket.OPEN,
    };

    if (serviceConfig.subscriptions) {
      store.subscriptions[serviceName] = serviceConfig.subscriptions;
    }

    (wssAdapter.sessions as Record<string, unknown>)[serviceName] = new Proxy(
      {},
      {
        get:
          (_target, methodName: string) => (payload: Record<string, unknown>) =>
            sendHandler(serviceName, serviceConfig, methodName, payload),
      }
    );
  }
};

wssAdapter.subscribeTo = <TEvent>(
  event: string,
  observer: IStreamingSubscriptionObserver<TEvent>
): IStreamingUnsubscribe =>
  subscribeStreamEvent(
    event,
    observer as IStreamingSubscriptionObserver<unknown>
  );

const connectHandler = <T>(
  serviceName: string,
  serviceConfig: IServiceConfig,
  payload: string | string[] | undefined,
  remote?: string
) => {
  return new Promise((resolve, reject) => {
    if (!payload || !Array.isArray(payload)) {
      reject(new Error("WebSocket protocols required for authentication"));
      return;
    }

    const protocols = payload as string[];

    // Close the previous WebSocket (if any) so its onclose handler
    // does not fire later and tear down an already-rotated connection.
    const prev = store.sessions[serviceName];
    if (prev) {
      prev.onclose = null;
      prev.onerror = null;
      prev.onmessage = null;
      try {
        prev.close();
      } catch {
        // Ignore — may already be closed.
      }
    }

    const wsConnection = new WebSocket(
      remote || serviceConfig.remote,
      protocols
    );
    store.sessions[serviceName] = wsConnection;

    wsConnection.onmessage = (event: { data: string }) => {
      const response = JSON.parse(event.data);

      if (
        response.type === "Immediate" &&
        response.method === 20000 &&
        response.params?.accessToken
      ) {
        const session = store.sessions[serviceName];
        if (session) {
          session.onmessage = receiveHandler;
        }
        resolve(response.params);
        return;
      }

      if (response.type === "Error" || response.code) {
        const error = store.errors.codes.find((c) => c.code === response.code);
        const errorMsg = response.params || error?.message || response.code;

        if (store.onError) {
          store.onError(String(errorMsg));
        }

        reject(new Error(String(errorMsg)));
        return;
      }

      const session = store.sessions[serviceName];
      if (session) {
        session.onmessage = receiveHandler;
      }
      resolve(response.params);
    };

    wsConnection.onclose = (event) => {
      delete store.sessions[serviceName];

      // Reject every in-flight API call so callers never hang.
      rejectPendingPromises(
        `WebSocket closed (code ${event.code || "unknown"})`
      );

      notifyStreamCompleteAll();

      if (!event.wasClean) {
        reject(
          new Error(
            `WebSocket closed unexpectedly (code ${event.code || "unknown"})`
          )
        );
      }
      serviceConfig.onDisconnect?.(event);
    };

    wsConnection.onerror = (event) => {
      console.error("WebSocket error:", event);
      reject(new Error("WebSocket connection failed"));
    };
  }) as Promise<T>;
};

const disconnectHandler = (serviceName: string) => {
  const session = store.sessions[serviceName];
  if (session) {
    // Reject pending promises before closing so callers don't hang.
    rejectPendingPromises(
      `Service ${serviceName} disconnected`
    );
    session.close();
    delete store.sessions[serviceName];
  }
};

const sendHandler = (
  serviceName: string,
  serviceConfig: IServiceConfig,
  methodName: string,
  params: Record<string, unknown> = {}
) => {
  const methodEntry = Object.entries(serviceConfig.methods)
    .map(([code, info]) => ({ code, info }))
    .find(({ info }) => info.name === methodName);

  if (!methodEntry) {
    throw new Error(
      `method ${methodName} not available in ${serviceName} service`
    );
  }

  const methodCode = methodEntry.code;
  const methodInfo = serviceConfig.methods[methodCode];

  if (!methodInfo) {
    throw new Error(
      `method configuration missing for ${methodName} in ${serviceName} service`
    );
  }
  const paramsArray = methodInfo.parameters.map(
    (paramName) => params[paramName]
  );

  const payload = {
    method: Number.parseInt(methodCode),
    seq: store.sequence.getSeq(),
    params: paramsArray,
  };

  return new Promise((resolve, reject) => {
    const session = store.sessions[serviceName];
    if (!session) {
      reject(new Error(`No active session for service ${serviceName}`));
      return;
    }

    const doSend = () => {
      try {
        session.send(JSON.stringify(payload));
      } catch (err) {
        store.sequence.decreaseSeq();
        reject(err);
        return;
      }
      store.pendingPromises[payload.seq] = {
        resolve,
        reject,
        toHandler: setTimeout(() => {
          reject(new Error(`${methodName} took too long, aborting`));
        }, store.timeout) as unknown as number,
        methodName,
      };
    };

    if (session.readyState === WebSocket.OPEN) {
      doSend();
    } else if (session.readyState === WebSocket.CONNECTING) {
      const cleanup = () => {
        session.removeEventListener("open", onOpen);
        session.removeEventListener("error", onErr);
        session.removeEventListener("close", onClose);
      };
      const onOpen = () => { cleanup(); doSend(); };
      const onErr = () => {
        cleanup();
        store.sequence.decreaseSeq();
        reject(new Error(`WebSocket failed while waiting to send ${methodName}`));
      };
      const onClose = () => {
        cleanup();
        store.sequence.decreaseSeq();
        reject(new Error(`WebSocket closed while waiting to send ${methodName}`));
      };
      session.addEventListener("open", onOpen, { once: true });
      session.addEventListener("error", onErr, { once: true });
      session.addEventListener("close", onClose, { once: true });
    } else {
      store.sequence.decreaseSeq();
      reject(new Error(`WebSocket not open (readyState=${session.readyState}), cannot send ${methodName}`));
    }
  });
};

const receiveHandler = (event: { data: string }) => {
  const response = JSON.parse(event.data);

  if (
    response.type === "Immediate" ||
    (response.type === "Error" && response.method) ||
    response.method === 0
  ) {
    const error =
      response.code ||
      response.params?.success === false ||
      response.params?.error;

    const resolve = (payload: unknown) => {
      const executor = store.pendingPromises[response.seq];
      if (executor) {
        clearTimeout(executor.toHandler);
        delete store.pendingPromises[response.seq];
        executor.resolve(payload);
      }
    };

    if (error) {
      onError(response);
    } else {
      resolve(response);
    }
  } else if (response.type === "Stream") {
    console.log("Stream response:", response);

    const method = response.method;
    const subs = store.subscriptions;

    for (const [serviceName, callbacks] of Object.entries(subs)) {
      if (callbacks && typeof callbacks[method] === "function") {
        try {
          callbacks[method](response);
        } catch (err) {
          console.error(
            `[wss-adapter] Stream handler error in ${serviceName}:`,
            err
          );
        }
      }
    }

    const eventKeys = getStreamEventKeys(method);
    if (eventKeys.length > 0) {
      const payload = getStreamPayload(response);
      notifyStreamSubscribers(eventKeys, (observer) => {
        observer.next(payload);
      });
    }
  }
};

interface IResponse {
  code: number;
  seq: number;
  method?: number;
  params?: string | { reason?: string; error?: string };
  type?: string;
}

function onError(response: IResponse) {
  const error = store.errors.codes.find((c) => c.code === response.code);
  const params =
    typeof response.params === "object" && response.params !== null
      ? response.params
      : {};

  const errorMsg =
    params.reason || params.error || response.params || error?.message;

  const errorCode = response.code ?? "Error";

  let methodName = "";

  if (response.method) {
    for (const serviceConfig of Object.values(store.services)) {
      const methodKey = response.method.toString();
      const method = serviceConfig.methods[methodKey];
      if (method) {
        methodName = method.name;
        break;
      }
    }
  }

  const fullErrorMsg = methodName
    ? `[${errorCode}]: ${methodName}: ${errorMsg}`
    : String(errorMsg);

  if (store.onError) {
    store.onError(fullErrorMsg);
  }

  const executor = store.pendingPromises[response.seq];
  if (executor) {
    clearTimeout(executor.toHandler);
    executor.reject(
      new Error(`${executor.methodName || ""}: ${errorMsg}`, {
        cause: errorCode,
      })
    );
    delete store.pendingPromises[response.seq];
    return;
  }

  if (response.method != null) {
    const eventKeys = getStreamEventKeys(response.method);
    if (eventKeys.length > 0) {
      const streamError = new Error(fullErrorMsg);
      notifyStreamSubscribers(eventKeys, (observer) => {
        observer.error?.(streamError);
      });
      return;
    }
  }

  throw new Error("Unknown request failed");
}

wssAdapter.__store = store;

export default wssAdapter;
