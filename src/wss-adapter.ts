import type {
  ApiMethods,
  IServiceAdapter,
  IServiceConfig,
  IStore,
  IWssAdapter,
  ServiceName,
} from './types.js';
const wssAdapter: IWssAdapter = {
  services: {} as Record<ServiceName, IServiceAdapter>,
  sessions: {} as ApiMethods,
  configure() {},
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
    };

    if (serviceConfig.subscriptions) {
      store.subscriptions[serviceName] = serviceConfig.subscriptions;
    }

    (wssAdapter.sessions as any)[serviceName] = new Proxy(
      {},
      {
        get:
          (_target, methodName: string) => (payload: Record<string, unknown>) =>
            sendHandler(serviceName, serviceConfig, methodName, payload),
      },
    );
  }
};

const connectHandler = <T>(
  serviceName: string,
  serviceConfig: IServiceConfig,
  payload: string | string[] | undefined,
  remote?: string,
) => {
  return new Promise((resolve, reject) => {
    if (!payload || !Array.isArray(payload)) {
      reject(new Error("WebSocket protocols required for authentication"));
      return;
    }

    const protocols = payload as string[];

    const wsConnection = new WebSocket(
      remote || serviceConfig.remote,
      protocols,
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
      if (!event.wasClean) {
        reject(
          new Error(
            `WebSocket closed unexpectedly (code ${event.code || "unknown"})`,
          ),
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
    session.close();
  }
};

const sendHandler = (
  serviceName: string,
  serviceConfig: IServiceConfig,
  methodName: string,
  params: Record<string, unknown> = {},
) => {
  const methodEntry = Object.entries(serviceConfig.methods)
    .map(([code, info]) => ({ code, info }))
    .find(({ info }) => info.name === methodName);

  if (!methodEntry) {
    throw new Error(
      `method ${methodName} not available in ${serviceName} service`,
    );
  }

  const methodCode = methodEntry.code;
  const methodInfo = serviceConfig.methods[methodCode];

  if (!methodInfo) {
    throw new Error(
      `method configuration missing for ${methodName} in ${serviceName} service`,
    );
  }
  const paramsArray = methodInfo.parameters.map(
    (paramName) => params[paramName],
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

    session.send(JSON.stringify(payload));

    store.pendingPromises[payload.seq] = {
      resolve,
      reject,
      toHandler: setTimeout(() => {
        reject(new Error(`${methodName} took too long, aborting`));
      }, store.timeout) as any,
      methodName,
    };
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
    params.reason ||
    params.error ||
    response.params ||
    error?.message ||
    response.code;

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
    ? `${methodName}: ${errorMsg}`
    : String(errorMsg);

  if (store.onError) {
    store.onError(fullErrorMsg);
  }

  const executor = store.pendingPromises[response.seq];
  if (executor) {
    clearTimeout(executor.toHandler);
    executor.reject(new Error(`${executor.methodName || ""}: ${errorMsg}`));
    delete store.pendingPromises[response.seq];
  } else {
    throw new Error("Unknown request failed");
  }
}

export default wssAdapter;