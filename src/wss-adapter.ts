import { ServiceConnection } from './service-connection.js';
import type {
  ApiMethods,
  IServiceAdapter,
  IStreamingSubscriptionObserver,
  IStreamingUnsubscribe,
  IWssAdapter,
  ServiceName,
} from './types.js';
const wssAdapter: IWssAdapter = {
  services: {} as Record<ServiceName, IServiceAdapter> & { app: IServiceAdapter },
  sessions: {} as ApiMethods,
  configure() {},
  subscribeTo() {
    return () => {};
  },
  __store: { connections: {} },
};

const streamSubscribers = new Map<string, Map<number, IStreamingSubscriptionObserver<unknown>>>();
let streamSubscriberId = 1;

const normalizeStreamEvent = (event: string): string => event.trim();

const subscribeStreamEvent = (
  service: string,
  event: string,
  observer: IStreamingSubscriptionObserver<unknown>
): IStreamingUnsubscribe => {
  const normalized = normalizeStreamEvent(event);
  if (!normalized) {
    throw new Error('Stream event name is required');
  }

  const eventName = JSON.stringify([service, normalized]);
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
        console.error('[wss-adapter] Stream subscriber callback failed:', err);
      }
    }
  }
};

wssAdapter.configure = (configuration) => {
  streamSubscribers.clear();
  for (const connection of Object.values(wssAdapter.services)) connection.disconnect();
  for (const name of Object.keys(wssAdapter.services)) delete wssAdapter.services[name];
  for (const name of Object.keys(wssAdapter.sessions)) delete wssAdapter.sessions[name];
  for (const [name, config] of Object.entries(configuration.services)) {
    const connection = new ServiceConnection(name, config, configuration, (response, error) => {
      const keys = [JSON.stringify([name, String(response.method)])];
      const methodName = config.methods[String(response.method)]?.name;
      if (methodName) keys.push(JSON.stringify([name, normalizeStreamEvent(methodName)]));
      if (error) {
        notifyStreamSubscribers(keys, (observer) => observer.error?.(error));
      } else {
        const data =
          response.data !== undefined
            ? response.data
            : response.params !== undefined
              ? response.params
              : response;
        const payload = data && typeof data === 'object' && 'data' in data ? data.data : data;
        notifyStreamSubscribers(keys, (observer) => observer.next(payload));
      }
    });
    wssAdapter.services[name] = connection;
    wssAdapter.sessions[name] = new Proxy(
      {},
      {
        get: (_target, methodName: string) => (params?: Record<string, unknown>) =>
          connection.send(methodName, params),
      }
    );
  }
};

wssAdapter.subscribeTo = (event, observer, service = 'app') => {
  if (!Object.hasOwn(wssAdapter.services, service)) {
    throw new Error('Unknown stream service');
  }
  return subscribeStreamEvent(service, event, observer as IStreamingSubscriptionObserver<unknown>);
};
wssAdapter.__store.connections = wssAdapter.services;

export default wssAdapter;
